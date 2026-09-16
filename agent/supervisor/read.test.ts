/**
 * Serving transcripts, which is the substrate's only verification surface.
 *
 * A parent that cannot reconstruct what a child did from its transcript has no way to catch
 * a confident lie, and a claim an agent writes about itself is exactly as forgeable as the
 * prose beside it. So the authorization rule has to be the tree and nothing else, and a
 * refusal has to be a refusal — silence and emptiness are indistinguishable from a target
 * that did nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { aRun, until, untilStored, type Peer, type Run } from './double.ts';

import type { Event } from '../runtime/events.ts';

const runs: Run[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.end();
});

const AT = '2026-01-01T00:00:00.000Z';

interface Served {
  id: string;
  from: number;
  total: number;
  events: Event[];
}

/**
 * A root, a child, and a grandchild — enough tree for "descendant" to mean more than
 * "child", and for a sibling to exist to be refused.
 */
async function aFamily(): Promise<Run> {
  const run = await aRun({ clock: () => Date.parse(AT) });
  runs.push(run);
  await run.supervisor.add(aRecord({ id: 'a', parent: null }), 'Begin.');
  await run.supervisor.add(aRecord({ id: 'a-1', parent: 'a' }), 'Begin.');
  await run.supervisor.add(aRecord({ id: 'a-2', parent: 'a' }), 'Begin.');
  await run.supervisor.add(aRecord({ id: 'a-1-1', parent: 'a-1' }), 'Begin.');
  return run;
}

/** Fill an agent's transcript with a countable number of events. */
async function fill(run: Run, id: string, howMany: number): Promise<void> {
  const peer = run.driver.latest(id)!;
  await peer.until(() => peer.messages().length > 0);
  for (let at = 0; at < howMany; at++) {
    peer.append({ type: 'message', at: AT, from: 'self', content: `step-${at}` });
  }
  await untilStored(async () => (await run.store.length(id)) === howMany, `${id}'s transcript`);
}

async function ask(peer: Peer, id: string, input: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
  const at = `${peer.agent}:${peer.answers().size + 1}`;
  peer.ask(at, 'read', input);
  await peer.until(() => peer.answers().has(at), `an answer to ${at}`);
  return peer.answers().get(at)!;
}

describe('a transcript is readable by the agents accountable for it', () => {
  it('serves a child’s transcript to its parent', async () => {
    const run = await aFamily();
    await fill(run, 'a-1', 4);

    const answer = await ask(run.driver.latest('a')!, 'a', { id: 'a-1' });
    expect(answer.ok).toBe(true);
    const served = JSON.parse(answer.content) as Served;
    expect(served.id).toBe('a-1');
    expect(served.total).toBe(4);
    expect(served.events.map((event) => (event as { content: string }).content)).toEqual([
      'step-0',
      'step-1',
      'step-2',
      'step-3',
    ]);
  });

  it('serves a grandchild’s, because the rule is the tree and not the generation', async () => {
    const run = await aFamily();
    await fill(run, 'a-1-1', 2);

    const answer = await ask(run.driver.latest('a')!, 'a', { id: 'a-1-1' });
    expect(answer.ok).toBe(true);
    expect((JSON.parse(answer.content) as Served).total).toBe(2);
  });

  it('carries what the provider’s message array cannot', async () => {
    const run = await aFamily();
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);
    child.append({ type: 'tool_call', at: AT, id: 'c1', name: 'fs', arguments: '{}' });
    child.append({ type: 'tool_result', at: AT, id: 'c1', content: 'two files', ok: false, ms: 42 });
    child.append({ type: 'usage', at: AT, in: 120, out: 8, model: 'scripted' });
    await untilStored(async () => (await run.store.length('a-1')) === 3);

    const served = JSON.parse((await ask(run.driver.latest('a')!, 'a', { id: 'a-1' })).content) as Served;
    // When it happened, what it cost, how long each invocation took and whether it
    // succeeded — which is what makes a transcript a verification surface rather than
    // merely a resumable one.
    expect(served.events).toMatchObject([
      { type: 'tool_call', at: AT },
      { type: 'tool_result', ok: false, ms: 42 },
      { type: 'usage', in: 120, out: 8 },
    ]);
  });
});

