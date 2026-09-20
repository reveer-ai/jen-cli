/**
 * What the supervisor does with failure, which is turn it into input and nothing else.
 *
 * A child that dies produces nothing, and its parent is suspended waiting on a message that
 * will never arrive — so without this, nothing notices: the parent waits, the tree stops,
 * and no failure is reported anywhere. Delivering the ending as an ordinary message is what
 * lets the parent's weights choose between retrying, replacing, escalating and giving up,
 * none of which the substrate should be choosing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { INTERRUPTED } from '../runtime/events.ts';
import { aRun, TestDriver, until, untilStored, type Run } from './double.ts';
import { SandboxError } from '../sandbox/index.ts';
import { StoreError } from './store.ts';
import { SUBSTRATE } from './index.ts';

import type { Event } from '../runtime/events.ts';
import type { Sandbox, SandboxRequest } from '../sandbox/index.ts';
import type { Message } from './store.ts';

const runs: Run[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.end();
});

const AT = '2026-01-01T00:00:00.000Z';

/**
 * A parent and a child, both booted and both mid-turn.
 *
 * `await` is what almost every test here needs and all any of them needed until a parent
 * had something to do about a child that stopped. Naming the grant keeps the default what
 * it was: a test that has to address a child says so, because the supervisor reads the
 * caller's record before carrying a request out.
 */
async function aPair(tools: string[] = ['await']): Promise<Run> {
  const run = await aRun({ clock: () => Date.parse(AT) });
  runs.push(run);
  await run.supervisor.add(aRecord({ id: 'a', parent: null, tools }), 'Begin.');
  await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a', tools }), 'Look at the tree.');
  return run;
}

/** A driver that cannot provision the agents named, and provisions every other one. */
function withoutBodiesFor(driver: TestDriver, ...bodiless: string[]): () => void {
  const create = driver.create.bind(driver);
  driver.create = async (request: SandboxRequest): Promise<Sandbox> => {
    if (bodiless.includes(request.id)) throw new SandboxError('no daemon');
    return create(request);
  };
  // Handing the original back is what lets a test show an outage ending, which is half of
  // what "reported once per outage" means.
  return () => {
    driver.create = create;
  };
}

/** What the substrate has told this agent, as distinct from what its children have said. */
function reportsTo(run: Run, id: string): Message[] {
  return run.store.agent(id).mailbox.filter((message) => message.substrate === true);
}

describe('an agent that ends without speaking is reported to its parent', () => {
  /**
   * What every ending report says after its `<id>'s body ended: <how>` opening.
   *
   * Spelled once because three tests assert the whole of it, and because what it says is
   * the point rather than incidental: a parent reading a death replaces a child whose
   * transcript and workspace are sitting there intact, and since ENG-216 addressing that
   * child is what gives it a new body. The sentence is the difference between the parent
   * continuing the work and throwing it away.
   */
  const KEPT =
    'Its work is kept: send it a message to have it carry on from where it stopped, in a new ' +
    'body. Replacing it instead discards what it has already done.';

  it('wakes a parent suspended on a child that died', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent suspending');

    child.die({ code: 137, signal: null });
    await parent.until(() => parent.answers().size === 1, 'the parent being woken');

    const answer = parent.answers().get('a:1')!;
    expect(answer.content).toContain("a-1's body ended");
    expect(answer.content).toContain('exit 137');
    // Woken rather than left waiting indefinitely, which is the whole of what this is for.
    expect(run.store.agent('a').state).toEqual({ status: 'working' });
  });

  /**
   * A parent must never be misled about who spoke. The flag carries it through the store and
   * the marker carries it into the text, because a parent reasoning about a report has only
   * the text in front of it.
   */
  it('marks the report as the substrate’s rather than the child’s', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.die({ code: null, signal: 'SIGKILL' });
    await until(() => run.store.agent('a').mailbox.length > 0, 'the report being posted');

    expect(run.store.agent('a').mailbox[0]).toEqual({
      from: 'a-1',
      content: `a-1's body ended: SIGKILL. ${KEPT}`,
      substrate: true,
    });

    parent.answered('Nothing more from me.');
    await parent.until(() => parent.messages().length > 1, 'the report reaching the conversation');
    expect(parent.messages().at(-1)).toBe(`${SUBSTRATE} a-1's body ended: SIGKILL. ${KEPT}`);
  });

  /**
   * The exit says that a child stopped; this is the only thing that ever says why.
   *
   * A runtime that could not read what it was booted with writes one line and ends, and a
   * runtime that failed mid-turn ends the same way — both on the stream the supervisor has
   * to read anyway, because a stream nobody reads is one that fills and stops the process
   * behind it. Having read it, throwing it away would leave a parent choosing between
   * retrying, replacing and escalating on `exit 1`.
   */
  it('carries what the body said on its way out', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.wrote('the boot frame could not be read: record.model.credential names "K"\n');
    child.die({ code: 1, signal: null });
    await until(() => run.store.agent('a').mailbox.length > 0, 'the report being posted');

    const report = run.store.agent('a').mailbox[0]!.content;
    expect(report).toContain("a-1's body ended: exit 1");
    expect(report).toContain('record.model.credential names "K"');
  });

  /** And a body with nothing to say is reported exactly as it always was. */
  it('claims nothing further for a body that said nothing', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.die({ code: null, signal: 'SIGKILL' });
    await until(() => run.store.agent('a').mailbox.length > 0, 'the report being posted');

    expect(run.store.agent('a').mailbox[0]!.content).toBe(`a-1's body ended: SIGKILL. ${KEPT}`);
  });

  it('reports nothing for an agent that spoke and then exited', async () => {
    const run = await aPair();
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // The turn ends, which puts it at a boundary asking for nothing, so its body goes —
    // the ordinary way a body ends, and the one that must not read as a death.
    child.answered('Two files.');
    await until(() => run.driver.latest('a-1')!.destroyed, 'the body ending');

    expect(run.store.agent('a').mailbox).toMatchObject([{ from: 'a-1', content: 'Two files.' }]);
    expect(run.store.agent('a').mailbox.some((message) => message.substrate === true)).toBe(false);
  });

  it('reports nothing for a body the supervisor itself tore down', async () => {
    const run = await aRun({ clock: () => Date.parse(AT) });
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');

    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);
    peer.ask('a:1', 'await', {}, 0);

    await until(() => peer.destroyed, 'the suspension');
    expect(run.toHuman).toEqual([]);
  });
});

