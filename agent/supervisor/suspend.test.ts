/**
 * Suspension and resumption, which is the decision the whole economic argument rests on —
 * and the collision it has to get right.
 *
 * **A deliberately suspended `await` and a process killed mid-call leave the stored log in
 * exactly the same shape**: a call with no result. `answerInterrupted` runs on every
 * construction and cannot tell them apart, so a naively resumed agent is told its `await`
 * was interrupted, reasons about a failure that never happened, and leaves a transcript
 * that looks fine. Nothing errors. The tests below are the only thing that would notice.
 *
 * The peer stands in for a runtime and does not reason, so the assertions that are about
 * what a *model* would be sent are made by constructing a real `Runtime` over the log the
 * supervisor stored. That is the same projection the resumed agent would use, on the same
 * bytes, which is what makes it the question rather than a proxy for it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { aRecord, scripted } from '../fixture.ts';
import { INTERRUPTED } from '../runtime/events.ts';
import { Runtime } from '../runtime/index.ts';
import { aRun, until, untilStored, type Peer, type Run } from './double.ts';

import type { Event } from '../runtime/events.ts';

const runs: Run[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.end();
});

const AT = '2026-01-01T00:00:00.000Z';

/** The log of an agent that was told something and has called a capability. */
function calling(id = 'c1', name = 'await'): Event[] {
  return [
    { type: 'charter', at: AT, content: aRecord().charter },
    { type: 'message', at: AT, from: 'parent', content: 'Begin.' },
    { type: 'tool_call', at: AT, id, name, arguments: '{}' },
    { type: 'usage', at: AT, in: 10, out: 4, model: 'scripted' },
  ];
}

/** The log of an agent that has answered: a complete step, and nothing outstanding in it. */
function ended(): Event[] {
  return [
    { type: 'charter', at: AT, content: aRecord().charter },
    { type: 'message', at: AT, from: 'parent', content: 'Begin.' },
    { type: 'message', at: AT, from: 'self', content: 'Nothing is here.' },
    { type: 'usage', at: AT, in: 10, out: 4, model: 'scripted' },
  ];
}

/** What a model would be sent if this log were booted right now. */
function wouldSend(events: readonly Event[]): string {
  return JSON.stringify(
    new Runtime({
      record: aRecord({ id: 'a' }),
      events,
      client: scripted([]),
      clock: () => Date.parse(AT),
    }).request(),
  );
}

/** A root that has been told to begin and has reached a capability call. */
async function atACall(residency = 0): Promise<{ run: Run; peer: Peer }> {
  const run = await aRun({ clock: () => Date.parse(AT) });
  runs.push(run);
  await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');

  const peer = run.driver.latest('a')!;
  await peer.until(() => peer.messages().length > 0);
  for (const event of calling()) peer.append(event);
  peer.ask('a:1', 'await', {}, residency);
  return { run, peer };
}

describe('a message delivered to a dormant agent answers the call it suspended on', () => {
  it('appends the answer to the stored log before anything boots', async () => {
    const { run, peer } = await atACall();
    await until(() => peer.destroyed, 'the body being torn down');
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: 'a:1' });

    await run.supervisor.tell('Two files.');
    await until(() => run.driver.all('a').length === 2, 'the agent being woken');

    const log = await run.store.transcript('a');
    expect(log.at(-1)).toEqual({
      type: 'tool_result',
      at: AT,
      id: 'c1',
      content: '[from the human] Two files.',
      ok: true,
      ms: 0,
    });

    // And the body that was provisioned was booted on exactly that log, rather than on one
    // the supervisor kept to itself.
    const boot = JSON.parse(run.driver.latest('a')!.boot) as { events: Event[] };
    expect(boot.events).toEqual(log);
  });

  /**
   * **This is the test the design is built around.** Remove the write-before-boot and the
   * supervisor still suspends, still resumes, still delivers — and the agent is told its
   * call was interrupted instead of being told what arrived. Nothing else in this suite
   * fails.
   */
  it('sends the model the message, and not the text for a call that was interrupted', async () => {
    const { run, peer } = await atACall();
    await until(() => peer.destroyed);

    await run.supervisor.tell('Two files.');
    await until(() => run.driver.all('a').length === 2);

    const request = wouldSend(await run.store.transcript('a'));
    expect(request).toContain('Two files.');
    expect(request).not.toContain(INTERRUPTED);
  });

  /** The other half of the pair: fixing the above must not have disabled it. */
  it('still synthesizes an interruption for an agent that died mid-call', async () => {
    const run = await aRun({ clock: () => Date.parse(AT) });
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');

    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);
    for (const event of calling()) peer.append(event);
    await untilStored(async () => (await run.store.length('a')) === 4, 'the whole log being stored');

    // Killed while its state still says working: it never spoke, and the log ends in a call
    // nobody answered — the same shape a suspension leaves, distinguished only by the state.
    expect(run.store.agent('a').state).toEqual({ status: 'working' });
    peer.die();
    await until(() => run.toHuman.length > 0, 'the death being reported');

    const request = wouldSend(await run.store.transcript('a'));
    expect(request).toContain(INTERRUPTED);
  });
});

