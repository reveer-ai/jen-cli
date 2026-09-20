/**
 * The substrate doing the thing it exists for: real agents, real containers, a real
 * runtime, reasoning over a real network.
 *
 * **It covers the seam nothing else does, and stops there.** Seven of ENG-199's nine
 * criteria already have tests — `containers.test.ts` holds suspension, `kill -9` resume and
 * the sweep against real containers, and `spawn.test.ts`, `routing.test.ts` and
 * `failure.test.ts` hold depth, the single messaging path, dismissal and the human at the
 * root. What none of them holds is **the real runtime being the thing inside the box**:
 * every container test drives `SHELL_PEER`, a shell script, and every runtime test runs in
 * process against `scripted()`. So what is asserted here is one run through the real path,
 * and the criteria that are asserted elsewhere are not asserted again.
 *
 * Four of these do overlap something already tested, and each is kept for a reason specific
 * to the real runtime rather than out of completeness. Resume is the sharpest: the shell
 * peer proves the supervisor's half, but `answerInterrupted` and the `#answerInLog`
 * collision the whole suspend design is built around live in the runtime, and no test has
 * ever exercised them with a real body. Visible failure is kept because the real driver
 * reports a killed container's exit where the double decides what to report.
 *
 * **This needs a container runtime and builds an image, and nothing in CI runs it.** See
 * `agent/AGENTS.md`. It is written to the same shape as the two suites that were already in
 * that position: everything is labelled with this file's own run id, containers are swept
 * after every test, and this tier's own volumes are released in `afterAll` — by this file,
 * because nothing in the substrate releases a workspace.
 *
 * **It spends nothing.** The model is `gateway.ts`, an OpenAI-compatible server on the host
 * with each record's `baseURL` pointed at it — the seam `model.ts` already describes, used
 * as described, with no branch added to the runtime and nothing for `policy.test.ts` to
 * find. Reaching it from a container relies on `host.docker.internal`, which Docker Desktop
 * provides and Linux Docker does not; `beforeAll` fails naming that rather than letting it
 * surface from inside a model call.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { aRecord } from './fixture.ts';
import {
  calls,
  everyResult,
  HOST_FROM_CONTAINER,
  lastMessage,
  lastResult,
  latch,
  says,
  sequence,
  startGateway,
  type Gateway,
  type GatewayRequest,
  type Script,
} from './gateway.ts';
import { DockerSandboxDriver } from './sandbox/docker.ts';
import { render, Store, Supervisor, type Message } from './supervisor/index.ts';

import type { AgentRecord } from './record.ts';

const run = promisify(execFile);

/** Scopes every label, every agent id, and the sweep, to this run of this file. */
const RUN = `jen-accept-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The image this change adds, built from `agent/` as its context. */
const IMAGE = 'jen/agent:latest';

const OPERATOR = join(import.meta.dirname, 'operator.ts');

/**
 * The value the fixture's credential reference resolves to, supplied by this file.
 *
 * `aRecord`'s `model.credential` has to be among its `credentials` for the record to be
 * valid at all, and an unresolvable reference fails creation by design — so without this
 * every boot here would die in the credential prologue before a container existed. What the
 * value *is* never matters to the gateway, which authenticates nobody; what matters is that
 * it arrives, and one of the assertions below is that the very bytes set here came back out
 * of the container in an `Authorization` header. That is the only way to see the whole
 * credential path at once: resolved on the host, written to a process's own standard input,
 * exported by the prologue, read from the environment by `openAIClient`, sent over the wire.
 *
 * It goes on `process.env` rather than into a driver option because the operator runs in a
 * process of its own and builds its own driver; a spawned child inherits this, and a
 * constructor argument here would never reach it.
 */
const TOKEN = 'sentinel-not-a-real-key';
process.env.JEN_MODEL_API_KEY ??= TOKEN;

const opened: Store[] = [];
const gateways: Gateway[] = [];

async function ask(...args: string[]): Promise<string> {
  try {
    return (await run('docker', args)).stdout.trim();
  } catch (error) {
    return ((error as { stdout?: string }).stdout ?? '').trim();
  }
}

async function lines(...args: string[]): Promise<string[]> {
  return (await ask(...args)).split('\n').filter((line) => line !== '');
}

/** The agents of this run that currently hold a container. */
async function running(): Promise<string[]> {
  return lines('ps', '--filter', `label=jen.run=${RUN}`, '--format', '{{.Label "jen.agent"}}');
}

/** Whether one agent's workspace is still there, asked by that agent's own marking. */
async function workspaceOf(id: string): Promise<string[]> {
  return lines('volume', 'ls', '--filter', `label=jen.agent=${id}`, '--format', '{{.Name}}');
}

async function until(satisfied: () => Promise<boolean>, what: string, ms = 120_000): Promise<void> {
  const started = Date.now();
  while (!(await satisfied())) {
    if (Date.now() - started > ms) throw new Error(`never reached ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A store of this run, in a directory of its own. */
