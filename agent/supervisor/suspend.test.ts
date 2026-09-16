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
  await run.supervisor.add(aRecord({ id: 'a', parent: null }), 'Begin.');

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
    expect(log.at(-1)).toEqual({ type: 'tool_result', at: AT, id: 'c1', content: 'Two files.', ok: true, ms: 0 });

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
    await run.supervisor.add(aRecord({ id: 'a', parent: null }), 'Begin.');

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
    await run.supervisor.add(aRecord({ id: 'a', parent: null }), 'Begin.');

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
    expect(run.driver.latest('a')!.messages()).toEqual(['Try again.']);
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

    expect(peer.answers().get('a:1')).toEqual({ ok: true, content: 'Two files.' });
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
      { type: 'tool_result', at: AT, id: 'c1', content: 'Two files.', ok: true, ms: 0 },
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
    await run.supervisor.add(aRecord({ id: 'a', parent: null }), 'Begin.');

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
