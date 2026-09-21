/**
 * The whole thing, against a real container runtime.
 *
 * Everything else in this directory runs against a double, which is right for a change that
 * is mostly a state machine over stored data. Three assertions are not about the state
 * machine at all — that a fully dormant tree holds no container, that an agent which asked
 * to stay resident still holds its own, and that a run killed with containers live is swept
 * and resumes — and a double cannot make any of them, because the double decides what
 * `docker ps` would have said.
 *
 * **These tests need a running container runtime, and nothing in CI runs them.** See
 * `agent/AGENTS.md`. They inherit that from `sandbox/docker.test.ts` and are written to the
 * same shape: everything is labelled with this file's own run id and swept in `afterAll`.
 *
 * The agents are the shell peer in `harness.ts` rather than the real runtime, because what
 * is under test is containers and not reasoning. `sh` is the whole of what a sandbox image
 * has to provide, so this needs no image of its own.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { aRecord, EVERY_CAPABILITY } from '../fixture.ts';
import { DockerSandboxDriver } from '../sandbox/docker.ts';
import { SHELL_PEER, type HarnessConfig } from './harness.ts';
import { Supervisor } from './index.ts';
import { Store } from './store.ts';

import type { AgentRecord } from '../record.ts';

const run = promisify(execFile);

/** Scopes every label, every agent id, and the sweep, to this run of this file. */
const RUN = `jen-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Small, public, and carrying the `sh` a sandbox idles on and the peer is written in. */
const IMAGE = 'busybox:stable';

const HARNESS = join(import.meta.dirname, 'harness.ts');

/**
 * The value `aRecord`'s credential resolves to, supplied by the test rather than found.
 *
 * A record is only valid if `model.credential` is among its `credentials`, so the fixture's
 * reference cannot simply be dropped — and an unresolvable one fails creation by design, so
 * with the real driver every boot here died in the credential prologue before a container
 * existed, on any machine without this variable set. Setting it is not the suite reaching
 * for the environment: the value is this file's own, the way `docker.test.ts` supplies
 * `JEN_TEST_TOKEN` to the sandboxes it starts. The peer is `sh` and authenticates to
 * nothing, so what the value *is* never matters — only that it resolves.
 *
 * It goes on `process.env` rather than into a driver option because `harness.ts` runs in a
 * process of its own and builds its own driver; a spawned child inherits this, and a
 * constructor argument here would never reach it.
 */
process.env.JEN_MODEL_API_KEY ??= 'sentinel-not-a-real-key';

const opened: Store[] = [];

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

/** Containers of this run that are still running. */
async function running(): Promise<string[]> {
  return lines('ps', '--filter', `label=jen.run=${RUN}`, '--format', '{{.Label "jen.agent"}}');
}

async function all(): Promise<string[]> {
  return lines('ps', '-a', '--filter', `label=jen.run=${RUN}`, '--format', '{{.Label "jen.agent"}}');
}

/**
 * Everything granted, because the shell peer decides what it calls and this test cannot.
 *
 * A record that omitted a kind the peer's script reaches would be refused at the channel,
 * and the peer ignores answers — so the agent would never reach the state the harness is
 * waiting for and the test would hang rather than fail. This is the tier where that costs
 * the most to diagnose, so the grant is the wide one here and nowhere else.
 */
function aPeerRecord(id: string, charter: string, parent: string | null = null): AgentRecord {
  return aRecord({ id, charter, parent, environment: IMAGE, workspace: '/workspace', tools: EVERY_CAPABILITY });
}

async function aStore(): Promise<{ store: Store; root: string }> {
  const root = join(await mkdtemp(join(tmpdir(), 'jen-containers-')), '.jen');
  const store = await Store.open(root, RUN);
  opened.push(store);
  return { store, root };
}

function aSupervisor(store: Store): Supervisor {
  return new Supervisor({
    store,
    driver: new DockerSandboxDriver({ run: RUN }),
    command: ['sh', '-c', SHELL_PEER],
  });
}

async function until(satisfied: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const started = Date.now();
  while (!(await satisfied())) {
    if (Date.now() - started > ms) throw new Error(`never reached ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  if ((await ask('version', '--format', '{{.Server.Version}}')) === '') {
    throw new Error('these tests need a running container runtime, and none is reachable. See agent/AGENTS.md.');
  }
  await run('docker', ['pull', IMAGE], { timeout: 240_000 });
}, 600_000);

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  // Containers only, and never a workspace — `afterAll` is where those go, because one test
  // reads a workspace back after the run that wrote it has been swept.
  //
  // Every test here counts containers by this file's shared run label, so a test that fails
  // before its own shutdown leaves its tree running and the *next* test counts it too. That
  // is not a hypothetical: it turned a failure in the resume test into an unrelated-looking
  // arity mismatch in the sweep test, which cost more to read than the real failure did.
  for (const id of await lines('ps', '-aq', '--filter', `label=jen.run=${RUN}`)) await ask('rm', '--force', id);
});