async function aStore(): Promise<{ store: Store; root: string }> {
  const root = join(await mkdtemp(join(tmpdir(), 'jen-accept-')), '.jen');
  const store = await Store.open(root, RUN);
  opened.push(store);
  return { store, root };
}

async function aGateway(scripts: Record<string, Script>, before?: (r: GatewayRequest) => Promise<void>): Promise<Gateway> {
  const gateway = await startGateway({ scripts, before });
  gateways.push(gateway);
  return gateway;
}

/**
 * A record naming the substrate's image and a script at the gateway.
 *
 * Nothing here is a per-agent skill file, and there is no such file anywhere in this tier:
 * an agent's purpose is its charter, and a charter is a field on a record — written in code
 * for the root, and written by its parent's own `spawn` call for everyone below.
 */
function aScripted(
  gateway: Gateway,
  id: string,
  model: string,
  tools: string[],
  charter: string,
  parent: string | null = null,
): AgentRecord {
  return aRecord({
    id,
    charter,
    parent,
    tools,
    environment: IMAGE,
    workspace: '/workspace',
    model: { provider: 'scripted', baseURL: gateway.url, model, credential: 'MODEL_API_KEY' },
    credentials: [{ name: 'MODEL_API_KEY', ref: 'env:JEN_MODEL_API_KEY' }],
  });
}

/** A supervisor over the real driver, collecting what reaches the person. */
function aSupervisor(store: Store): {
  supervisor: Supervisor;
  heard: string[];
  stalls: { waiting: readonly string[]; stopped: readonly string[] }[];
} {
  const heard: string[] = [];
  const stalls: { waiting: readonly string[]; stopped: readonly string[] }[] = [];
  const supervisor = new Supervisor({
    store,
    driver: new DockerSandboxDriver({ run: RUN }),
    // Rendered, because `onMessage` is handed the raw message and is the one delivery path
    // that skips rendering — see `operator.ts`, which is the real consumer.
    onMessage: (message: Message) => heard.push(render(message)),
    onStalled: (stalled) => stalls.push({ waiting: [...stalled.waiting], stopped: [...stalled.stopped] }),
  });
  return { supervisor, heard, stalls };
}

/** An agent's stored state, read off disk the way anything after a crash reads it. */
async function stateOf(root: string, id: string): Promise<{ status: string } & Record<string, unknown>> {
  const path = join(root, 'runs', RUN, 'agents', id, 'state.json');
  const stored = JSON.parse(await readFile(path, 'utf8')) as { state: { status: string } };
  return stored.state as { status: string } & Record<string, unknown>;
}

