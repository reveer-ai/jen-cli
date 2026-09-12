/**
 * The container driver, against a real container runtime.
 *
 * Nothing here is mocked. A driver whose only job is to drive another program proves
 * nothing against a stub of that program: every property this change claims — that a
 * workspace outlives its sandbox, that two sandboxes cannot see each other, that a
 * half-created sandbox leaves nothing behind, that cycling leaks nothing — is a property
 * of what the runtime actually did. The one seam that is wrapped rather than replaced is
 * the spawner, and it is wrapped around the real one, to record the argv that really ran.
 *
 * **These tests need a running container runtime, and nothing in CI runs them.** See
 * `agent/AGENTS.md`. The first run pulls two small images.
 *
 * Everything created is labelled with this file's own run id, so the sweep at the end
 * reaches exactly what these tests made and nothing a person left on the machine.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DockerSandboxDriver, resolveFromEnvironment, spawner, type Spawner } from './docker.js';
import { SandboxError } from './index.js';

import type { Readable } from 'node:stream';
import type { AgentRecord, Sandbox } from './index.js';

const run = promisify(execFile);

/** Scopes every label, every agent id, and the sweep, to this run of this file. */
const RUN = `jen-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Small, public, and carrying the `sh` and `sleep` a sandbox idles on. */
const IMAGE = 'busybox:stable';

/** Small, public, and carrying no shell at all — so a sandbox is created and cannot start. */
const UNSTARTABLE = 'hello-world:latest';

/** A path that exists on this machine and in no sandbox. */
const ON_THE_MACHINE = join(import.meta.dirname, '..', '..', 'package.json');

let agents = 0;

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: `${RUN}-agent-${++agents}`,
    environment: IMAGE,
    workspace: '/workspace',
    credentials: [],
    ...overrides,
  };
}

function driver(options: Partial<ConstructorParameters<typeof DockerSandboxDriver>[0]> = {}) {
  return new DockerSandboxDriver({ run: RUN, ...options });
}

async function text(stream: Readable): Promise<string> {
  let collected = '';
  for await (const chunk of stream) collected += String(chunk);
  return collected;
}

/** Run a command in a sandbox and wait for all of it. */
async function inside(sandbox: Sandbox, command: string[]): Promise<{ out: string; err: string; code: number | null }> {
  const started = await sandbox.exec(command);
  const [out, err, exit] = await Promise.all([text(started.stdout), text(started.stderr), started.exit]);
  return { out: out.trim(), err: err.trim(), code: exit.code };
}

/** `docker`, for the test's own questions. Returns the exit code alongside the output. */
async function ask(...args: string[]): Promise<{ out: string; code: number }> {
  try {
    const { stdout } = await run('docker', args);
    return { out: stdout.trim(), code: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { out: (failure.stdout ?? '').trim(), code: failure.code ?? 1 };
  }
}

async function lines(...args: string[]): Promise<string[]> {
  const { out } = await ask(...args);
  return out.split('\n').filter((line) => line !== '');
}

/** Everything this run has left on the machine, by label. */
async function outstanding(): Promise<{ containers: number; workspaces: number }> {
  return {
    containers: (await lines('ps', '-a', '--filter', `label=jen.run=${RUN}`, '--format', '{{.ID}}')).length,
    workspaces: (await lines('volume', 'ls', '--filter', `label=jen.run=${RUN}`, '--format', '{{.Name}}')).length,
  };
}

/** Subprocesses of this one that have not been reaped. */
async function descendants(): Promise<number> {
  const { stdout } = await run('ps', ['-ax', '-o', 'pid=,ppid=']);
  return stdout.split('\n').filter((line) => line.trim().split(/\s+/)[1] === String(process.pid)).length;
}

/** Open file descriptors of this process. `/dev/fd` is `/proc/self/fd` on Linux. */
function descriptors(): number {
  return readdirSync('/dev/fd').length;
}

beforeAll(async () => {
  const reachable = await ask('version', '--format', '{{.Server.Version}}');
  if (reachable.code !== 0) {
    throw new Error('these tests need a running container runtime, and none is reachable. See agent/AGENTS.md.');
  }
  // Pulled here rather than mid-test, so a slow first run is not mistaken for a hang and a
  // registry failure names itself instead of arriving as a creation error.
  await run('docker', ['pull', IMAGE], { timeout: 240_000 });
  await run('docker', ['pull', UNSTARTABLE], { timeout: 240_000 });
}, 600_000);

afterAll(async () => {
  for (const id of await lines('ps', '-aq', '--filter', `label=jen.run=${RUN}`)) {
    await ask('rm', '--force', id);
  }
  for (const name of await lines('volume', 'ls', '-q', '--filter', `label=jen.run=${RUN}`)) {
    await ask('volume', 'rm', '--force', name);
  }
});

describe('a sandbox is created and destroyed', () => {
  it('creates an isolated environment and returns a handle to it', async () => {
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    const names = await lines('ps', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}');
    expect(names).toHaveLength(1);
    expect(await inside(sandbox, ['sh', '-c', 'echo alive'])).toMatchObject({ out: 'alive', code: 0 });

    await sandbox.destroy();
    expect(await lines('ps', '-a', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}')).toEqual([]);

    await subject.releaseWorkspace(agent.id);
  });

  it('is created the same way for an agent no other agent spawned', async () => {
    // The record carries nothing about a parent or a depth — `index.test.ts` holds that by
    // reading the declarations — so there is no second path for this to take. What is
    // demonstrated here is that the root's sandbox is as usable as any other's.
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    expect(await inside(sandbox, ['sh', '-c', 'echo rooted'])).toMatchObject({ out: 'rooted', code: 0 });

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });
});

describe('the workspace outlives the sandbox', () => {
  it('keeps a file across destruction, and reclaims it on release', async () => {
    const subject = driver();
    const agent = record();

    const first = await subject.create(agent);
    expect((await inside(first, ['sh', '-c', 'echo kept > /workspace/note'])).code).toBe(0);
    await first.destroy();

    const second = await subject.create(agent);
    expect(await inside(second, ['cat', '/workspace/note'])).toMatchObject({ out: 'kept', code: 0 });
    await second.destroy();

    const workspace = (
      await lines('volume', 'ls', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Name}}')
    )[0];
    expect(workspace).toBeDefined();

    await subject.releaseWorkspace(agent.id);
    expect((await ask('volume', 'inspect', workspace ?? '')).code).not.toBe(0);
  });
});

describe('a sandbox is isolated', () => {
  it('cannot see another sandbox’s workspace, or this machine’s files', async () => {
    const subject = driver();
    const [one, two] = [record(), record()];
    const first = await subject.create(one);
    const second = await subject.create(two);

    expect((await inside(first, ['sh', '-c', 'echo private > /workspace/secret-note'])).code).toBe(0);
    expect((await inside(second, ['test', '-e', '/workspace/secret-note'])).code).not.toBe(0);

    for (const sandbox of [first, second]) {
      expect((await inside(sandbox, ['test', '-e', ON_THE_MACHINE])).code).not.toBe(0);
    }

    await first.destroy();
    await second.destroy();
    await subject.releaseWorkspace(one.id);
    await subject.releaseWorkspace(two.id);
  });

  it('mounts no directory of this machine’s, and never the runtime’s socket', async () => {
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    const name = (await lines('ps', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}'))[0] ?? '';
    const mounts = JSON.parse((await ask('inspect', '--format', '{{json .Mounts}}', name)).out) as {
      Type: string;
      Name?: string;
      Destination: string;
    }[];

    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.Type).toBe('volume');
    expect(mounts[0]?.Destination).toBe('/workspace');
    expect(mounts.some((mount) => mount.Type === 'bind')).toBe(false);

    for (const socket of ['/var/run/docker.sock', '/run/docker.sock', '/var/run/podman/podman.sock']) {
      expect((await inside(sandbox, ['test', '-e', socket])).code).not.toBe(0);
    }

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });
});

describe('credentials reach the sandbox and nothing else', () => {
  const SECRET = 'sentinel-e3f1a9c7-not-a-real-key';

  it('resolves a reference into the environment, leaving the record holding the reference', async () => {
    const agent = record({ credentials: [{ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' }] });
    const subject = driver({
      env: { ...process.env, JEN_TEST_TOKEN: SECRET },
      resolve: resolveFromEnvironment({ ...process.env, JEN_TEST_TOKEN: SECRET }),
    });
    const sandbox = await subject.create(agent);

    expect(await inside(sandbox, ['sh', '-c', 'printf %s "$AGENT_TOKEN"'])).toMatchObject({ out: SECRET, code: 0 });
    expect(agent.credentials[0]).toEqual({ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' });

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });

  it('puts the secret on no command line, and passes the runtime no environment at all', async () => {
    // Recorded off the real spawner rather than a stub, because the requirement is about
    // the argv that was actually passed. `--env NAME=value` is the spelling this exists to
    // keep out: it would pass every behavioural test above and disclose the secret to every
    // process on the machine for the life of the call.
    //
    // `--env NAME` is now forbidden here too, and that is the correction this test carries.
    // It does keep the secret out of argv, and it fails the requirement anyway, because the
    // runtime writes what it is told into the container's own record — see the test below.
    // So the assertion is no longer "the safe spelling was used" but "no environment was
    // handed over at all", which is the only form of it a later change cannot creep past.
    const argvs: string[][] = [];
    const recording: Spawner = (command, args, env, input) => {
      argvs.push([command, ...args]);
      return spawner(command, args, env, input);
    };

    const agent = record({ credentials: [{ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' }] });
    const subject = driver({
      env: { ...process.env, JEN_TEST_TOKEN: SECRET },
      resolve: resolveFromEnvironment({ ...process.env, JEN_TEST_TOKEN: SECRET }),
      spawn: recording,
    });
    const sandbox = await subject.create(agent);

    // Exercised, not merely created: the argv that delivers the credential is the one this
    // is really about, and it only exists once a process has been started.
    expect(await inside(sandbox, ['sh', '-c', 'printf %s "$AGENT_TOKEN"'])).toMatchObject({ out: SECRET, code: 0 });

    const creation = argvs.find((argv) => argv.includes('run'));
    expect(creation).toBeDefined();
    expect(creation?.some((argument) => argument === '--env' || argument === '-e')).toBe(false);
    expect(creation).not.toContain('AGENT_TOKEN');

    expect(argvs.flat().join('\n')).not.toContain(SECRET);
    expect(argvs.flat().some((argument) => argument.startsWith('--env'))).toBe(false);

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });

  it('puts the secret in no record the runtime keeps', async () => {
    // The regression this change exists for. The previous delivery kept the secret out of
    // every argv and the runtime resolved it into the container's configuration anyway,
    // where `inspect` returned it in full for as long as the container lived. A source-level
    // check for file writes cannot see that, because the write is the runtime's and not
    // this driver's — so the assertion has to be made against the runtime's own record.
    const agent = record({ credentials: [{ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' }] });
    const subject = driver({
      env: { ...process.env, JEN_TEST_TOKEN: SECRET },
      resolve: resolveFromEnvironment({ ...process.env, JEN_TEST_TOKEN: SECRET }),
    });
    const sandbox = await subject.create(agent);
    const name = (await lines('ps', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}'))[0] ?? '';

    const configured = JSON.parse((await ask('inspect', '--format', '{{json .Config.Env}}', name)).out) as string[];
    expect(configured.some((entry) => entry.startsWith('AGENT_TOKEN'))).toBe(false);
    expect((await ask('inspect', name)).out).not.toContain(SECRET);

    // Nor is it in the environment of the process the sandbox idles on, which is the other
    // thing the old delivery put it in and which anything running here could have read.
    const idle = await inside(sandbox, ['sh', '-c', "tr '\\0' '\\n' < /proc/1/environ"]);
    expect(idle.out).not.toContain(SECRET);

    // And none of that changes once a process has actually been given the credential.
    expect(await inside(sandbox, ['sh', '-c', 'printf %s "$AGENT_TOKEN"'])).toMatchObject({ out: SECRET, code: 0 });
    expect((await ask('inspect', name)).out).not.toContain(SECRET);

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });

  it('delivers a value the line protocol has to carry carefully, and refuses one it cannot', async () => {
    // Delivery is a line of text read by a shell, so the two things that could go wrong are
    // a value that needs quoting arriving mangled, and a value carrying a newline arriving
    // truncated. The first is tested because it must work; the second is refused, because a
    // half-delivered secret arrives looking like a secret.
    const awkward = `${SECRET} with spaces\t$NOT_EXPANDED "quoted" 'single' \\backslash`;
    const agent = record({ credentials: [{ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' }] });
    const subject = driver({
      env: { ...process.env, JEN_TEST_TOKEN: awkward },
      resolve: resolveFromEnvironment({ ...process.env, JEN_TEST_TOKEN: awkward }),
    });
    const sandbox = await subject.create(agent);

    expect(await inside(sandbox, ['sh', '-c', 'printf %s "$AGENT_TOKEN"'])).toMatchObject({ out: awkward, code: 0 });

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);

    const multiline = `first-line\n${SECRET}`;
    const refusing = driver({
      env: { ...process.env, JEN_TEST_TOKEN: multiline },
      resolve: resolveFromEnvironment({ ...process.env, JEN_TEST_TOKEN: multiline }),
    });
    const second = record({ credentials: [{ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' }] });

    const failure = await refusing.create(second).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxError);
    expect((failure as SandboxError).message).toContain('AGENT_TOKEN');
    expect((failure as SandboxError).message).not.toContain(SECRET);

    // And it fails the creation rather than the process, so nothing is left provisioned.
    expect(await lines('ps', '-a', '--filter', `label=jen.agent=${second.id}`, '--format', '{{.Names}}')).toEqual([]);
    expect(await lines('volume', 'ls', '--filter', `label=jen.agent=${second.id}`, '--format', '{{.Name}}')).toEqual([]);
  });

  it('writes no file at all, which is what keeps the secret off disk', () => {
    // A source-level guard, because a write added later is invisible to every behavioural
    // test that did not happen to look for the file it wrote. The requirement is held by
    // the driver having no way to write one.
    const source = readFileSync(join(import.meta.dirname, 'docker.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .*?from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).not.toContain('node:fs');
    expect(imports).not.toContain('node:fs/promises');

    // The prose has to stay free to name the two spellings this forbids — an explanation
    // of why `--env-file` is never passed is the thing most likely to stop someone passing
    // it — so the code is read without it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/writeFile|appendFile|createWriteStream|mkdtemp|env-file/);
  });

  it('leaves the secret readable nowhere once the sandbox is destroyed', async () => {
    const agent = record({ credentials: [{ name: 'AGENT_TOKEN', ref: 'env:JEN_TEST_TOKEN' }] });
    const subject = driver({
      env: { ...process.env, JEN_TEST_TOKEN: SECRET },
      resolve: resolveFromEnvironment({ ...process.env, JEN_TEST_TOKEN: SECRET }),
    });

    const sandbox = await subject.create(agent);
    const name = (await lines('ps', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}'))[0] ?? '';
    await sandbox.destroy();

    // The sandbox held the only copy, so it went with it.
    expect((await ask('inspect', name)).code).not.toBe(0);

    // And the one thing that survived — the workspace — never had it.
    const after = await subject.create(record({ id: agent.id }));
    const swept = await inside(after, ['sh', '-c', `grep -rl ${SECRET} /workspace 2>/dev/null; printf done`]);
    expect(swept.out).toBe('done');
    expect(await inside(after, ['sh', '-c', 'printf %s "${AGENT_TOKEN-unset}"'])).toMatchObject({ out: 'unset' });

    await after.destroy();
    await subject.releaseWorkspace(agent.id);
  });
});

describe('the failure modes are defined', () => {
  it('reports a creation that fails partway, and leaves nothing it created', async () => {
    const subject = driver();
    const agent = record({ environment: `jen-no-such-image-${RUN}:1` });

    await expect(subject.create(agent)).rejects.toBeInstanceOf(SandboxError);

    expect(await lines('ps', '-a', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}')).toEqual([]);
    expect(await lines('volume', 'ls', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Name}}')).toEqual([]);
  });

  it('removes a sandbox that was created but could not start', async () => {
    // `hello-world` carries no shell, so the runtime creates the sandbox and then fails to
    // start it — the one failure that really does leave a remnant behind to be unwound.
    const subject = driver();
    const agent = record({ environment: UNSTARTABLE });

    await expect(subject.create(agent)).rejects.toBeInstanceOf(SandboxError);

    expect(await lines('ps', '-a', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}')).toEqual([]);
    expect(await lines('volume', 'ls', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Name}}')).toEqual([]);
  });

  it('keeps a workspace it did not create when creation fails', async () => {
    // The case the unwind exists to get right. A resuming agent's workspace already holds
    // its work, and a transient failure must not be what destroys it.
    const subject = driver();
    const agent = record();

    const first = await subject.create(agent);
    expect((await inside(first, ['sh', '-c', 'echo earlier > /workspace/work'])).code).toBe(0);
    await first.destroy();

    await expect(subject.create({ ...agent, environment: `jen-no-such-image-${RUN}:1` })).rejects.toBeInstanceOf(
      SandboxError,
    );

    const resumed = await subject.create(agent);
    expect(await inside(resumed, ['cat', '/workspace/work'])).toMatchObject({ out: 'earlier', code: 0 });

    await resumed.destroy();
    await subject.releaseWorkspace(agent.id);
  });

  it('succeeds when destroying a sandbox that is already gone', async () => {
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    await sandbox.destroy();
    await expect(sandbox.destroy()).resolves.toBeUndefined();

    await subject.releaseWorkspace(agent.id);
    await expect(subject.releaseWorkspace(agent.id)).resolves.toBeUndefined();
  });

  it('stops a sandbox whose process is still running', async () => {
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    const working = await sandbox.exec(['sh', '-c', 'while :; do sleep 1; done']);
    const drained = Promise.all([text(working.stdout), text(working.stderr)]);

    await sandbox.destroy();

    expect((await working.exit).code === 0).toBe(false);
    await drained;
    expect(await lines('ps', '-a', '--filter', `label=jen.agent=${agent.id}`, '--format', '{{.Names}}')).toEqual([]);

    await subject.releaseWorkspace(agent.id);
  });

  it('fails with the cause named when the runtime is unreachable', async () => {
    const subject = driver({ env: { ...process.env, DOCKER_HOST: 'unix:///jen/nowhere/runtime.sock' } });

    await expect(subject.create(record())).rejects.toThrow(/nowhere\/runtime\.sock/);
  });

  it('fails with the cause named when the runtime is absent', async () => {
    const subject = driver({ docker: '/jen/nowhere/docker' });

    await expect(subject.create(record())).rejects.toThrow(/\/jen\/nowhere\/docker/);
  });
});

describe('repetition accumulates nothing', () => {
  // Thirty, because a leak of one resource per cycle is unmistakable by then and the run
  // still finishes in a minute or so. The assertions are against counts taken before and
  // after rather than against a fixed number, so nothing else on the machine can decide
  // whether this passes.
  it('cycles create/destroy without leaving containers, workspaces, processes or descriptors', async () => {
    const subject = driver();

    const before = { ...(await outstanding()), children: await descendants(), fds: descriptors() };

    for (let cycle = 0; cycle < 30; cycle++) {
      const agent = record();
      const sandbox = await subject.create(agent);
      await sandbox.destroy();
      await subject.releaseWorkspace(agent.id);
    }

    const after = { ...(await outstanding()), children: await descendants(), fds: descriptors() };

    expect(after.containers).toBe(before.containers);
    expect(after.workspaces).toBe(before.workspaces);
    expect(after.children).toBeLessThanOrEqual(before.children);
    // A small allowance for the runtime's own churn, far below the thirty a per-cycle leak
    // would have produced.
    expect(after.fds).toBeLessThanOrEqual(before.fds + 2);
  }, 600_000);
});

describe('exec hands back a running process', () => {
  it('streams output as it is produced rather than at exit', async () => {
    // The property the supervisor's line-delimited protocol depends on, and the one a
    // buffered implementation would fail silently: its output would arrive when the process
    // ends, which for a process built to stay up and converse is never.
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    const started = await sandbox.exec(['sh', '-c', 'echo first; sleep 5; echo second']);
    let ended = false;
    void started.exit.then(() => (ended = true));

    const first = await new Promise<string>((resolve) => started.stdout.once('data', (chunk) => resolve(String(chunk))));
    expect(first).toContain('first');
    expect(ended).toBe(false);

    const rest = await text(started.stdout);
    expect(rest).toContain('second');
    expect((await started.exit).code).toBe(0);

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });

  it('runs in the workspace unless told otherwise', async () => {
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);

    expect(await inside(sandbox, ['pwd'])).toMatchObject({ out: '/workspace' });

    const elsewhere = await sandbox.exec(['pwd'], { cwd: '/tmp' });
    expect((await text(elsewhere.stdout)).trim()).toBe('/tmp');
    await elsewhere.exit;

    await sandbox.destroy();
    await subject.releaseWorkspace(agent.id);
  });
});

describe('a broken pipe fails the process, not the caller', () => {
  // Ten megabytes because a pipe holds around sixty-four kilobytes: the write cannot finish
  // in one go, so the remainder is still outstanding when the reader goes away and `EPIPE`
  // is certain rather than a matter of timing. A credential block is a few hundred bytes —
  // the size here is what makes the failure reproducible, not what makes it possible.
  const MORE_THAN_A_PIPE_HOLDS = 'x'.repeat(10 * 1024 * 1024);

  // Read the first two as a pair, because separately neither is enough — this was checked
  // by mutation rather than assumed. Take the pipe listeners away and the first one still
  // passes: **vitest installs an `uncaughtException` handler of its own**, so the `EPIPE`
  // that kills a supervisor is caught here instead, `close` arrives, and the exit is what
  // it should be. The run goes red, but as an "Uncaught Exception" beside a green test, and
  // that is easy to read as noise. The second is the one that fails outright, because a
  // delivery that never happened resolves as a success. So: the first says what the caller
  // is owed, the second is what notices when the handling goes.
  it('reports the subprocess’s own failure when its input has nowhere to go', async () => {
    const started = spawner('sh', ['-c', 'exit 7'], process.env, MORE_THAN_A_PIPE_HOLDS);

    // The failed exit, not a rejection: a caller can act on a process that failed, and the
    // subprocess's own account of why is better than the broken pipe's.
    expect(await started.exit).toMatchObject({ code: 7 });
  });

  it('refuses to report a delivery that never arrived as a success', async () => {
    const started = spawner('sh', ['-c', 'exit 0'], process.env, MORE_THAN_A_PIPE_HOLDS);

    // The dangerous half. A command that exits zero without the credentials it was sent is
    // indistinguishable from one that had them, so this is the only place it can be said.
    await expect(started.exit).rejects.toThrow(SandboxError);
    await expect(started.exit).rejects.toThrow(/EPIPE/);
  });

  it('reports a failure rather than crashing when the sandbox is gone before exec reaches it', async () => {
    // The way this is actually reached: the supervisor holds a handle, the container is
    // swept or dies, and the next process it starts finds nothing to start in.
    const subject = driver();
    const agent = record();
    const sandbox = await subject.create(agent);
    await sandbox.destroy();

    const gone = await inside(sandbox, ['echo', 'unreachable']);
    expect(gone.code === 0).toBe(false);
    expect(gone.err).toMatch(/[Nn]o such container/);

    await subject.releaseWorkspace(agent.id);
  });
});