/**
 * The two cases that look alike, and the distinction 6.3 is about.
 *
 * A body lost while the supervisor was watching is a death. A supervisor restarting over a
 * store finds **every** agent bodiless, and reading that as a tree of deaths would deliver a
 * termination report for every agent in the run at the moment it was recovering from one.
 */
describe('a supervisor restarting over a store sweeps and resumes rather than mourns', () => {
  it('resumes what was working and synthesizes nothing', async () => {
    const first = await aPair();
    const parent = first.driver.latest('a')!;
    await parent.until(() => parent.messages().length > 0);
    for (const event of [
      { type: 'charter', at: AT, content: aRecord().charter },
      { type: 'message', at: AT, from: 'parent', content: 'Begin.' },
    ] satisfies Event[]) {
      parent.append(event);
    }
    await untilStored(async () => (await first.store.length('a')) === 2, 'the log being stored');

    expect(first.store.agent('a').state).toEqual({ status: 'working' });
    expect(first.store.agent('a-1').state).toEqual({ status: 'working' });
    await first.store.close();

    // A fresh driver, because a killed supervisor's handles do not survive it — which is the
    // reason the sweep is driven by the run's marking rather than by anything remembered.
    const driver = new TestDriver();
    const second = await aRun({ directory: first.directory, driver });
    runs.push(second);
    await second.supervisor.resume();

    expect(driver.sweeps).toBe(1);
    expect(driver.all('a')).toHaveLength(1);
    expect(driver.all('a-1')).toHaveLength(1);
    // Booted on what was stored, so each continues where it stopped.
    expect((JSON.parse(driver.latest('a')!.boot) as { events: Event[] }).events).toHaveLength(2);
    // And nothing was mourned: no termination reached anybody.
    expect(second.toHuman).toEqual([]);
    expect(second.store.agent('a').mailbox).toEqual([]);
  });

  /**
   * `#resume`'s boot loop had the same bare shape as the settling loop, so one agent that
   * could not be provisioned aborted the rescue of every agent after it in `ids()`.
   *
   * It cannot borrow settling's retry: a `working` agent has nothing queued, so no later
   * settle has anything to try for it. What it gets instead is its stored state left exactly
   * as it was, which makes `resume()` idempotent over it — fix the daemon, call it again.
   */
  it('recovers past an agent it cannot boot, reports it, and boots it on the next run', async () => {
    const first = await aPair();
    const parent = first.driver.latest('a')!;
    await parent.until(() => parent.messages().length > 0);
    parent.append({ type: 'charter', at: AT, content: aRecord().charter });
    await untilStored(async () => (await first.store.length('a')) === 1, 'the log being stored');

    const before = first.store.agent('a-1');
    expect(before.state).toEqual({ status: 'working' });
    await first.store.close();

    const driver = new TestDriver();
    const heal = withoutBodiesFor(driver, 'a-1');
    const second = await aRun({ directory: first.directory, driver });
    runs.push(second);
    await second.supervisor.resume();

    // The agent ordered after the failing one was recovered as though nothing happened.
    expect(driver.all('a')).toHaveLength(1);
    expect(driver.all('a-1')).toEqual([]);
    // Its parent was told, by the same path any other agent without a body is reported on.
    expect(reportsTo(second, 'a')).toMatchObject([{ from: 'a-1', substrate: true }]);
    expect(reportsTo(second, 'a')[0]?.content).toContain('a-1 could not be given a body');
    // Left exactly as stored, so there is something for a second attempt to boot.
    expect(second.store.agent('a-1')).toEqual(before);

    heal();
    await second.supervisor.resume();
    expect(driver.all('a-1')).toHaveLength(1);
    // Continued from its own transcript rather than restarted on an empty one.
    expect((JSON.parse(driver.latest('a-1')!.boot) as { owed: boolean }).owed).toBe(true);
  });

  it('leaves every workspace alone while it sweeps', async () => {
    const first = await aPair();
    first.driver.workspace('a').set('notes.md', 'a day of work');
    first.driver.workspace('a-1').set('found.md', 'two files');
    await first.store.close();

    const driver = new TestDriver();
    driver.workspaces.set('a', new Map([['notes.md', 'a day of work']]));
    driver.workspaces.set('a-1', new Map([['found.md', 'two files']]));

    const second = await aRun({ directory: first.directory, driver });
    runs.push(second);
    await second.supervisor.resume();

    expect(driver.workspace('a').get('notes.md')).toBe('a day of work');
    expect(driver.workspace('a-1').get('found.md')).toBe('two files');
    expect(driver.released).toEqual([]);
  });

  it('gives a resumed agent the interruption its log earned, and not a message', async () => {
    const first = await aPair();
    const peer = first.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);
    for (const event of [
      { type: 'charter', at: AT, content: aRecord().charter },
      { type: 'tool_call', at: AT, id: 'c1', name: 'fs', arguments: '{}' },
      { type: 'usage', at: AT, in: 1, out: 1, model: 'scripted' },
    ] satisfies Event[]) {
      peer.append(event);
    }
    await untilStored(async () => (await first.store.length('a')) === 3);
    await first.store.close();

    const second = await aRun({ directory: first.directory, driver: new TestDriver() });
    runs.push(second);
    await second.supervisor.resume();

    // Nothing was appended for it, because nothing arrived — the agent died mid-call, and
    // `answerInterrupted` is exactly right about that.
    const log = await second.store.transcript('a');
    expect(log).toHaveLength(3);
    expect(JSON.stringify(log)).not.toContain(INTERRUPTED);
  });

  /**
   * The row of the design's resume table that nothing else here covers, and the one whose
   * failure is silent.
   *
   * An agent killed between steps leaves a log ending at a complete step — the same shape as
   * a log at a turn boundary — and the stored `working` is the only thing that says it is
   * not one. A body booted without that being passed on takes no step, emits nothing and
   * complains about nothing, while the supervisor holds every message addressed to it for a
   * boundary it will never reach and `stalled` cannot see it, because it is not waiting.
   */
  it('tells a body resumed mid-turn that it owes a step, whatever its log ends in', async () => {
    const first = await aPair();
    const peer = first.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);
    for (const event of [
      { type: 'charter', at: AT, content: aRecord().charter },
      { type: 'message', at: AT, from: 'parent', content: 'Begin.' },
      { type: 'message', at: AT, from: 'self', content: 'Nothing is here.' },
      { type: 'usage', at: AT, in: 1, out: 1, model: 'scripted' },
    ] satisfies Event[]) {
      peer.append(event);
    }
    await untilStored(async () => (await first.store.length('a')) === 4, 'the log being stored');

    // The turn ended in the agent and its end never reached the supervisor, which is the
    // window a kill on a whole process group opens.
    expect(first.store.agent('a').state).toEqual({ status: 'working' });
    await first.store.close();

    const driver = new TestDriver();
    const second = await aRun({ directory: first.directory, driver });
    runs.push(second);
    await second.supervisor.resume();

    expect((JSON.parse(driver.latest('a')!.boot) as { owed: boolean }).owed).toBe(true);
    // And nothing is sent to it, so what it was told on the frame is all it will ever get.
    expect(driver.latest('a')!.received).toEqual([]);
  });
});