afterAll(async () => {
  for (const id of await lines('ps', '-aq', '--filter', `label=jen.run=${RUN}`)) await ask('rm', '--force', id);
  for (const name of await lines('volume', 'ls', '-q', '--filter', `label=jen.run=${RUN}`)) {
    await ask('volume', 'rm', '--force', name);
  }
});

describe('a dormant tree holds nothing, and a resident agent holds its own', () => {
  /**
   * In a tree, every ancestor of every working agent is idle by construction — so a
   * substrate that kept idle agents resident would scale containers with the shape of the
   * org chart rather than with the work. That is the argument the whole suspension model
   * exists for, and this is where it is either true of real containers or it is not.
   *
   * **The assertion is that each agent was honoured, never that suspension always tears
   * down.** An agent that asked to stay resident and still has its container is the correct
   * result rather than a leak.
   */
  it('leaves one container running, belonging to the agent that asked for it', async () => {
    const { store } = await aStore();
    const supervisor = aSupervisor(store);

    // A tree rather than three roots: every ancestor of every working agent is idle by
    // construction, which is the shape the whole suspension argument is about.
    // Each carries an opening, as `harness.ts` does. Without one an agent is added already
    // `waiting` with an empty mailbox and is never booted at all — so both waits below were
    // satisfied the instant they were asked, by a tree in which nothing had ever run.
    await supervisor.add(aPeerRecord(`${RUN}-chief`, 'GO: finish and ask for nothing.'), 'Begin.');
    await supervisor.add(aPeerRecord(`${RUN}-go`, 'GO: finish and ask for nothing.', `${RUN}-chief`), 'Begin.');
    await supervisor.add(aPeerRecord(`${RUN}-stay`, 'STAY: keep my container.', `${RUN}-chief`), 'Begin.');

    // Every agent has *reached* a turn's end, rather than never having left the state `add`
    // creates it in: the peer appends a `usage` event on the message it answers, so a
    // transcript with one is a body that ran.
    await until(
      async () =>
        store.ids().every(
          (id) =>
            store.agent(id).state.status === 'waiting' &&
            store.agent(id).mailbox.length === 0,
        ) && (await Promise.all(store.ids().map((id) => store.transcript(id)))).every((events) =>
          events.some((event) => event.type === 'usage'),
        ),
      'every agent running and then suspending',
    );
    await until(async () => (await running()).length <= 1, 'the dormant agents’ containers ending');

    expect(await running()).toEqual([`${RUN}-stay`]);
    expect(supervisor.resident).toEqual([`${RUN}-stay`]);

    // And the ones that went dormant lost nothing: their workspaces are still there, which
    // is what a later message would wake them into.
    expect((await lines('volume', 'ls', '--filter', `label=jen.run=${RUN}`, '--format', '{{.Name}}')).length).toBe(3);

    await supervisor.shutdown();
    expect(await running()).toEqual([]);
  }, 300_000);
});