/**
 * The supervisor's half of a question the runtime cannot answer for itself.
 *
 * A log ending at a complete step is a log at a turn boundary and a log of a turn whose end
 * nobody heard, and which one it is lives here, in the stored state, because that is where
 * the design put it rather than leaving it to be inferred. Each of the three ways a body is
 * booted answers it, and the runtime's half — that it does the right thing with either
 * answer — is `runtime/entry.test.ts`'s.
 */
describe('a booted body is told whether it owes the model a step', () => {
  /** What the supervisor wrote on the frame the body actually booted on. */
  function owedOf(run: Run, id: string): boolean {
    return (JSON.parse(run.driver.latest(id)!.boot) as { owed: boolean }).owed;
  }

  it('says so where the answer to the call it suspended on is already in its log', async () => {
    const { run, peer } = await atACall();
    await until(() => peer.destroyed, 'the body being torn down');

    await run.supervisor.tell('Two files.');
    await until(() => run.driver.all('a').length === 2, 'the agent being woken');

    // Nothing is coming on the channel — the message went into the log — so a body that
    // waited to be told something would wait forever.
    expect(owedOf(run, 'a')).toBe(true);
    expect(run.driver.latest('a')!.messages()).toEqual([]);
  });

  it('says the opposite where a message follows on the channel', async () => {
    const run = await aRun({ clock: () => Date.parse(AT) });
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');

    const first = run.driver.latest('a')!;
    await first.until(() => first.messages().length > 0);
    // A turn that ended: content with nothing outstanding, and the step's cost after it. The
    // log now ends exactly where a log killed between steps ends, which is the whole point.
    for (const event of ended()) first.append(event);
    first.answered('Nothing is here.');
    await until(() => first.destroyed, 'the body being torn down');

    await run.supervisor.tell('Try again.');
    await until(() => run.driver.all('a').length === 2, 'the agent being woken');

    expect(owedOf(run, 'a')).toBe(false);
    await run.driver.latest('a')!.until((): boolean => run.driver.latest('a')!.messages().length > 0);
    expect(run.driver.latest('a')!.messages()).toEqual(['[from the human] Try again.']);
  });
});

describe('how long a body is kept is the agent’s to name', () => {
  it('tears a body down where the agent asked for nothing', async () => {
    const { run, peer } = await atACall(0);
    await until(() => peer.destroyed, 'the body ending');
    expect(run.supervisor.resident).toEqual([]);
    // And the agent is unchanged by it: the same state it suspended in.
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: 'a:1' });
  });

  it('keeps a body the agent asked to keep, and answers it there', async () => {
    const { run, peer } = await atACall(60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.destroyed).toBe(false);

    await run.supervisor.tell('Two files.');
    await peer.until(() => peer.answers().size === 1, 'the answer arriving in place');

    expect(peer.answers().get('a:1')).toEqual({ ok: true, content: '[from the human] Two files.' });
    // Woken in its own body: nothing was provisioned to do it.
    expect(run.driver.all('a')).toHaveLength(1);
    // And nothing was written to the log, because the pipe was there to carry it.
    expect((await run.store.transcript('a')).at(-1)?.type).toBe('usage');
  });

  it('tears the body down when the period the agent named elapses', async () => {
    const { run, peer } = await atACall(40);
    expect(peer.destroyed).toBe(false);

    await until(() => peer.destroyed, 'the period elapsing');
    // Expiry syncs and destroys and leaves the agent exactly as it was — an agent whose body
    // was kept and one whose body was torn down resume identically.
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: 'a:1' });

    await run.supervisor.tell('Two files.');
    await until(() => run.driver.all('a').length === 2, 'it being woken in a fresh body');
  });

  it('cancels the period when a message arrives first', async () => {
    const { run, peer } = await atACall(5_000);
    await run.supervisor.tell('Two files.');
    await peer.until(() => peer.answers().size === 1);

    // Still resident well past the point a disarmed timer would have fired if it had not
    // been disarmed — and, more to the point, still the same body.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peer.destroyed).toBe(false);
    expect(run.driver.all('a')).toHaveLength(1);
  });
});