describe('the supervisor’s own trouble reaches a human rather than ending the run', () => {
  /**
   * **The failure that would take every agent with it.** Only a `request` frame has an
   * agent-visible answer to fail into, so a failure reached from an event or a turn frame was
   * rethrown out of the listening loop — which is started as a promise nobody holds, and is
   * therefore an unhandled rejection, which under Node's default ends this process. This
   * process is the one holding every other agent in the run.
   *
   * **A store that cannot be written is what is left here.** A body that cannot be
   * provisioned used to reach this too, and no longer does: it is the agent's parent's
   * business now, and the describes below are where it is covered. What remains is what this
   * hook was always for — the supervisor's own trouble, which no agent can act on.
   */
  it('reports a failure reached from a turn frame instead of rejecting into nothing', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // The parent goes dormant, so its child's report has to be written down somewhere — and
    // writing it down is what fails.
    parent.ask('a:1', 'await', {}, 0);
    await until(() => parent.destroyed, 'the parent being torn down');
    const save = run.store.save.bind(run.store);
    run.store.save = async () => {
      throw new Error('the store is gone');
    };

    const unhandled: unknown[] = [];
    const watch = (error: unknown): void => void unhandled.push(error);
    process.on('unhandledRejection', watch);
    try {
      child.answered('here is my report');
      await until(() => run.failures.length > 0, 'the failure being reported');
      // Given time to become one if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', watch);
      run.store.save = save;
    }

    expect(unhandled).toEqual([]);
    expect(run.failures[0]?.agent).toBe('a-1');
    expect((run.failures[0]?.error as Error).message).toBe('the store is gone');
    // The run is still standing: the child that spoke is still being listened to.
    expect(run.driver.latest('a-1')?.destroyed).toBe(false);
  });
});

/**
 * **One agent that cannot be given a body is one agent's trouble.**
 *
 * `#deliver` rethrows when a boot fails — deliberately, having restored the mailbox exactly
 * — and every request the supervisor serves ends in the settling loop that call reaches
 * through. Left bare, that throw failed whichever request happened to be in flight, about
 * whichever agent it happened to be about, and abandoned delivery to every agent ordered
 * after the failing one in `ids()`. Neither is anything anybody chose, and this is where
 * both are held.
 */
describe('one agent without a body does not cost another agent its request', () => {
  it('answers a request made by a different agent, about a different agent', async () => {
    const run = await aRun();
    runs.push(run);
    withoutBodiesFor(run.driver, 'a-1');

    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');
    // Neither of these throws, which is already half of it: `add` ends in the same settle.
    await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a', tools: [] }), 'Look at the tree.');
    await run.supervisor.add(aRecord({ id: 'a-2', parent: 'a', tools: ['send'] }), 'Look at the other one.');

    const peer = run.driver.latest('a-2')!;
    await peer.until(() => peer.messages().length > 0);
    peer.ask('a-2:1', 'send', { to: 'a', content: 'Found it.' });
    await peer.until(() => peer.answers().size === 1, 'the send being answered');

    expect(peer.answers().get('a-2:1')).toEqual({ ok: true, content: 'delivered to a' });
    // And the sibling that could not boot still has exactly what it was sent.
    expect(run.store.agent('a-1').mailbox).toMatchObject([{ from: 'a', content: 'Look at the tree.' }]);
  });

  /**
   * The second consequence, and the one nobody had looked at: the loop aborted rather than
   * carrying on, so a healthy agent simply did not get its message because an unrelated
   * agent elsewhere in the tree could not boot. Which agent that was depended on nothing but
   * the order of `ids()`, so both orders are driven here.
   */
  it('delivers to a healthy agent whichever side of the failing one it falls on', async () => {
    for (const bodiless of ['a-1', 'a-2']) {
      const run = await aRun();
      runs.push(run);
      withoutBodiesFor(run.driver, bodiless);

      await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: [] }), 'Begin.');
      await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a', tools: [] }), 'One.');
      await run.supervisor.add(aRecord({ id: 'a-2', parent: 'a', tools: [] }), 'Two.');

      const healthy = bodiless === 'a-1' ? 'a-2' : 'a-1';
      const peer = run.driver.latest(healthy)!;
      await peer.until(() => peer.messages().length > 0, `${healthy} being woken past ${bodiless}`);

      expect(peer.messages()).toEqual([`[from a] ${healthy === 'a-1' ? 'One.' : 'Two.'}`]);
      expect(run.driver.all(bodiless)).toEqual([]);
    }
  });

  /**
   * The message a failed boot could not carry is not lost, and is not delivered twice.
   *
   * It leaves the mailbox before the boot, and the boot is what consumes it — so a
   * provisioning failure in between would put it in no mailbox, no log and no living
   * process. `#deliver` restores it exactly, which is what makes the next attempt an
   * ordinary delivery rather than a recovery; the only thing that changed here is that the
   * caller is no longer refused for it.
   */
  it('keeps an undelivered message where it was and hands it over exactly once', async () => {
    const run = await aPair();
    const root = run.driver.latest('a')!;
    await root.until(() => root.messages().length > 0);
    root.answered('nothing to report');
    await until(() => root.destroyed, 'the root going dormant');

    const heal = withoutBodiesFor(run.driver, 'a');
    // `tell` promised a message in a mailbox, and there is one. It never claimed a body.
    await expect(run.supervisor.tell('Another thing.')).resolves.toBeUndefined();

    expect(run.store.agent('a').mailbox).toEqual([{ from: null, content: 'Another thing.' }]);
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: null });
    expect(run.driver.all('a')).toHaveLength(1);

    // The daemon comes back, and the first attempt that succeeds is the one that delivers.
    heal();
    await run.supervisor.tell('And another.');
    const woken = run.driver.latest('a')!;
    await woken.until(() => woken.messages().length > 0, 'the held message finally landing');

    expect(woken.messages()).toEqual(['[from the human] Another thing.']);
    // The second is still queued behind it, because the agent it is for is mid-turn — which
    // is the ordinary path and not anything this failure did.
    expect(run.store.agent('a').mailbox).toEqual([{ from: null, content: 'And another.' }]);
  });
});