/**
 * Start a supervisor in a process group of its own, wait for its tree to settle, and kill
 * the whole group without warning.
 *
 * A test cannot `kill -9` the process it is running in, and a supervisor shut down politely
 * is not the case any of this exists for. What survives is the store and the workspaces,
 * and that is all any supervisor after this one is given.
 */
async function killedMidFlight(root: string, records: AgentRecord[]): Promise<void> {
  const config: HarnessConfig = { root, run: RUN, records, until: 'working' };
  // Detached, so it leads a process group of its own and the kill reaches the whole of it
  // rather than only the node process at the top.
  const child = spawn(process.execPath, [HARNESS, JSON.stringify(config)], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let said = '';
  let complained = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (complained += chunk));

  // Latched from the event rather than asked for after the fact. `close` fires once, and a
  // supervisor that dies on its own — which is what a misconfigured record does here — fires
  // it long before the wait below is reached; a listener attached afterwards then never
  // resolves, and a 60s failure naming the cause on `complained` became an opaque 300s
  // timeout naming nothing. That is how the credential error above stayed invisible.
  let closed = false;
  child.on('close', () => (closed = true));

  try {
    await until(
      async () => said.includes('ready') || closed,
      `the tree working (${complained})`,
    );
    if (closed) throw new Error(`the supervisor exited before its tree was working: ${complained}`);
    expect((await running()).sort()).toEqual(records.map((record) => record.id).sort());
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // Already gone, which is the state this was trying to reach anyway.
    }
    if (!closed) await new Promise((resolve) => child.on('close', resolve));
  }

  // The containers outlived it, which is the case the sweep exists for: they are not
  // children of the process that made them, and nothing remains to walk the tree.
  expect((await running()).length).toBe(records.length);
}