describe('a suspension is invisible to the agent it happened to', () => {
  /**
   * Byte-identity rather than deep equality, because providers key prompt caches on prefix
   * content: a difference of one character is not cosmetic, it misses cache on every resume.
   * `runtime/resume.test.ts` holds this for the runtime; this holds that the supervisor
   * hands back the same bytes rather than a log of its own construction.
   */
  it('boots a resumed agent on a log that sends exactly what an uninterrupted one would', async () => {
    const { run, peer } = await atACall(0);
    await until(() => peer.destroyed);
    await run.supervisor.tell('Two files.');
    await until(() => run.driver.all('a').length === 2);

    // What the agent would have had if the answer had come down a pipe it never lost.
    const uninterrupted: Event[] = [
      ...calling(),
      { type: 'tool_result', at: AT, id: 'c1', content: '[from the human] Two files.', ok: true, ms: 0 },
    ];
    const resumed = JSON.parse(run.driver.latest('a')!.boot) as { events: Event[] };

    expect(wouldSend(resumed.events)).toBe(wouldSend(uninterrupted));
  });

  it('gives the resumed agent the same workspace, holding what it wrote', async () => {
    const { run, peer } = await atACall(0);
    run.driver.workspace('a').set('notes.md', 'what I found so far');
    await until(() => peer.destroyed);

    await run.supervisor.tell('Two files.');
    await until(() => run.driver.all('a').length === 2);

    expect(run.driver.workspace('a').get('notes.md')).toBe('what I found so far');
    // What is lost is only the state of processes that were running, which is the
    // suspension model's one real cost.
    expect(run.driver.released).toEqual([]);
  });

  it('never provisions one agent twice at once', async () => {
    // The assumption `agent/AGENTS.md` records, made a failure rather than a silent data
    // loss: the double refuses a second creation in flight for one agent. Nothing in this
    // change holds two, and this is what would notice if something started to.
    const { run, peer } = await atACall(0);
    await until(() => peer.destroyed);

    await Promise.all([run.supervisor.tell('one'), run.supervisor.tell('two')]);
    await until(() => run.driver.all('a').length >= 2, 'a waking');
    expect(run.toHuman).toEqual([]);
  });
});

/**
 * The one ordering that cannot be relaxed, and the reason it cannot.
 *
 * An agent resumed from a log missing its final steps does not fail. It repeats work it had
 * already done, or reports on work that is no longer there, and neither is distinguishable
 * from an agent that behaved. A test that read the store *after* the teardown would pass
 * against a supervisor that synced afterwards, so this reads it at the moment of it.
 */
describe('a transcript is durable before the body is allowed to end', () => {
  it('has stored every event by the moment the body ends', async () => {
    const run = await aRun({ clock: () => Date.parse(AT) });
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['await'] }), 'Begin.');

    let atTeardown: number | undefined;
    run.driver.beforeDestroy = async () => {
      atTeardown = (await run.store.transcript('a')).length;
    };

    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);
    for (const event of calling()) peer.append(event);
    peer.ask('a:1', 'await', {}, 0);

    await until(() => peer.destroyed, 'the body ending');
    expect(atTeardown).toBe(calling().length);
  });
});