/**
 * **A body that cannot be provisioned is the parent's news, on the same terms as a death.**
 *
 * `#ended` already turns a body that stopped into a message in the parent's mailbox, and
 * leaves retrying, replacing, escalating and giving up to the parent's weights. From the
 * parent's side a body that never started is the same fact, so it takes the same path —
 * and not `onFailure`, which is for what no agent can act on.
 */
describe('an agent whose body cannot be provisioned is reported to its parent', () => {
  /** A parent, resident and mid-turn, over a child that will not boot. */
  async function aParentOverABodilessChild(tools: string[] = []): Promise<Run> {
    const run = await aRun();
    runs.push(run);
    withoutBodiesFor(run.driver, 'a-1');
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools }), 'Begin.');
    const parent = run.driver.latest('a')!;
    await parent.until(() => parent.messages().length > 0);
    await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a', tools: [] }), 'Look at the tree.');
    return run;
  }

  it('names the child and the failure, in the substrate’s own voice and not as a death', async () => {
    const run = await aParentOverABodilessChild();
    const parent = run.driver.latest('a')!;

    // Queued while the parent is mid-turn, and handed over by the ordinary path once it is
    // back at a boundary — the same two paths every other message takes.
    expect(reportsTo(run, 'a')).toMatchObject([{ from: 'a-1', substrate: true }]);
    parent.answered('nothing yet');
    await parent.until(() => parent.messages().length > 1, 'the report reaching the parent');

    const report = parent.messages()[1]!;
    // Marked as the substrate's, so a parent reasoning about it never reads it as the words
    // of the child it is about.
    expect(report.startsWith(SUBSTRATE)).toBe(true);
    expect(report).toContain('a-1 could not be given a body');
    expect(report).toContain('no daemon');

    // **Not a death**, which is the one reading that would do harm: a parent that believed
    // it would replace a child that is about to wake up fine.
    expect(report).not.toContain('terminated');
    expect(report).toContain('is not gone');
    expect(report).toContain('still addressable');
    // **And not a loss**, which is the other: a parent that believed its message had gone
    // would send it again, waking the child to two copies of its instruction.
    expect(report).toContain('still queued');

    // The supervisor's own hook is untouched by any of it.
    expect(run.failures).toEqual([]);
  });

  it('reports once for one outage, and again for the next one', async () => {
    const run = await aRun();
    runs.push(run);
    let bodiless = true;
    const create = run.driver.create.bind(run.driver);
    run.driver.create = async (request: SandboxRequest): Promise<Sandbox> => {
      if (bodiless && request.id === 'a-1') throw new SandboxError('no daemon');
      return create(request);
    };

    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['send'] }), 'Begin.');
    const parent = run.driver.latest('a')!;
    await parent.until(() => parent.messages().length > 0);
    await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a', tools: [] }), 'Look at the tree.');
    expect(reportsTo(run, 'a')).toHaveLength(1);

    // The child is retried inside every settle, and every settle is every request. The
    // parent hears about the outage, not about each attempt on it.
    await run.supervisor.tell('Again.');
    await run.supervisor.tell('And again.');
    expect(reportsTo(run, 'a')).toHaveLength(1);

    // Reached — which is what ends the episode, and what the mark is cleared by.
    bodiless = false;
    await run.supervisor.tell('Once more.');
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0, 'the child finally waking');
    child.answered('had a look');
    await until(() => child.destroyed, 'the child going dormant again');
    expect(reportsTo(run, 'a')).toHaveLength(1);

    // And lost again. A second episode is a real transition, so it is a second report.
    bodiless = true;
    parent.ask('a:1', 'send', { to: 'a-1', content: 'One more thing.' });
    await until(() => reportsTo(run, 'a').length === 2, 'the second episode being reported');
    expect(parent.answers().get('a:1')).toEqual({ ok: true, content: 'delivered to a-1' });
  });

  /**
   * **The boundary of what settling catches, which is one class and not "a boot went
   * wrong".**
   *
   * `#deliver` reaches the store three times on the way to a body — the `save` that takes
   * the message out of the mailbox, `#answerInLog`'s read, and the `transcript` read inside
   * `#boot` — and a bare catch in the settling loop takes all three. What comes out of it
   * then is a parent told `<id> could not be given a body: the store is gone`: a claim about
   * the machine, handed to the one party with no reach into it, and an invitation to retry
   * or replace a child that is not the thing that is broken. The id would be marked
   * unreachable with it, so the stall read would discount its mail, and `onFailure` — whose
   * whole remit this is — would never hear about it at all.
   *
   * So the catch is typed and the type is applied in `#boot`, around the driver's own calls
   * and nothing else. These two drive the two store reads on either side of it.
   */
  it('lets a store failure under a boot leave by its own route, not as a missing body', async () => {
    const run = await aRun();
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: [] }), 'Begin.');
    const root = run.driver.latest('a')!;
    await root.until(() => root.messages().length > 0);
    root.answered('nothing to report');
    await until(() => root.destroyed, 'the root going dormant');

    // The daemon is fine. It is `#boot`'s own transcript read that is not.
    const transcript = run.store.transcript.bind(run.store);
    run.store.transcript = async () => {
      throw new StoreError('the store is gone');
    };

    // The request in flight is refused with what actually happened, which is where a store
    // failure went before settling learned to catch anything.
    await expect(run.supervisor.tell('Another thing.')).rejects.toThrow('the store is gone');
    expect(run.toHuman.filter((message) => message.substrate === true)).toEqual([]);
    expect(run.failures).toEqual([]);

    // And nothing was marked: "unreachable" means no body and no way to get one, which is
    // not what a store that cannot be read is a report of. So the pending message still
    // counts as work about to happen.
    expect(run.supervisor.stalled).toBe(false);
    expect(run.store.agent('a').mailbox).toEqual([{ from: null, content: 'Another thing.' }]);

    // The message survived the failure exactly as a failed boot leaves it, so the next
    // attempt is an ordinary delivery.
    run.store.transcript = transcript;
    await run.supervisor.tell('And another.');
    const woken = run.driver.latest('a')!;
    await woken.until(() => woken.messages().length > 0, 'the held message landing');
    expect(woken.messages()).toEqual(['[from the human] Another thing.']);
  });

  it('carries a store failure with no request behind it to onFailure', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // The parent goes dormant awaiting its child, so delivering the child's report means
    // writing the answer into the parent's log — and reading that log is what fails.
    parent.ask('a:1', 'await', {}, 0);
    await until(() => parent.destroyed, 'the parent being torn down');
    run.store.transcript = async () => {
      throw new StoreError('the store is gone');
    };

    // A turn frame has no request id to fail into, so this is the path that used to become
    // an unhandled rejection and end the process holding every agent in the run.
    child.answered('here is my report');
    await until(() => run.failures.length > 0, 'the failure reaching the hook');

    expect(run.failures[0]?.agent).toBe('a-1');
    expect((run.failures[0]?.error as Error).message).toBe('the store is gone');
    // Not the parent's business and never dressed up as one.
    expect(reportsTo(run, 'a')).toEqual([]);
    expect(run.toHuman.filter((message) => message.substrate === true)).toEqual([]);
  });

  it('reports a root that cannot be provisioned to the human', async () => {
    const run = await aRun();
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: [] }), 'Begin.');
    const root = run.driver.latest('a')!;
    await root.until(() => root.messages().length > 0);
    root.answered('nothing to report');
    await until(() => root.destroyed, 'the root going dormant');

    withoutBodiesFor(run.driver, 'a');
    await run.supervisor.tell('Another thing.');

    // The root's parent is the human, reached by `#post(null, …)` — the same path that
    // carries the root's own messages out. No special case for the agent nobody spawned.
    const report = run.toHuman.at(-1)!;
    expect(report).toMatchObject({ from: 'a', substrate: true });
    expect(report.content).toContain('a could not be given a body');
  });
});