describe('a run killed with containers live is swept, and resumes', () => {
  /**
   * A real kill, of a real process group, with real containers running — which is why the
   * supervisor is started in a process of its own. A test cannot `kill -9` the process it is
   * running in, and a supervisor shut down politely is not the case any of this exists for.
   *
   * What survives the kill is the store and the workspaces, and that is all the second
   * supervisor is given: a fresh driver holding no handle on anything, over the same
   * directory.
   */
  it('resumes every agent from records and transcripts alone', async () => {
    const { root } = await aStore();
    const records = [
      aPeerRecord(`${RUN}-held-1`, 'HOLD: go quiet mid-turn.'),
      aPeerRecord(`${RUN}-held-2`, 'HOLD: go quiet mid-turn.', `${RUN}-held-1`),
    ];
    await killedMidFlight(root, records);

    // Everything the next supervisor is given: the store, and a driver holding no handle on
    // anything.
    const reopened = await Store.open(root, RUN);
    opened.push(reopened);
    expect(reopened.ids().sort()).toEqual(records.map((record) => record.id).sort());
    for (const record of records) expect(reopened.agent(record.id).state.status).toBe('working');

    const supervisor = aSupervisor(reopened);
    await supervisor.resume();

    // **Continuing is the condition, and `waiting` is not a stand-in for it.** The child
    // ends its resumed turn by reporting to its parent, and a report to a parent at a turn
    // boundary begins a new turn — so the parent resumes, settles, is woken again by its own
    // child, and is `working` once more. That is the routing behaving exactly as specified;
    // waiting for the whole tree to be `waiting` at one instant waits for something this
    // tree never does, and the peer holds that second turn open forever by design.
    await until(
      async () =>
        (await Promise.all(records.map((record) => reopened.transcript(record.id)))).every((events) =>
          events.some((event) => event.type === 'message'),
        ),
      'both agents continuing where they stopped',
    );

    // Continued from the stored transcript rather than starting over: the peer emitted its
    // continuation because its log already carried steps, and the log now carries both.
    // Checked at the front of the log, since the parent's runs on past it.
    for (const record of records) {
      expect((await reopened.transcript(record.id)).map((event) => event.type).slice(0, 3)).toEqual([
        'charter',
        'usage',
        'message',
      ]);
    }

    await supervisor.shutdown();
    expect(await running()).toEqual([]);
  }, 300_000);

  /**
   * The one line in this change that destroys a day of work if it is wrong, asked of the
   * thing that would actually lose it.
   *
   * The workspaces carry the same `jen.run` label the sweep queries by, so the wrong query
   * finds them — and it would run at the moment after a crash when what is in them is least
   * recoverable.
   */
  it('is swept to nothing, keeps every workspace, and then carries on', async () => {
    const { root } = await aStore();
    const records = [
      aPeerRecord(`${RUN}-alpha`, 'HOLD: go quiet mid-turn.'),
      aPeerRecord(`${RUN}-beta`, 'HOLD: go quiet mid-turn.', `${RUN}-alpha`),
    ];
    await killedMidFlight(root, records);

    // The sweep, from the marking alone, holding a handle on nothing.
    await new DockerSandboxDriver({ run: RUN }).destroyAll();
    expect(await running()).toEqual([]);
    expect(await all()).toEqual([]);

    // Asked for by each agent's own marking rather than by the run's. Workspaces outlive
    // every test in this file — `afterEach` sweeps containers and deliberately not volumes,
    // because keeping them is the property under test — so a run-wide count here counts
    // every earlier test's too and fails on a number that says nothing about this one.
    const workspaces = (
      await Promise.all(
        records.map(async (record) => lines('volume', 'ls', '--filter', `label=jen.agent=${record.id}`, '--format', '{{.Name}}')),
      )
    ).flat();
    expect(workspaces).toHaveLength(2);

    // Resumed after the sweep, each into its own workspace. The peer appends a line every
    // time it starts, so what is read back is the agent's own work from before the kill —
    // planted by nothing the test did.
    const reopened = await Store.open(root, RUN);
    opened.push(reopened);
    const supervisor = aSupervisor(reopened);
    await supervisor.resume();

    // Continuing, not `waiting`, for the reason given on the resume test above.
    await until(
      async () =>
        (await Promise.all(records.map((record) => reopened.transcript(record.id)))).every((events) =>
          events.some((event) => event.type === 'message'),
        ),
      'both agents continuing after the sweep',
    );
    await supervisor.shutdown();

    for (const part of ['alpha', 'beta']) {
      const name = workspaces.find((workspace) => workspace.includes(part));
      expect(name, `${part} has no workspace`).toBeDefined();
      const history = await ask('run', '--rm', '--volume', `${name!}:/w`, IMAGE, 'cat', '/w/history');
      // At least two: the boot before the kill, and the boot after the sweep. **Not exactly
      // two** — how many times a body starts after that is the routing's business and not
      // this test's. A parent torn down at its turn's end is booted again when its child
      // reports, so pinning the count asserts a wake-up sequence in a test about whether the
      // workspace survived. What is being claimed is that the line written before the kill is
      // still there and the agent came back to the same volume to add another.
      expect(history.split('\n').filter((line) => line === 'started').length).toBeGreaterThanOrEqual(2);
    }
  }, 300_000);
});

/**
 * The channel to a body is two pipes with finite buffers, and the process behind them is
 * one thread.
 *
 * Nothing in the double tier can hold this. `Peer` is objects: its standard output accepts
 * whatever is written whether or not anybody reads it, and its standard error is a stream
 * nothing ever puts a byte in — so an unread pipe, which is a thing only a real one can be,
 * is invisible to every other test in this directory. That is exactly how the substrate
 * shipped a run that froze and said nothing about it.
 *
 * It hangs forever against the supervisor as it was, rather than failing, which is the shape
 * of the bug: the supervisor is not wrong about anything, it is waiting for a writer that is
 * waiting for it. The timeout is what turns that into a red test.
 */