/**
 * The one message the supervisor gives away before writing it down anywhere.
 *
 * A message that answers an outstanding call is durable by the time a body sees it — the
 * runtime records it as a `tool_result`, and for a dormant agent `#answerInLog` puts it in
 * the log *before* anything boots. A message that **begins a turn** is not: `#deliver` takes
 * it out of the mailbox, hands it down the pipe, and the runtime is what records it, as the
 * first act of `turn()`. Between those two moments it exists in a pipe and nowhere else.
 *
 * That is survivable for a body that dies — its exit becomes a termination its parent can
 * act on. It is not survivable for a body the supervisor ends itself, because an intended
 * ending is reported to nobody. **`shutdown()` straight after `tell()` is the ordinary way
 * to reach it**, and ENG-199's first run by hand did exactly that: the instruction was gone
 * from the mailbox, absent from the transcript, and the agent was left recorded as `working`
 * over a log with nothing new in it. Nothing anywhere said so.
 */
describe('a message handed to a body that never recorded it is not lost with the body', () => {
  /** An agent at a turn boundary, resident, about to be told something. */
  async function atABoundary(): Promise<{ run: Run; peer: Peer }> {
    const run = await aRun();
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', tools: ['await'] }), 'Begin.');
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length === 1, 'its opening message');
    // A turn that ended and asked for nothing, which is where a body is kept only as long as
    // the next message takes to arrive.
    peer.answered('Done.', 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the turn ending');
    return { run, peer };
  }

  it('puts it back in the mailbox when the run is ended before the body acknowledges it', async () => {
    const { run, peer } = await atABoundary();

    await run.supervisor.tell('One more thing.');
    await peer.until(() => peer.messages().length === 2, 'the second message reaching the body');
    // Handed over and nowhere else: out of the mailbox, and the runtime has not said it took
    // it down. This is the window.
    expect(run.store.agent('a').mailbox).toEqual([]);
    expect(run.store.agent('a').state.status).toBe('working');

    await run.supervisor.shutdown();

    expect(run.store.agent('a').mailbox).toEqual([{ from: null, content: 'One more thing.' }]);
    // And back in the state it was taken out of, so whoever takes the run up next delivers
    // it as a message that begins a turn rather than resuming a step nobody ever took.
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: null });
  });

  it('delivers it exactly once when the run is taken up again', async () => {
    const { run } = await atABoundary();
    await run.supervisor.tell('One more thing.');
    await run.supervisor.shutdown();

    const second = await aRun({ directory: run.directory, run: run.store.run });
    runs.push(second);
    await second.supervisor.resume();
    const woken = second.driver.latest('a')!;
    await woken.until(() => woken.messages().length === 1, 'the message being delivered again');

    expect(woken.messages()).toEqual(['[from the human] One more thing.']);
    expect(second.store.agent('a').mailbox).toEqual([]);
  });

  it('leaves it alone once the body has said it recorded it', async () => {
    const { run, peer } = await atABoundary();

    await run.supervisor.tell('One more thing.');
    await peer.until(() => peer.messages().length === 2, 'the second message reaching the body');
    // What `turn()` does first, and the whole of what the supervisor waits to see. From here
    // the message is in the transcript, so restoring it would deliver it twice.
    peer.append({ type: 'message', at: AT, from: 'parent', content: '[from the human] One more thing.' });
    await untilStored(
      async () => (await run.store.transcript('a')).some((event) => event.type === 'message' && event.from === 'parent' && event.content.includes('One more thing')),
      'the body recording it',
    );

    await run.supervisor.shutdown();
    expect(run.store.agent('a').mailbox).toEqual([]);
    expect(run.store.agent('a').state.status).toBe('working');
  });

  /**
   * A body that *died* is deliberately left alone, and the line is worth stating.
   *
   * Its parent is told the child terminated, and the parent's weights choose between
   * retrying, replacing, escalating and giving up. Putting the message back would wake the
   * child again on the supervisor's own initiative — retrying a body that just failed, which
   * is the judgment `#ended` already declines to make.
   */
  /**
   * The restore's third caller, which is the ordinary one.
   *
   * `#suspend` is reached from a shutdown, from a dismissal, and from a residency expiry, and
   * only the last of those wants what it put back delivered — the other two are ending the
   * run or the agent. So a message restored at an ordinary suspension would sit in the
   * mailbox of a `waiting` agent with no body, which nothing else in the supervisor looks
   * for: delivery only happens in a settle, and `stalled` reads held mail as a tree still
   * moving, so `onStalled` would not fire for it either. Silence with an instruction in it,
   * reached through the fix for silence with an instruction in it.
   *
   * **The window is a timer firing while a message is on its way**, which is why the queue is
   * held open here rather than raced for: the child's suspension blocks on `beforeDestroy`,
   * the `tell` queues behind it, and the root's residency expires while both wait.
   */
  it('delivers what it put back when an ordinary residency ended the body', async () => {
    const run = await aRun();
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['spawn', 'await'] }), 'Begin.');
    const root = run.driver.latest('a')!;
    await root.until(() => root.messages().length === 1, 'its opening message');

    root.ask('a:1', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.', tools: ['await'] });
    await root.until(() => root.answers().has('a:1'), 'the spawn being answered');
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length === 1, "the child's opening message");

    // The child suspends on a call rather than by speaking, because a child that spoke would
    // post to this root and take the residency down with the delivery.
    let holding: () => void;
    const held = new Promise<void>((wake) => {
      holding = wake;
    });
    let release: () => void;
    const released = new Promise<void>((wake) => {
      release = wake;
    });
    run.driver.beforeDestroy = async (agent) => {
      if (agent !== 'a-1') return;
      holding();
      await released;
    };

    // Resident, at a boundary, with its own number armed.
    root.answered('Done.', 200);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the turn ending');

    child.ask('a-1:1', 'await', {}, 0);
    await held;

    const told = run.supervisor.tell('One more thing.');
    // Long enough that the residency above expires while the queue is held, which is the
    // ordering the bug needs: the delivery ahead of the expiry, and the expiry already
    // queued by the time the delivery hands the message over.
    await new Promise<void>((wake) => setTimeout(wake, 400));
    release!();
    await told;

    await until(() => run.driver.all('a').length === 2, 'the root being woken in a fresh body');
    expect(run.driver.all('a').at(-1)!.messages()).toEqual(['[from the human] One more thing.']);
    expect(run.store.agent('a').mailbox).toEqual([]);
  });

  /**
   * The restore is the only call in `#suspend` that can fail, and `#shutdown` walks every
   * body in a bare loop — so a rejection here would keep the containers of every body after
   * this one and skip `store.close()`, failing a clean exit through the action a person takes
   * to stop for the day. A disk that filled while the run worked is the ordinary way here,
   * and it is when you most want the rest ended.
   */
  it('ends every other body when the mailbox cannot be written back', async () => {
    const run = await aRun();
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['spawn'] }), 'Begin.');
    const root = run.driver.latest('a')!;
    await root.until(() => root.messages().length === 1, 'its opening message');

    root.ask('a:1', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.' });
    await root.until(() => root.answers().has('a:1'), 'the spawn being answered');
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length === 1, "the child's opening message");

    // Neither has acknowledged its opening, so both are holding one, and the root is the
    // first body the shutdown reaches.
    run.store.save = () => Promise.reject(new Error('no space left on device'));

    await run.supervisor.shutdown();

    expect(root.destroyed).toBe(true);
    expect(child.destroyed).toBe(true);
    // Reported rather than swallowed: this is the supervisor's own trouble, and `onFailure`
    // is the only thing that can tell a person a message was lost.
    expect(run.failures.map((failure) => failure.agent)).toEqual(['a', 'a-1']);
  });

  it('does not put it back when the body died rather than being ended', async () => {
    const { run, peer } = await atABoundary();
    await run.supervisor.tell('One more thing.');
    await peer.until(() => peer.messages().length === 2, 'the second message reaching the body');

    // Two, because the turn this agent already ended reached the human as well — waiting on
    // "anything at all" would have been satisfied by that one before the death arrived.
    peer.die();
    await until(() => run.toHuman.length === 2, 'the death being reported upward');

    expect(run.toHuman.at(-1)?.content).toContain("a's body ended");
    expect(run.toHuman.at(-1)?.substrate).toBe(true);
    expect(run.store.agent('a').mailbox).toEqual([]);
  });
});