describe('a stalled tree is surfaced and never resolved', () => {
  it('reports every agent waiting with nothing pending', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    // The ordinary shape of it: a parent waiting on a child that is waiting on the parent.
    parent.ask('a:1', 'await', {}, 60_000);
    child.ask('a-1:1', 'await', {}, 60_000);

    await until(() => run.stalls.length > 0, 'the deadlock being surfaced');
    expect(run.stalls.at(-1)?.waiting.toSorted()).toEqual(['a', 'a-1']);
    // Nothing stopped: this is the ordinary deadlock, two agents each waiting on the other.
    expect(run.stalls.at(-1)?.stopped).toEqual([]);
    expect(run.supervisor.stalled).toBe(true);
  });

  it('wakes, messages and terminates nobody when it finds one', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    child.ask('a-1:1', 'await', {}, 60_000);
    await until(() => run.stalls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Breaking a deadlock is a judgment about the work, and the human is who the substrate
    // has for that.
    expect(parent.answers().size).toBe(0);
    expect(child.answers().size).toBe(0);
    expect(parent.messages()).toHaveLength(1);
    expect(run.store.agent('a-1').state.status).toBe('waiting');
    expect(run.driver.live).toHaveLength(2);
  });

  it('does not report a run with a message still pending', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    // The child answers while the parent is still mid-turn, so the message sits in the
    // parent's mailbox — every agent is waiting and delivery will wake one.
    child.answered('Two files.');
    await until(() => run.store.agent('a').mailbox.length > 0, 'the message being posted');
    parent.ask('a:1', 'await', {}, 60_000);

    await parent.until(() => parent.answers().size === 1, 'the pending message being delivered');
    expect(run.stalls).toEqual([]);
    expect(run.supervisor.stalled).toBe(false);
  });

  /**
   * **The backstop for a parent that was told and did nothing about it.**
   *
   * A pending message counts as work about to happen on the grounds that delivery will wake
   * somebody. Where delivery is what failed, that grounds is gone — and counting it anyway
   * reports a tree that has stopped as a tree that is working, through the very door this
   * read exists to close.
   */
  it('reports a tree stopped by an agent that cannot be provisioned', async () => {
    const run = await aRun();
    runs.push(run);
    withoutBodiesFor(run.driver, 'a-1');

    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');
    const parent = run.driver.latest('a')!;
    await parent.until(() => parent.messages().length > 0);
    await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a', tools: [] }), 'Look at the tree.');

    // The parent is told its child has no body, which is the thing it can act on.
    parent.ask('a:1', 'await', {}, 60_000);
    await parent.until(() => parent.answers().size === 1, 'the report reaching the parent');
    expect(parent.answers().get('a:1')?.content).toContain('a-1 could not be given a body');

    // It does nothing about it and waits again, which is its right. Now every agent is
    // suspended and the one thing pending cannot wake anyone.
    parent.ask('a:2', 'await', {}, 60_000);
    await until(() => run.stalls.length > 0, 'the stopped tree being surfaced');

    expect(run.supervisor.stalled).toBe(true);
    // Surfaced, and not resolved: the undeliverable message is still exactly where it was.
    expect(run.store.agent('a-1').mailbox).toMatchObject([{ from: 'a', content: 'Look at the tree.' }]);
  });

  /**
   * A timer only decides whether a body stays up; it can never produce a message. So a
   * stalled tree is stalled whether or not one is armed, and waiting for timers to expire
   * before saying so would delay the diagnosis and change nothing about it.
   */
  it('reaches the same verdict whatever residency the agents named', async () => {
    for (const residency of [0, 60_000]) {
      const run = await aPair();
      const parent = run.driver.latest('a')!;
      const child = run.driver.latest('a-1')!;
      await parent.until(() => parent.messages().length > 0);

      parent.ask('a:1', 'await', {}, residency);
      child.ask('a-1:1', 'await', {}, residency);

      await until(() => run.stalls.length > 0, `a deadlock with residency ${residency}`);
      expect(run.supervisor.stalled).toBe(true);
    }
  });
});