describe('a body that writes more than a pipe holds is not left waiting on its reader', () => {
  /** Well past any pipe buffer on any platform, written before the agent does anything else. */
  const FLOOD = 512;

  /**
   * An agent whose standard error nobody reads is an agent that stops.
   *
   * A container runtime carries a process's two output streams over one connection and
   * splits them at this end, so the moment either of this side's pipes fills, *both* stop
   * moving. The supervisor read one of them and left the other with no reader at all — and
   * the process behind it blocks in a write, mid-turn, holding its container, using no CPU,
   * with its stored state still saying `working` and nothing anywhere able to say otherwise.
   */
  it('reads a body that talks on its standard error, and tells its parent what it said', async () => {
    const { store } = await aStore();
    const id = `${RUN}-noisy`;

    const noisy = `
IFS= read -r boot
i=0
while [ $i -lt ${FLOOD} ]; do printf '%512s' '' >&2; i=$((i+1)); done
while IFS= read -r line; do
  case "$line" in
    *'"t":"message"'*)
      printf '%s\\n' '{"t":"event","event":{"type":"usage","at":"2026-01-01T00:00:00.000Z","in":1,"out":1,"model":"sh"}}'
      printf '%s\\n' '{"t":"turn","message":"done","residency":0}'
      ;;
  esac
done
`;
    const heard: string[] = [];
    const supervisor = new Supervisor({
      store,
      driver: new DockerSandboxDriver({ run: RUN }),
      command: ['sh', '-c', noisy],
      onMessage: (message) => heard.push(message.content),
    });

    await supervisor.add(aPeerRecord(id, 'writes a quarter of a megabyte to standard error first'), 'Begin.');
    await until(async () => heard.length > 0, 'the agent finishing its turn after flooding standard error');

    expect(heard).toEqual(['done']);
    await supervisor.shutdown();
  }, 300_000);
});

/**
 * What is left running after a body ends on its own, which is the assertion a double cannot
 * make.
 *
 * `failure.test.ts` holds the mechanism — that `#ended` destroys the sandbox it has just
 * dropped from `#bodies` — but the double decides for itself what a container is, so it
 * cannot say whether one is still up. The leak was found by counting `docker ps` after a
 * live pass, and this is the tier that can count it: three failed turns left three
 * containers `Up`, each idling on the sandbox keepalive, with nothing in `docker events`
 * but the `exec_die`. The exec had died; the container had not. See ENG-216.
 */
describe('a body that fails its turn takes its container with it', () => {
  it('leaves nothing running but the agent still working in a body', async () => {
    const { store } = await aStore();
    const supervisor = aSupervisor(store);
    const chief = `${RUN}-watcher`;
    const doomed = `${RUN}-doomed`;

    // `HOLD` never answers, so the parent keeps its body for the whole test — a control
    // that fails this if the sweep here were indiscriminate, and the agent the report is
    // delivered to.
    await supervisor.add(aPeerRecord(chief, 'HOLD: stay mid-turn and keep the container.'), 'Begin.');
    await supervisor.add(aPeerRecord(doomed, 'DIE: fail the turn the way a provider error does.', chief), 'Begin.');

    // Waited on through the report rather than by polling for a container, because the
    // window this is about is the one between the exec dying and the destroy — the very
    // thing that must be too short to catch. The report is proof the body ran and ended.
    await until(
      async () => store.agent(chief).mailbox.some((message) => message.from === doomed),
      'the ending reaching the parent',
    );
    expect(store.agent(chief).mailbox.at(-1)?.content).toContain('Connection error.');

    // Gone entirely rather than merely stopped: `destroy` is `rm --force`, so a container
    // still listed here at all is one nothing released.
    await until(async () => !(await all()).includes(doomed), 'the failed body’s container being removed');
    expect(await running()).toEqual([chief]);

    // And its workspace is untouched, which is what the report promises the parent: a
    // destroyed body is not a discarded agent.
    expect(await lines('volume', 'ls', '--filter', `label=jen.agent=${doomed}`, '--format', '{{.Name}}')).toHaveLength(1);

    await supervisor.shutdown();
    expect(await running()).toEqual([]);
  }, 300_000);
});