async function transcriptOf(root: string, id: string): Promise<string[]> {
  const path = join(root, 'runs', RUN, 'agents', id, 'events.ndjson');
  return (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
}

beforeAll(async () => {
  if ((await ask('version', '--format', '{{.Server.Version}}')) === '') {
    throw new Error('these tests need a running container runtime, and none is reachable. See agent/AGENTS.md.');
  }

  // Built rather than pulled: the image is this change's, it is pushed to no registry, and
  // building it from the working tree is what makes the thing under test the thing on disk.
  //
  // **Whether it built is read from the build and from nothing else.** The tag it writes is
  // left on the machine by every green run and nothing removes it, so a guard that asked
  // whether `jen/agent:latest` resolves would answer yes for a Dockerfile that just failed
  // to build — and the whole tier would run green against yesterday's image, saying nothing
  // about the tree it was pointed at. `run` rejects on a non-zero exit, which is the answer
  // already.
  try {
    await run('docker', ['build', '--tag', IMAGE, import.meta.dirname], { timeout: 900_000 });
  } catch (error) {
    throw new Error(
      `the agent image could not be built from ${import.meta.dirname}:\n` +
        `${(error as { stderr?: string }).stderr ?? String(error)}`,
    );
  }

  // **The host has to be reachable from inside a container, and that is checked here
  // rather than discovered inside a model call.** `host.docker.internal` is a Docker
  // Desktop convenience; Linux Docker does not provide it, and teaching the driver
  // `--add-host` would make every container the substrate creates carry a concern that
  // exists for a test. So this fails in setup, naming it — the way the other container
  // suites already name a missing daemon.
  const gateway = await aGateway({ 'script:probe': sequence(says('pong')) });
  const reply = await ask(
    'run',
    '--rm',
    IMAGE,
    'node',
    '-e',
    "fetch(process.argv[1],{method:'POST',headers:{'content-type':'application/json'}," +
      "body:JSON.stringify({model:'script:probe',messages:[]})})" +
      '.then((r)=>r.json()).then((j)=>process.stdout.write(String(j.choices?.[0]?.message?.content)))' +
      '.catch((e)=>{process.stdout.write(`unreachable: ${e.message}`);process.exitCode=1;})',
    `${gateway.url}/chat/completions`,
  );
  if (reply !== 'pong') {
    throw new Error(
      `a container on this machine cannot reach a service on the host at ${HOST_FROM_CONTAINER}, so the ` +
        `scripted model gateway is unreachable and every agent here would fail inside its first model call. ` +
        `Docker Desktop provides that name and Linux Docker does not — see agent/AGENTS.md. The probe said: ${reply}`,
    );
  }
}, 900_000);

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const store of opened.splice(0)) await store.close();
  // Containers only. Workspaces are released in `afterAll`, because one of the things under
  // test is that a run's workspaces outlive it — and because a test that failed before its
  // own shutdown would otherwise have its leftovers counted by the next one.
  for (const id of await lines('ps', '-aq', '--filter', `label=jen.run=${RUN}`)) await ask('rm', '--force', id);
});

afterAll(async () => {
  for (const id of await lines('ps', '-aq', '--filter', `label=jen.run=${RUN}`)) await ask('rm', '--force', id);
  // **This tier releases its own volumes and the substrate releases none.** `destroyAll`
  // ends bodies and deliberately leaves every workspace, which is why a run's workspaces
  // outlive the run and removing them is the person's act — here, this file's.
  for (const name of await lines('volume', 'ls', '-q', '--filter', `label=jen.run=${RUN}`)) {
    await ask('volume', 'rm', '--force', name);
  }
});

