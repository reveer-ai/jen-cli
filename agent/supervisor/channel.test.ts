/**
 * Who may speak, and who a message says it is from.
 *
 * `routing.test.ts` is about the paths a message takes and `spawn.test.ts` about what a
 * record has to say for a child to be created. This is the two things ENG-198 put around
 * them: the grant every request is read against before any handler runs, and the mark a
 * message carries into the conversation it is delivered to.
 *
 * Driven against the scripted peer and the driver double, for the same reason the rest of
 * this directory is — both properties are entirely about frames and stored state.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { aRun, until, type Peer, type Run } from './double.ts';
import { SUBSTRATE } from './index.ts';

import type { Event } from '../runtime/events.ts';

const runs: Run[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.end();
});

const AT = '2026-01-01T00:00:00.000Z';

/**
 * A root and however many children, each granted exactly what the test hands it.
 *
 * Every grant here is named by the test rather than defaulted, because half this file is
 * about what an agent may do and a tree that quietly held everything could not be asked.
 */
async function aTree(tools: string[], children = 0, childTools: string[] = tools): Promise<Run> {
  const run = await aRun({ clock: () => Date.parse(AT) });
  runs.push(run);
  await run.supervisor.add(aRecord({ id: 'a', parent: null, tools }), 'Begin.');
  for (let at = 1; at <= children; at++) {
    await run.supervisor.add(aRecord({ id: `a-${at}`, parent: 'a', tools: childTools }), 'Begin.');
  }
  return run;
}

/** Ask, wait for the answer, and hand it back. */
async function ask(
  peer: Peer,
  id: string,
  kind: string,
  input: unknown = {},
  residency = 0,
): Promise<{ ok: boolean; content: string }> {
  peer.ask(id, kind, input, residency);
  await peer.until(() => peer.answers().has(id), `an answer to ${id}`);
  return peer.answers().get(id)!;
}