/**
 * What a shutdown leaves behind is the last word, including for work already queued.
 *
 * `#shutdown` runs on the serial queue, and everything queued behind it still runs after it
 * — over a store where the messages it just restored are at the head of `waiting` mailboxes.
 * Anything that settles from there takes one and provisions a sandbox for an agent the run
 * has finished with: a container outliving the shutdown, which is the clean-exit criterion
 * ENG-199 asserts, failed by the action a person takes to stop for the day.
 *
 * **There is more than one way to be queued behind it**, which is why the guard is in
 * `#settle` rather than at any caller. A residency timer that has already fired is past
 * `#disarm`; a frame read off a body's channel a moment before that body was destroyed is
 * already in the queue; `add()` and `tell()` queue from outside the supervisor altogether.
 * One test below is the first of those and one is the second, and a guard on either caller
 * alone leaves the other.
 *
 * Both are timed rather than raced: the shutdown is held open at the root's teardown, which
 * is where the real window is — that loop is a sync and a destroy per body, seconds each
 * against a real daemon.
 */
describe('a closing run starts nothing more', () => {
  /**
   * A root resident at a boundary holding a message it never acknowledged, and a child
   * resident on a call. The root is the first body a shutdown reaches, so holding its
   * teardown holds the whole walk.
   */
  async function aTreeAtRest(): Promise<{ run: Run; child: Peer; held: Promise<void>; release: () => void }> {
    const run = await aRun();
    runs.push(run);
    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['spawn', 'await'] }), 'Begin.');
    const root = run.driver.latest('a')!;
    await root.until(() => root.messages().length === 1, 'its opening message');

    root.ask('a:1', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.', tools: ['await'] });
    await root.until(() => root.answers().has('a:1'), 'the spawn being answered');
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length === 1, "the child's opening message");

    // Resident at a boundary, then told something — so the shutdown has a message to put
    // back, which is what a late settle finds at the head of a `waiting` mailbox.
    root.answered('Done.', 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the turn ending');
    await run.supervisor.tell('One more thing.');
    await root.until(() => root.messages().length === 2, 'the second message reaching the body');
    expect(run.store.agent('a').mailbox).toEqual([]);

    let reached: () => void;
    const held = new Promise<void>((wake) => {
      reached = wake;
    });
    let release: () => void;
    const released = new Promise<void>((wake) => {
      release = wake;
    });
    run.driver.beforeDestroy = async (agent) => {
      if (agent !== 'a') return;
      reached();
      await released;
    };

    return { run, child, held, release: () => release() };
  }

  /**
   * Everything the shutdown wrote, still true afterwards — and the root never provisioned a
   * second time. Read after a pause because the queued task runs the moment the shutdown's
   * own promise settles; without the guard it is well past `#deliver`'s first write by here.
   */
  async function unchangedByWhatRanAfter(run: Run): Promise<void> {
    await new Promise<void>((wake) => setTimeout(wake, 100));

    expect(run.driver.all('a')).toHaveLength(1);
    expect(run.supervisor.resident).toEqual([]);
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: null });
    expect(run.store.agent('a').mailbox.at(0)).toEqual({ from: null, content: 'One more thing.' });
  }

  it('declines the settle a residency that expired mid-shutdown asks for', async () => {
    const { run, child, held, release } = await aTreeAtRest();

    // Short enough to expire while the walk is held at the root above it.
    child.ask('a-1:1', 'await', {}, 120);
    await until(() => run.store.agent('a-1').state.status === 'waiting', 'the child suspending on its call');
    // Both bodies live and the child's number still running, so the expiry the test is about
    // is ahead of the shutdown rather than already behind it.
    expect(run.supervisor.resident).toEqual(['a', 'a-1']);

    const ended = run.supervisor.shutdown();
    await held;
    await new Promise<void>((wake) => setTimeout(wake, 300));
    release();
    await ended;

    await unchangedByWhatRanAfter(run);
  });

  it('declines the settle a frame read just before the shutdown asks for', async () => {
    const { run, child, held, release } = await aTreeAtRest();

    const ended = run.supervisor.shutdown();
    await held;
    // Read off a live channel and queued behind the shutdown, which is the ordinary way a
    // frame arrives late: this body has not been reached by the walk yet.
    child.answered('Found it.');
    await new Promise<void>((wake) => setTimeout(wake, 50));
    release();
    await ended;

    await unchangedByWhatRanAfter(run);
    // The frame was handled, and handled after the restore — so what the guard declined was
    // a settle that really did run, rather than a frame that never arrived.
    expect(run.store.agent('a-1').state.status).toBe('waiting');
    expect(run.store.agent('a').mailbox).toEqual([
      { from: null, content: 'One more thing.' },
      { from: 'a-1', content: 'Found it.' },
    ]);
  });
});