describe('a transcript that is not below the reader is refused', () => {
  it('refuses a sibling’s, distinguishably from one with nothing in it', async () => {
    const run = await aFamily();
    await fill(run, 'a-2', 3);

    const refused = await ask(run.driver.latest('a-1')!, 'a-1', { id: 'a-2' });
    expect(refused.ok).toBe(false);
    expect(refused.content).toMatch(/not below you/);

    // The distinction that matters: an empty transcript is served, and says so.
    const empty = await ask(run.driver.latest('a')!, 'a', { id: 'a-1' });
    expect(empty.ok).toBe(true);
    expect((JSON.parse(empty.content) as Served).events).toEqual([]);
  });

  it('refuses an ancestor’s, and its own', async () => {
    const run = await aFamily();
    await fill(run, 'a', 2);

    expect((await ask(run.driver.latest('a-1')!, 'a-1', { id: 'a' })).ok).toBe(false);
    expect((await ask(run.driver.latest('a-1')!, 'a-1', { id: 'a-1' })).ok).toBe(false);
  });

  it('refuses an agent that is not in the run', async () => {
    const run = await aFamily();
    const answer = await ask(run.driver.latest('a')!, 'a', { id: 'nobody' });
    expect(answer.ok).toBe(false);
    expect(answer.content).toMatch(/There is no agent/);
  });
});

describe('a long transcript is read in parts', () => {
  it('serves a range, and says how much there is to come back for', async () => {
    const run = await aFamily();
    await fill(run, 'a-1', 30);
    const parent = run.driver.latest('a')!;

    const first = JSON.parse((await ask(parent, 'a', { id: 'a-1', from: 0, count: 10 })).content) as Served;
    const second = JSON.parse((await ask(parent, 'a', { id: 'a-1', from: 10, count: 10 })).content) as Served;
    const last = JSON.parse((await ask(parent, 'a', { id: 'a-1', from: 20, count: 100 })).content) as Served;

    expect(first.events).toHaveLength(10);
    expect(second.events).toHaveLength(10);
    expect(last.events).toHaveLength(10);
    expect(first.total).toBe(30);

    const read = [...first.events, ...second.events, ...last.events].map(
      (event) => (event as { content: string }).content,
    );
    expect(read).toEqual(Array.from({ length: 30 }, (_, at) => `step-${at}`));
  });

  it('serves a range past the end as an empty one rather than as a failure', async () => {
    const run = await aFamily();
    await fill(run, 'a-1', 3);

    const answer = await ask(run.driver.latest('a')!, 'a', { id: 'a-1', from: 99, count: 10 });
    expect(answer.ok).toBe(true);
    expect((JSON.parse(answer.content) as Served).events).toEqual([]);
  });

  it('grows while it is being read, and a later range sees the rest', async () => {
    const run = await aFamily();
    await fill(run, 'a-1', 5);
    const parent = run.driver.latest('a')!;

    const before = JSON.parse((await ask(parent, 'a', { id: 'a-1' })).content) as Served;
    expect(before.total).toBe(5);

    const child = run.driver.latest('a-1')!;
    child.append({ type: 'message', at: AT, from: 'self', content: 'step-5' });
    await untilStored(async () => (await run.store.length('a-1')) === 6);

    // Line ranges are stable because the file only ever grows, so an earlier range still
    // means what it meant.
    const again = JSON.parse((await ask(parent, 'a', { id: 'a-1', from: 0, count: 5 })).content) as Served;
    expect(again.events).toEqual(before.events);
    expect(again.total).toBe(6);
  });
});

describe('a read reaches the supervisor and not the agent', () => {
  it('serves a transcript for an agent that has no body at all', async () => {
    const run = await aFamily();
    await fill(run, 'a-1', 3);

    const child = run.driver.latest('a-1')!;
    child.answered('Done.');
    await until(() => run.driver.latest('a-1')!.destroyed, 'the child going dormant');

    // The supervisor already holds every transcript, so a read is a query against the store
    // and never a question put to the agent.
    const answer = await ask(run.driver.latest('a')!, 'a', { id: 'a-1' });
    expect(answer.ok).toBe(true);
    expect((JSON.parse(answer.content) as Served).total).toBe(3);
  });
});