describe('the real runtime is the thing inside the container', () => {
  /**
   * The claim nothing in the repository has ever made: `jen-agent` started inside a real
   * sandbox, read its boot frame off the same pipe the credentials arrived on, reasoned
   * with a model over the network, and reported.
   *
   * The credential assertion is the whole delivery path in one line. There is no other
   * place it can be seen end to end: the driver's own suite proves the block is written and
   * that nothing is stored in the container's configuration, and the runtime's suite proves
   * `openAIClient` reads its variable — and neither can show that the value the host
   * resolved is the value the model endpoint was reached with.
   */
  it('boots from the image, takes a turn, and reports it', async () => {
    const gateway = await aGateway({ 'script:solo': sequence(says('the runtime booted and took a turn')) });
    const { store, root } = await aStore();
    const { supervisor, heard } = aSupervisor(store);
    const id = `${RUN}-solo`;

    await supervisor.add(aScripted(gateway, id, 'script:solo', [], 'Say that you ran.'), 'Begin.');
    await until(async () => heard.length > 0, `the root reporting (${JSON.stringify(heard)})`);

    expect(heard).toEqual([`[from ${id}] the runtime booted and took a turn`]);

    // Its own transcript, written through the supervisor as the turn happened.
    const events = (await transcriptOf(root, id)).map((line) => (JSON.parse(line) as { type: string }).type);
    expect(events).toContain('charter');
    expect(events).toContain('usage');

    // The credential the host resolved is the credential the endpoint was reached with.
    expect(gateway.seen.length).toBeGreaterThan(0);
    expect(gateway.seen[0]?.authorization).toBe(`Bearer ${process.env.JEN_MODEL_API_KEY ?? ''}`);
    // And the charter went out as the conversation's first message, unmodified.
    expect(gateway.seen[0]?.messages[0]).toEqual({ role: 'system', content: 'Say that you ran.' });

    await supervisor.shutdown();
    expect(await running()).toEqual([]);
  }, 300_000);

  /**
   * Depth ≥ 2 through the real path, and the whole of the operator at the same time.
   *
   * **Flat fan-out from a root would prove nothing.** It passes cleanly on an
   * implementation where the root is structurally special, which is the exact failure the
   * epic exists to prevent — so what is asserted is a grandchild: an agent that was spawned
   * by an agent that was itself spawned, constructed through the same path, reasoning with
   * the same runtime.
   *
   * It runs through `operator.ts` rather than an in-process supervisor because the operator
   * is the program a person actually uses, and four of its requirements are only observable
   * from outside it: that the person sees the root's words rendered, that nothing below the
   * root is shown, that what the person types reaches the root as its parent's message, and
   * that a tree with nothing left to do says so.
   */
  it('runs a tree three deep, and shows the person only what its root says', async () => {
    const id = `${RUN}-chief`;
    const gateway = await aGateway({
      'script:chief': sequence(
        calls({
          name: 'spawn',
          arguments: {
            name: 'branch',
            charter: 'Spawn one agent of your own and report that you did.',
            model: 'script:branch',
            tools: ['spawn', 'await'],
            opening: 'Begin.',
          },
        }),
        calls({ name: 'await', arguments: {} }),
        // Opening with the substrate's own mark, deliberately: what the person is shown has
        // to distinguish this from a message the substrate sent.
        (request) => says(`[substrate] chief reporting: ${lastResult(request)}`),
        (request) => says(`chief heard: ${lastMessage(request)}`),
      ),
      'script:branch': sequence(
        calls({
          name: 'spawn',
          arguments: { name: 'leaf', charter: 'Say one thing.', model: 'script:leaf', opening: 'Begin.' },
        }),
        calls({ name: 'await', arguments: {} }),
        // Says nothing about what its own child said, so that the phrase below can only
        // reach the person if something streamed it there.
        says('branch finished with a child of its own'),
      ),
      'script:leaf': sequence(says('leaf-secret-phrase')),
    });

    const { root } = await aStore();
    const record = aScripted(gateway, id, 'script:chief', ['spawn', 'await'], 'Delegate, and report what came back.');
    const path = join(root, 'root-record.json');
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);

    const operator = spawn(process.execPath, [OPERATOR, root, RUN, path, 'Begin.'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let said = '';
    let complained = '';
    operator.stdout.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
    operator.stderr.setEncoding('utf8').on('data', (chunk: string) => (complained += chunk));

    try {
      await until(async () => said.includes('chief reporting'), `the chief reporting (${complained})`);

      // Depth ≥ 2: a grandchild, related through stored parentage rather than through ids
      // that happen to look nested.
      const store = await Store.open(root, RUN);
      opened.push(store);
      const branch = store.ids().find((one) => store.agent(one).parent === id);
      expect(branch, 'the chief spawned nothing').toBeDefined();
      const leaf = store.ids().find((one) => store.agent(one).parent === branch);
      expect(leaf, 'the branch spawned nothing, so nothing reached depth 2').toBeDefined();
      expect(store.agent(leaf!).parent).toBe(branch);
      expect(store.agent(branch!).parent).toBe(id);
      expect(store.agent(id).parent).toBeNull();

      // One record type throughout: every agent here, the root included, was read back by
      // the same parser into the same shape, and the root differs in exactly one field.
      for (const one of store.ids()) expect(Object.keys(store.record(one)).sort()).toEqual(Object.keys(record).sort());

      // The grandchild did run and did say its piece — to its parent.
      const leafSaid = (await transcriptOf(root, leaf!)).map((line) => JSON.parse(line) as { content?: string });
      expect(leafSaid.some((event) => event.content === 'leaf-secret-phrase')).toBe(true);

      // And the person was shown none of it. What the root relays, the person sees — the
      // branch's own words are in the chief's report, because the chief chose to quote
      // them. What the root did not relay is not there: the branch said nothing about its
      // child, so the grandchild's words reached the person nowhere. Visibility is pull,
      // and what a person wants to know about a descendant they ask the root, which can
      // read it.
      expect(said).toContain('branch finished with a child of its own');
      expect(said).not.toContain('leaf-secret-phrase');

      // Rendered as any recipient's message is: the sender's mark, and the escape that
      // keeps an agent from forging the substrate's voice to the one recipient who cannot
      // ask the substrate a follow-up question.
      expect(said).toContain(`[from ${id}] \\[substrate] chief reporting:`);
      expect(said.split('\n').some((line) => line.startsWith('[substrate] chief'))).toBe(false);

      // A tree with nothing left to do says so, and names who is waiting.
      await until(async () => complained.includes('is waiting and nothing is pending'), 'the stall being reported');
      expect(complained).toContain(id);

      // What the person types reaches the root as its parent's message, in the position a
      // parent's message occupies — carrying the human's mark and nothing else.
      operator.stdin.write('what did you find?\n');
      await until(async () => said.includes('chief heard:'), `the chief hearing the person (${complained})`);
      expect(said).toContain('chief heard: [from the human] what did you find?');
    } finally {
      operator.stdin.end();
      await new Promise((resolve) => operator.on('close', resolve));
    }

    // Ending the operator ended every body and kept every workspace.
    expect(await running()).toEqual([]);
    const store = await Store.open(root, RUN);
    opened.push(store);
    for (const one of store.ids()) expect(await workspaceOf(one), `${one} lost its workspace`).toHaveLength(1);
  }, 600_000);
});

describe('agents run beside each other, each in a workspace of its own', () => {
  /**
   * Two children in flight at once, fanned out by a `spawn` that returned immediately and
   * collected by two ordinary `await`s. No scheduler is involved and none exists.
   *
   * The claim is made twice, from two sides, because neither half is enough on its own. The
   * gateway counts how many requests it was holding at one moment — two model calls in
   * flight are two agents mid-step, because a runtime awaits each step before taking the
   * next. And `docker ps` is asked, at that same moment, whether both bodies exist. A
   * substrate that provisioned two and ran them one after the other would satisfy neither.
   */
  it('holds two in a model call at once, and neither can see the other’s work', async () => {
    const id = `${RUN}-pair`;
    const workers = latch((request) => request.model.startsWith('script:worker'));
    const worker = (letter: string): Script =>
      sequence(
        calls({ name: 'fs', arguments: { operation: 'write', path: `${letter}.txt`, content: letter } }),
        calls({ name: 'fs', arguments: { operation: 'list', path: '.' } }),
        (request) => says(`worker-${letter} sees: ${lastResult(request)}`),
      );

    const gateway = await aGateway(
      {
        'script:pair': sequence(
          calls(
            {
              name: 'spawn',
              arguments: {
                name: 'a',
                charter: 'Write a file and say what you can see.',
                model: 'script:worker-a',
                tools: ['fs'],
                opening: 'Begin.',
              },
            },
            {
              name: 'spawn',
              arguments: {
                name: 'b',
                charter: 'Write a file and say what you can see.',
                model: 'script:worker-b',
                tools: ['fs'],
                opening: 'Begin.',
              },
            },
          ),
          calls({ name: 'await', arguments: {} }),
          calls({ name: 'await', arguments: {} }),
          (request) => says(`pair collected: ${everyResult(request).slice(-2).join(' || ')}`),
        ),
        'script:worker-a': worker('a'),
        'script:worker-b': worker('b'),
      },
      workers.before,
    );

    const { store } = await aStore();
    const { supervisor, heard } = aSupervisor(store);
    await supervisor.add(
      aScripted(gateway, id, 'script:pair', ['spawn', 'await', 'fs'], 'Delegate two pieces of work at once.'),
      'Begin.',
    );

    // Both held in a model call at the same instant, which is the moment to ask the runtime
    // what it is holding.
    await until(async () => workers.held === 2, `two children in a model call at once (held ${workers.held})`);
    const bodies = await running();
    expect(bodies).toContain(`${id}-1`);
    expect(bodies).toContain(`${id}-2`);
    expect(workers.most).toBe(2);
    workers.release();

    await until(async () => heard.length > 0, 'the root collecting both children');
    const collected = heard.join('\n');
    expect(collected).toContain('worker-a sees:');
    expect(collected).toContain('worker-b sees:');

    // Each listed its own workspace, and what it listed was its own file and no other's.
    // Isolation is not a rule the supervisor enforces between siblings — it is that a
    // workspace is keyed on the agent id, which is the supervisor's to set and is refused
    // outright if a spawn names it.
    const reports = collected.split(' || ');
    expect(reports, `the root did not collect two reports: ${collected}`).toHaveLength(2);
    for (const report of reports) {
      const letter = /worker-([ab]) sees:/.exec(report)?.[1];
      expect(letter, `a report named no worker: ${report}`).toBeDefined();
      const other = letter === 'a' ? 'b' : 'a';
      expect(report, `worker-${letter ?? '?'} could not see its own file`).toContain(`${letter ?? '?'}.txt`);
      expect(report, `worker-${letter ?? '?'} could see worker-${other}'s workspace`).not.toContain(`${other}.txt`);
    }

    await supervisor.shutdown();
    expect(await running()).toEqual([]);
  }, 600_000);
});

describe('a body that dies is something its parent can act on', () => {
  /**
   * A child's container ended out from under it, while it is genuinely mid-turn.
   *
   * `failure.test.ts` holds this against the driver double, where the double decides what a
   * dead body reports. Here the real driver reports a real exit, and what the parent is
   * handed is whatever the container runtime actually said — which is the half that has
   * never run.
   *
   * The parent is waiting on an `await` with no other message coming, so a substrate that
   * did not wake it would leave it there forever. Reaching its next step at all is the
   * assertion; what it says is how the test can see that it did.
   */
  it('wakes the parent with a termination rather than leaving it awaiting one', async () => {
    const id = `${RUN}-watcher`;
    const child = `${id}-1`;
    // Never released: the child sits in its first model call, with a live container, until
    // the container is taken away from it.
    const doomed = latch((request) => request.model === 'script:doomed');

    const gateway = await aGateway(
      {
        'script:watcher': sequence(
          calls({
            name: 'spawn',
            arguments: { name: 'doomed', charter: 'Never finish.', model: 'script:doomed', opening: 'Begin.' },
          }),
          calls({ name: 'await', arguments: {} }),
          (request) => says(`watcher saw: ${lastResult(request)}`),
        ),
        'script:doomed': sequence(says('never reached')),
      },
      doomed.before,
    );

    const { store } = await aStore();
    const { supervisor, heard } = aSupervisor(store);
    await supervisor.add(
      aScripted(gateway, id, 'script:watcher', ['spawn', 'await'], 'Delegate, and say what became of it.'),
      'Begin.',
    );

    await until(async () => doomed.held === 1 && (await running()).includes(child), 'the child working in a container');

    // Through the container runtime directly, filtered on this run's own marking. The
    // driver interface may not name a container and is not asked to.
    for (const one of await lines('ps', '-q', '--filter', `label=jen.agent=${child}`)) await ask('rm', '--force', one);

    await until(async () => heard.length > 0, 'the parent being woken by its child’s death');
    expect(heard[0]).toContain('watcher saw:');
    expect(heard[0]).toContain(`${child}'s body ended`);
    // The substrate's mark, carried through the parent's own report of it.
    expect(heard[0]).toContain('[substrate]');

    // And the child is not a death the parent has to infer: it is still addressable, and
    // its workspace is still there.
    expect(await workspaceOf(child)).toHaveLength(1);

    await supervisor.shutdown();
    expect(await running()).toEqual([]);
  }, 600_000);
});

describe('a run killed without warning comes back and finishes', () => {
  /**
   * `kill -9` on the whole process group, with containers live, and the program that comes
   * back is **the operator itself** rather than a harness written for the test.
   *
   * That choice is the point. A harness that resumed differently from the program people
   * run would prove recovery for a program nobody uses — and it is also why the operator
   * decides between beginning and resuming by reading the store rather than by taking a
   * flag: the second command line here is byte-for-byte the first one, which is how a run is
   * actually resumed, and a flag is a thing a person gets wrong exactly once, after a crash.
   *
   * What survives is the store, the transcripts and the workspaces. Everything else — the
   * supervisor, its handles, the containers it was holding — is gone or unusable.
   */
  it('resumes from records and transcripts alone, and each agent continues where it stopped', async () => {
    const id = `${RUN}-marathon`;
    const child = `${id}-1`;
    const slow = latch((request) => request.model === 'script:slow');

    const gateway = await aGateway(
      {
        'script:marathon': sequence(
          calls({
            name: 'spawn',
            arguments: { name: 'slow', charter: 'Take your time.', model: 'script:slow', opening: 'Begin.' },
          }),
          calls({ name: 'await', arguments: {} }),
          (request) => says(`marathon collected: ${lastResult(request)}`),
        ),
        'script:slow': sequence(says('finished after the resume')),
      },
      slow.before,
    );

    const { root } = await aStore();
    const record = aScripted(gateway, id, 'script:marathon', ['spawn', 'await'], 'Delegate and wait.');
    const path = join(root, 'root-record.json');
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    const argv = [OPERATOR, root, RUN, path, 'Begin.'];

    // Detached, so it leads a process group of its own and the kill reaches the whole of it
    // rather than only the node process at the top.
    // Its input stays open and nothing is ever written to it: the operator reads a person's
    // lines from standard input and treats the end of them as the person ending the run, so
    // a child given no input at all would shut itself down politely — which is the one thing
    // this test must not let it do.
    const first = spawn(process.execPath, argv, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let complained = '';
    first.stdout.resume();
    first.stderr.setEncoding('utf8').on('data', (chunk: string) => (complained += chunk));
    let closed = false;
    first.on('close', () => (closed = true));

    try {
      // **A stored step, not merely the status.** An agent becomes `working` the moment its
      // message is delivered, which is before its body has written anything — so a kill on
      // the status alone can land on an agent whose transcript is empty, and "resumes from
      // records and transcripts alone" then resumes from nothing and proves much less than
      // it reads as proving.
      await until(async () => {
        if (closed) throw new Error(`the operator exited before its tree was working: ${complained}`);
        return (
          slow.held === 1 &&
          (await running()).includes(child) &&
          (await stateOf(root, child).catch(() => ({ status: '?' }))).status === 'working' &&
          (await transcriptOf(root, child)).length > 0
        );
      }, `the child working with something recorded (${complained})`);
    } finally {
      try {
        process.kill(-first.pid!, 'SIGKILL');
      } catch {
        // Already gone, which is the state this was trying to reach anyway.
      }
      if (!closed) await new Promise((resolve) => first.on('close', resolve));
    }

    // The container outlived it: it is not a child of the process that made it, and nothing
    // is left holding a handle on it.
    expect(await running()).toContain(child);
    expect((await stateOf(root, child)).status).toBe('working');
    const before = await transcriptOf(root, child);

    // The model answers from here on. Nothing else about the world changed.
    slow.release();

    const second = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let said = '';
    let alsoComplained = '';
    second.stdout.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
    second.stderr.setEncoding('utf8').on('data', (chunk: string) => (alsoComplained += chunk));

    try {
      await until(
        async () => said.includes('marathon collected'),
        `the resumed tree finishing its work (${alsoComplained})`,
      );
      expect(said).toContain('finished after the resume');
    } finally {
      second.stdin.end();
      await new Promise((resolve) => second.on('close', resolve));
    }

    // Continued rather than restarted: the transcript it had before the kill is still at the
    // front of the transcript it has now.
    const after = await transcriptOf(root, child);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
    // And its charter appears once, which is what a restarted agent would not manage.
    expect(after.filter((line) => line.includes('"type":"charter"'))).toHaveLength(1);

    // Clean exit: every container the run created is gone, and every workspace it created
    // is still there — released by this file in `afterAll`, because nothing in the
    // substrate releases one.
    expect(await running()).toEqual([]);
    expect(await lines('ps', '-a', '--filter', `label=jen.run=${RUN}`, '--format', '{{.Label "jen.agent"}}')).toEqual([]);
    for (const one of [id, child]) expect(await workspaceOf(one), `${one} lost its workspace`).toHaveLength(1);
  }, 900_000);
});