describe('a stalled tree is surfaced even where nobody said where to put it', () => {
  /**
   * A default of silence would make a stalled tree indistinguishable from a working one for
   * every caller that has not thought about it — which is the one outcome the requirement
   * exists to prevent. What "surfaced" should eventually mean is open; nothing is not among
   * the candidates.
   */
  it('says so on standard error when no caller named a destination', async () => {
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const run = await aRun({ clock: () => Date.parse(AT), onStalled: null });
      runs.push(run);
      await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');

      const peer = run.driver.latest('a')!;
      await peer.until(() => peer.messages().length > 0);
      peer.ask('a:1', 'await', {}, 60_000);

      await until(() => said.some((line) => line.includes('is waiting and nothing is pending')), 'the report');
    } finally {
      process.stderr.write = write;
    }
  });
});

/**
 * A turn that failed, end to end: the report that reaches the parent, and the thing the
 * parent can do about it.
 *
 * **This is the test that would have caught ENG-216.** A turn that threw was recorded in
 * the runtime and said to nobody, and the runtime then waited on a frame the supervisor
 * would never send, because it holds a working agent's mail for a turn boundary that turn
 * would never reach. `runtime/entry.test.ts` holds the runtime's half — that such a turn
 * ends the process with its reason on standard error. This is the supervisor's: that the
 * ending becomes a report its parent can act on, and that acting on it works.
 *
 * Both halves are needed and neither is sufficient. Exiting without revival tells a parent
 * its child stopped and leaves it unable to do the first thing the report invites;
 * revival without exiting leaves the failed turn sitting in a live body saying nothing.
 */
describe('a turn that fails reaches the parent, and the parent can continue the child', () => {
  it('reports the provider failure and revives the child on the parent’s word', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent suspending');

    // What the runtime now does with a turn it cannot complete: the reason on standard
    // error, and the process ends. A 429 or a 5xx past the SDK's retries is the ordinary
    // way to arrive here at ten-plus concurrent containers.
    child.wrote('Connection error.\n');
    child.die({ code: 1, signal: null });

    await parent.until(() => parent.answers().size === 1, 'the parent being woken');
    const report = parent.answers().get('a:1')!.content;
    expect(report).toContain("a-1's body ended");
    // The account the parent chooses on. Without it the choice is made on `exit 1`.
    expect(report).toContain('Connection error.');
    // And the report says the choice exists at all, which is the half that used to be a lie.
    expect(report).toContain('Its work is kept');

    // It takes the option the report names, and the substrate carries it out.
    parent.ask('a:2', 'send', { to: 'a-1', content: 'Try that again.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being given a new body');

    const revived = run.driver.latest('a-1')!;
    expect((JSON.parse(revived.boot) as { owed: boolean }).owed).toBe(true);
    revived.answered('Done, second time around.');
    await revived.until(() => revived.messages().length > 0, 'the message at the boundary');
    expect(revived.messages()).toEqual(['[from a] Try that again.']);
  });

  it('reports a revival that cannot be provisioned and loses nothing', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 1, 'the ending reaching the parent');
    const stored = run.store.agent('a-1');

    withoutBodiesFor(run.driver, 'a-1');
    parent.ask('a:1', 'send', { to: 'a-1', content: 'Carry on.' });
    await until(() => reportsTo(run, 'a').length === 2, 'the failed revival being reported');

    expect(reportsTo(run, 'a')[1]?.content).toContain('a-1 could not be given a body');
    // **The branch writes nothing before it boots**, so a failure leaves the store exactly
    // as it found it: the message still queued, the agent still owed its step, and a
    // second attempt possible the moment anything addresses it again.
    expect(run.store.agent('a-1')).toEqual({ ...stored, mailbox: [{ from: 'a', content: 'Carry on.' }] });
    expect(run.driver.all('a-1')).toHaveLength(1);
  });
});