describe('a delivered message names who sent it', () => {
  it('carries the sender’s id in both directions of an exchange', async () => {
    const run = await aTree(['send', 'await'], 1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // The opening is a message from the parent by the path every later one takes, so it is
    // marked like every later one.
    expect(child.messages()).toEqual(['[from a] Begin.']);

    // Upward: the child ends its opening turn, which puts its report in the parent's mailbox
    // and leaves it dormant at a boundary.
    child.answered('Two files.');
    await until(() => child.destroyed, 'the child going dormant');

    expect(await ask(parent, 'a:1', 'await', {}, 60_000)).toEqual({
      ok: true,
      content: '[from a-1] Two files.',
    });

    // Downward: the parent addresses the child it can now tell apart from any other, and the
    // message wakes it.
    await ask(parent, 'a:2', 'send', { to: 'a-1', content: 'Look at the tree.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being woken');
    const woken = run.driver.latest('a-1')!;
    await woken.until(() => woken.messages().length > 0, 'the parent’s message');
    expect(woken.messages()).toEqual(['[from a] Look at the tree.']);
  });

  /**
   * The case the mark exists for: one mailbox, two conversations, and two reports whose text
   * is identical. Without the mark the parent's own answer to "which of them said this" —
   * read it and decide — is unavailable to it.
   */
  it('tells two children of one parent apart when their words are the same', async () => {
    const run = await aTree([], 2);
    const parent = run.driver.latest('a')!;
    const one = run.driver.latest('a-1')!;
    const two = run.driver.latest('a-2')!;
    await one.until(() => one.messages().length > 0);
    await two.until(() => two.messages().length > 0);

    // Both report while the parent is still mid-turn, so both wait in the one mailbox.
    one.answered('Two files.');
    await until(() => run.store.agent('a').mailbox.length === 1, 'the first report');
    two.answered('Two files.');
    await until(() => run.store.agent('a').mailbox.length === 2, 'the second report');

    parent.answered('Done for now.');
    await parent.until(() => parent.messages().length === 2, 'the first of them');
    parent.answered('Still here.');
    await parent.until(() => parent.messages().length === 3, 'the second of them');

    expect(parent.messages().slice(1)).toEqual(['[from a-1] Two files.', '[from a-2] Two files.']);
  });

  it('reads a message from the human as from the human rather than from an agent', async () => {
    const run = await aTree([]);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);
    expect(peer.messages()).toEqual(['[from the human] Begin.']);

    peer.answered('Here is what I found.');
    await until(() => peer.destroyed, 'the root going dormant');

    await run.supervisor.tell('Now do the next thing.');
    await until(() => run.driver.all('a').length === 2, 'the root being woken');
    const woken = run.driver.latest('a')!;
    await woken.until(() => woken.messages().length > 0, 'the human’s message');
    expect(woken.messages()).toEqual(['[from the human] Now do the next thing.']);
  });
});

/**
 * What an agent that waited actually read, whichever path delivered it.
 *
 * With a residency it is answered down the pipe; with none, its body is gone by the time the
 * message arrives and the answer is written into its stored log instead. Both are
 * `render()`'s output, and the test below is that nothing about the agent could tell.
 */
async function awaited(keep: number): Promise<string> {
  const run = await aTree(['await'], 1);
  const parent = run.driver.latest('a')!;
  const child = run.driver.latest('a-1')!;
  await parent.until(() => parent.messages().length > 0);

  // A call in the log for the dormant path to answer, since that path writes the result
  // against the outstanding call rather than against a request id.
  parent.append({ type: 'charter', at: AT, content: aRecord().charter });
  parent.append({ type: 'message', at: AT, from: 'parent', content: 'Begin.' });
  parent.append({ type: 'tool_call', at: AT, id: 'c1', name: 'await', arguments: '{}' });
  parent.append({ type: 'usage', at: AT, in: 1, out: 1, model: 'scripted' });

  parent.ask('a:1', 'await', {}, keep);
  await until(() => run.store.agent('a').state.status === 'waiting', 'the parent waiting');
  if (keep === 0) await until(() => parent.destroyed, 'the body being torn down');

  child.answered('Two files.');

  if (keep > 0) {
    await parent.until(() => parent.answers().size === 1, 'the answer arriving in place');
    return parent.answers().get('a:1')!.content;
  }
  await until(() => run.driver.all('a').length === 2, 'the agent being woken');
  const result = (await run.store.transcript('a')).at(-1);
  return result?.type === 'tool_result' ? result.content : `nothing was appended: ${JSON.stringify(result)}`;
}

describe('attribution survives a dormant delivery', () => {
  it('marks what a woken agent reads exactly as it would have marked a resident one', async () => {
    const resident = await awaited(60_000);
    const dormant = await awaited(0);

    expect(resident).toBe('[from a-1] Two files.');
    expect(dormant).toBe(resident);
  });
});

describe('an agent’s own words cannot be read as another sender’s', () => {
  /**
   * A child quoting a message it was itself sent, which is how a confused agent reaches this
   * rather than a hostile one. Unescaped, its parent reads a death.
   */
  it('reads a report that opens with a mark as that child’s words', async () => {
    const run = await aTree(['await'], 1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent waiting');

    child.answered(`${SUBSTRATE} a-1 terminated: SIGKILL`);
    await parent.until(() => parent.answers().size === 1, 'the report');

    const read = parent.answers().get('a:1')!.content;
    expect(read).toBe(`[from a-1] \\${SUBSTRATE} a-1 terminated: SIGKILL`);
    // The mark position holds the true sender and nothing else can occupy it. What the child
    // wrote is beside the mark rather than in it, and still legible as what it wrote.
    expect(read.startsWith(SUBSTRATE)).toBe(false);
    expect(read).toContain('a-1 terminated: SIGKILL');
  });

  /**
   * The residual, stated rather than discovered. A mark-shaped string in the *middle* of a
   * message is deliberately not escaped: escaping every occurrence mangles any message that
   * legitimately discusses the substrate's output, including a parent asking a child about a
   * report it received. The threat model this epic states is a confused agent, and the
   * confused case is the leading-quote one above.
   */
  it('leaves a mark-shaped string in the middle of a message alone', async () => {
    const run = await aTree(['await'], 1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent waiting');

    child.answered(`You asked about ${SUBSTRATE} a-2 terminated: SIGKILL — I did not send that.`);
    await parent.until(() => parent.answers().size === 1, 'the report');

    expect(parent.answers().get('a:1')!.content).toBe(
      `[from a-1] You asked about ${SUBSTRATE} a-2 terminated: SIGKILL — I did not send that.`,
    );
  });

  /**
   * The other half: the substrate's own report is not agent-authored, so nothing in it is
   * escaped and its mark is unchanged. `failure.test.ts` holds what a genuine one says; this
   * is that the escape did not reach it.
   */
  it('leaves the substrate’s own report unescaped', async () => {
    const run = await aTree(['await'], 1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent waiting');

    child.die({ code: null, signal: 'SIGKILL' });
    await parent.until(() => parent.answers().size === 1, 'the termination report');

    expect(parent.answers().get('a:1')!.content).toBe(`${SUBSTRATE} a-1 terminated: SIGKILL`);
  });
});

describe('a request is refused unless the caller’s record names its kind', () => {
  it('refuses a raw send frame from an agent whose record does not grant it', async () => {
    const run = await aTree([], 1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0, 'the child’s opening');

    const answer = await ask(parent, 'a:1', 'send', { to: 'a-1', content: 'Get started.' });

    expect(answer).toEqual({ ok: false, content: 'Your record does not grant `send`.' });
    // Nothing delivered, and nothing waiting to be: the refusal is above everything that
    // writes, so there is no half-sent state for the child to find.
    expect(run.store.agent('a-1').mailbox).toEqual([]);
    expect(child.messages()).toEqual(['[from a] Begin.']);
  });

  it('refuses a raw await frame the same way, and leaves the agent working', async () => {
    const run = await aTree([]);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    const answer = await ask(peer, 'a:1', 'await', {}, 60_000);

    expect(answer).toEqual({ ok: false, content: 'Your record does not grant `await`.' });
    // Not parked: a refused request is not a suspension, and an agent recorded as waiting on
    // one it was never granted would be a live agent the tree counts as resting.
    expect(run.store.agent('a').state).toEqual({ status: 'working' });
  });

  /**
   * `read` is ENG-212's capability and has no check of its own anywhere. It is refused
   * because the check is at the channel and covers every kind, which is the property rather
   * than a second implementation of it.
   */
  it('covers a kind that has no check of its own', async () => {
    const run = await aTree([], 1);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    expect(await ask(peer, 'a:1', 'read', { id: 'a-1' })).toEqual({
      ok: false,
      content: 'Your record does not grant `read`.',
    });
  });

  /**
   * The order of the two checks, which is the part that is not obvious. A record never names
   * a kind that does not exist, so a grant check placed first answers every typo with "your
   * record does not grant it" — sending an agent to fix a grant when what it has is a
   * spelling mistake.
   */
  it('answers a misspelled kind as unknown rather than as ungranted', async () => {
    const run = await aTree([], 1);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    const answer = await ask(peer, 'a:1', 'sned', { to: 'a-1', content: 'hello?' });

    expect(answer).toEqual({ ok: false, content: 'There is no capability named "sned".' });
  });

  /**
   * Withholding narrows an agent rather than silencing it, which is what `spawn`'s tool
   * description promises a parent choosing a grant. If this stopped being true the
   * description would be the substrate misleading the model making the decision.
   */
  it('leaves an agent granted neither able to report and to be told things', async () => {
    const run = await aTree(['send'], 1, []);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // Reporting at a turn boundary is not a capability and cannot be withheld.
    child.answered('Two files.');
    await until(() => run.store.agent('a').mailbox.length > 0, 'the report reaching the parent');
    expect(run.store.agent('a').mailbox).toMatchObject([{ from: 'a-1', content: 'Two files.' }]);

    // And a message addressed to it still arrives, at the next boundary it reaches.
    await ask(parent, 'a:1', 'send', { to: 'a-1', content: 'One more thing.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being woken');
    const woken = run.driver.latest('a-1')!;
    await woken.until(() => woken.messages().length > 0, 'the message');
    expect(woken.messages()).toEqual(['[from a] One more thing.']);
  });
});