/**
 * What bounds revival, once revival exists.
 *
 * A revival leaves its message pending — an agent continuing an unfinished turn is not at
 * the boundary where a message begins one — so the message that caused one is still at the
 * head of the mailbox when the new body dies, and `#ended` → `#settle` → `#deliver` reads
 * it as a fresh instruction. Triggering on mail rules out a settle reviving unbidden; it
 * does not rule this out. Unbounded, one parent message costs a sandbox, a boot, a model
 * call and another substrate report per death, in a loop the stall read cannot see, because
 * the message driving it reads as work about to happen. A revival answers the message that
 * caused it, so a further revival wants a further message. See ENG-216.
 */
describe('a revival answers one message, and a further one wants a further message', () => {
  it('gives one body per message, however many of them die', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 1, 'the first ending reaching the parent');

    parent.ask('a:1', 'send', { to: 'a-1', content: 'Carry on.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being given a new body');

    // The second body dies exactly as the first did, without ever reaching a boundary —
    // which is the shape a bad credential or a sustained 429 produces, and the one where a
    // parent most wants to be told to stop.
    run.driver.latest('a-1')!.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 2, 'the second ending reaching the parent');

    // Every settle is another chance to re-read the pending message as an instruction. It
    // is not one: it bought the body that has just died. Suspending the parent onto each of
    // the two reports it is holding is what makes the settles happen, and waiting for the
    // answers is what makes them have finished before anything below is read.
    parent.ask('a:2', 'await', {}, 60_000);
    await parent.until(() => parent.answers().size === 1, 'the first report reaching the parent');
    parent.ask('a:3', 'await', {}, 60_000);
    await parent.until(() => parent.answers().size === 2, 'the second report reaching the parent');

    expect(run.driver.all('a-1')).toHaveLength(2);
    // **And what is pending still is.** The bound is on how many bodies one message buys,
    // not on the message, which is still there for the boundary the agent may yet reach.
    expect(run.store.agent('a-1').mailbox).toEqual([{ from: 'a', content: 'Carry on.' }]);
  });

  it('gives another body when the parent says so again', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 1, 'the first ending reaching the parent');

    parent.ask('a:1', 'send', { to: 'a-1', content: 'Carry on.' });
    await until(() => run.driver.all('a-1').length === 2, 'the first revival');
    run.driver.latest('a-1')!.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 2, 'the second ending reaching the parent');

    // A second decision, which is the only thing that buys a second body. No counter and no
    // timer: what re-arms it is a parent choosing to spend a turn saying so again.
    parent.ask('a:2', 'send', { to: 'a-1', content: 'Once more.' });
    await until(() => run.driver.all('a-1').length === 3, 'the second revival');

    expect((JSON.parse(run.driver.latest('a-1')!.boot) as { owed: boolean }).owed).toBe(true);
    // Both messages are still queued, in the order they were sent, for the boundary this
    // body may reach.
    expect(run.store.agent('a-1').mailbox).toEqual([
      { from: 'a', content: 'Carry on.' },
      { from: 'a', content: 'Once more.' },
    ]);
  });

  it('counts an agent holding mail it will not be revived for as stopped', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent suspending');
    child.die({ code: 1, signal: null });
    await parent.until(() => parent.answers().size === 1, 'the ending reaching the parent');

    parent.ask('a:2', 'send', { to: 'a-1', content: 'Carry on.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being given a new body');
    parent.ask('a:3', 'await', {}, 60_000);
    run.driver.latest('a-1')!.die({ code: 1, signal: null });
    await parent.until(() => parent.answers().size === 2, 'the second ending reaching the parent');

    // The parent does nothing further, which is its right. Everything is now waiting or
    // stopped, and the only thing pending anywhere is a message that will not produce
    // another body.
    parent.ask('a:4', 'await', {}, 60_000);
    await until(() => run.stalls.length > 0, 'the stopped tree being surfaced');

    expect(run.supervisor.stalled).toBe(true);
    // **Naming the cause, and reaching the report at all.** Without the bound this run
    // never arrives here: the pending message revives the child forever, and `#cannotMove`
    // reads that same message as work about to happen every time it is asked.
    expect(run.stalls.at(-1)).toEqual({ waiting: ['a'], stopped: ['a-1'] });
  });
});

/**
 * The stall read, once "cannot move" has to cover an agent with no body.
 *
 * One condition — nothing to act on, and not working in a body — covering three shapes:
 * the agent suspended with an empty mailbox, the agent whose mail cannot be delivered
 * because nothing can be provisioned for it, and the agent left with no body and nothing
 * pending to give it one. The last is the backstop, and it holds whatever ended that agent,
 * including causes nobody has found yet. Before it, one body that died and whose parent did
 * not happen to `stop` it made `onStalled` unable to fire for the rest of the session,
 * because every live agent had to be `waiting` — disabling the detector for this entire
 * class at the moment it was needed. See ENG-216.
 */
describe('an agent that cannot be reached at all is counted as stopped', () => {
  /**
   * The three pairs the predicate has to tell apart, two of which look alike in the store.
   *
   * A second supervisor over the same store is how the middle one is held still: with the
   * first one running, an agent that has no body and has mail is revived by the settle that
   * notices, so the state exists for no longer than a delivery. Here nothing has settled
   * yet, which is the same position the getter is in when it is read from a test.
   */
  it('counts a bodiless agent by whether anything is pending for it', async () => {
    const first = await aPair();
    const parent = first.driver.latest('a')!;
    const child = first.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // Each body takes down the message it was given, which is what a real turn's first act
    // is. Without it a shutdown puts the unacknowledged message back and leaves the agent
    // `waiting` — a different state from the one under test, and the one `suspend.test.ts`
    // is about.
    for (const body of [parent, child]) {
      body.append({ type: 'message', at: 't', from: 'parent', content: 'Begin.' });
    }
    await untilStored(async () => (await first.store.length('a-1')) === 1, 'the message being recorded');
    await untilStored(async () => (await first.store.length('a')) === 1, 'the message being recorded');

    // **Working in a body**: a turn in flight, which is the one shape of `working` that can
    // move on its own.
    expect(first.supervisor.stalled).toBe(false);
    await first.end();

    const second = await aRun({ directory: first.directory });
    runs.push(second);
    expect(second.store.agent('a-1').state).toEqual({ status: 'working' });

    // **No body and nothing pending**: nothing will give this agent one, because revival is
    // triggered by mail and by nothing else.
    expect(second.supervisor.stalled).toBe(true);

    // **No body but mail**: delivery will give it one on the next pass, so this is work
    // about to happen rather than a tree that has stopped.
    const stored = second.store.agent('a-1');
    await second.store.save('a-1', { ...stored, mailbox: [{ from: 'a', content: 'Carry on.' }] });
    expect(second.supervisor.stalled).toBe(false);
  });

  it('names the agent that stopped, apart from the ones that are waiting', async () => {
    const run = await aPair();
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent suspending');

    child.die();
    await parent.until(() => parent.answers().size === 1, 'the ending reaching the parent');
    // The parent is working again on what it was told, so nothing is stalled yet.
    expect(run.supervisor.stalled).toBe(false);

    // It does nothing about the child, which is its right, and waits again.
    parent.ask('a:2', 'await', {}, 60_000);
    await until(() => run.stalls.length > 0, 'the stopped tree being surfaced');

    expect(run.supervisor.stalled).toBe(true);
    // **The cause, named apart from the agent that is merely behaving.** A report listing
    // both as waiting would send a person to look at the parent, which is doing exactly
    // what it should.
    expect(run.stalls.at(-1)).toEqual({ waiting: ['a'], stopped: ['a-1'] });
  });
});

/**
 * What a body that ends by itself leaves behind, which has to be nothing.
 *
 * `#ended` and `#suspend` are the two places a body leaves `#bodies`, and until ENG-216's
 * live pass only one of them destroyed the sandbox. That went unseen because it was almost
 * unreachable: a turn that threw used to leave the runtime alive-but-idle, so `#ended` never
 * ran and the body sat in `#bodies` where a shutdown would suspend it. Giving the runtime a
 * single exit path turned *hung but tracked* into *exited and orphaned*, and at the rate this
 * change is about — a 429 past the SDK's retries — that is a container leaked per provider
 * error, each holding a keepalive that will sleep until the daemon is restarted.
 *
 * The tier said nothing, at 477 green, because nothing in it asked what was left running.
 */
describe('a body that ends leaves no sandbox behind, whichever way it ended', () => {
  it('releases the container of a body that died, and of every body after it', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    child.wrote('Connection error.\n');
    child.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 1, 'the ending reaching the parent');

    // **Counted the way the live pass counted it**: what is still running, not what was
    // reported. Three reports and three live containers is exactly the shape that passed.
    expect(run.driver.live.map((peer) => peer.agent)).toEqual(['a']);

    // And it stays true across the revival path, which is where a parent that keeps
    // answering turns one leak into one per message.
    parent.ask('a:1', 'send', { to: 'a-1', content: 'Try that again.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being given a new body');
    run.driver.latest('a-1')!.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 2, 'the second ending reaching the parent');

    expect(run.driver.all('a-1')).toHaveLength(2);
    expect(run.driver.live.map((peer) => peer.agent)).toEqual(['a']);
  });

  /**
   * The return `#ended` takes before it reports anything, and the reason the destroy is
   * above every one of them.
   *
   * An agent that spoke before its body ended is `waiting`, so this is not a death and
   * nothing is delivered to its parent — but the container is as orphaned as any other, and
   * a fix placed beside the report would have missed it.
   */
  it('releases the container of a body whose agent had already spoken', async () => {
    const run = await aPair();
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    child.answered('Looked. Nothing to report.');
    await until(() => run.store.agent('a-1').state.status === 'waiting', 'the child reaching a boundary');

    child.die({ code: 0, signal: null });
    await until(() => !run.driver.live.includes(child), 'the container being released');

    // Not a death: its parent is told nothing, which is what it was told before this change.
    expect(reportsTo(run, 'a-1')).toEqual([]);
    expect(run.store.agent('a-1').state).toEqual({ status: 'waiting', request: null });
  });

  /**
   * A destroy that fails is the one case the sweep exists for, and it is also the case that
   * must not be silent.
   *
   * There is no caller to fail and no outcome to report it in, so the alternative to
   * `onFailure` is a container held for the rest of the run with nobody able to say so —
   * which is this task's own shape. The report to the parent still goes out, because the
   * destroy's failure is the supervisor's trouble rather than the parent's.
   */
  it('reports a destroy it could not do, and sweeps it at shutdown', async () => {
    const run = await aPair(['await', 'send']);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    // Every sandbox this child is given from here refuses to be destroyed. The one it is
    // already in was made before this, so the refusal wants the revival's body.
    const create = run.driver.create.bind(run.driver);
    run.driver.create = async (request: SandboxRequest): Promise<Sandbox> => {
      const sandbox = await create(request);
      if (request.id !== 'a-1') return sandbox;
      return {
        exec: async (command, options) => sandbox.exec(command, options),
        destroy: async () => {
          throw new SandboxError('no daemon');
        },
      };
    };

    child.die({ code: 1, signal: null });
    await until(() => reportsTo(run, 'a').length === 1, 'the ending reaching the parent');
    parent.ask('a:1', 'send', { to: 'a-1', content: 'Try that again.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being given a new body');

    const stubborn = run.driver.latest('a-1')!;
    stubborn.die({ code: 1, signal: null });
    await until(() => run.failures.length > 0, 'the destroy being reported');

    expect(run.failures.at(-1)?.agent).toBe('a-1');
    expect(String((run.failures.at(-1)?.error as Error).message)).toContain('no daemon');
    // Held, because nothing could end it — and out of `#bodies`, so the shutdown loop cannot
    // reach it either. The sweep is what is left.
    expect(run.driver.live).toContain(stubborn);

    await run.supervisor.shutdown();
    expect(run.driver.sweeps).toBe(1);
    expect(run.driver.live).toEqual([]);
  });
});
