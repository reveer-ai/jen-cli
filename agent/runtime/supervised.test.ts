/**
 * A capability the agent does not hold, made indistinguishable from one it does.
 *
 * The declarations themselves are `main.ts`'s, so these stand in for them. The property
 * worth holding is the one `capability.ts` was built for: `dispatch` cannot tell a request
 * raised over a pipe from work done in the sandbox, and so neither can the model — and
 * since a declaration may now do both in one invocation, it cannot tell that apart either.
 */
import { describe, expect, it } from 'vitest';

import { aCall, aRecord, asks, says, scripted } from '../fixture.ts';
import { dispatch, resolveCapabilities } from './capability.ts';
import { Runtime } from './index.ts';
import { supervised, type Composing, type Raise } from './supervised.ts';

const CLOCK = () => 1_767_225_600_000;
const RECORD = aRecord();

/** Records what was raised and answers it. */
function raising(answer = { content: 'a-2', ok: true }) {
  const raised: { kind: string; input: unknown; residency: number }[] = [];
  const raise: Raise = async (kind, input, residency) => {
    raised.push({ kind, input, residency });
    return answer;
  };
  return { raised, raise };
}

describe('a supervisor-backed request is an ordinary capability', () => {
  it('raises the request its name declares, and answers from the reply', async () => {
    const { raised, raise } = raising();
    const capability = supervised({ name: 'spawn', description: 'Spawn one.', schema: {} }, raise, RECORD);

    const result = await capability.invoke({ charter: 'Go.' }, new AbortController().signal);

    expect(raised).toEqual([{ kind: 'spawn', input: { charter: 'Go.' }, residency: 0 }]);
    expect(result).toEqual({ content: 'a-2', ok: true });
  });

  it('carries the agent’s own instruction about its body, read from what it asked for', async () => {
    const { raised, raise } = raising();
    const capability = supervised(
      {
        name: 'await',
        description: 'Wait for a message.',
        schema: {},
        residency: (input) => (input as { keep?: number }).keep ?? 0,
      },
      raise,
      RECORD,
    );

    await capability.invoke({ keep: 60_000 }, new AbortController().signal);
    await capability.invoke({}, new AbortController().signal);

    expect(raised.map((one) => one.residency)).toEqual([60_000, 0]);
  });

  /**
   * Zero is the absence of a request rather than a choice made for the agent, and it is
   * expressed here rather than left for the supervisor to fill in — a default there would
   * be a policy about an agent's body living where no charter can reach it.
   */
  it('carries zero where the capability names no instruction at all', async () => {
    const { raised, raise } = raising();
    await supervised({ name: 'read', description: 'Read a transcript.', schema: {} }, raise, RECORD).invoke(
      {},
      new AbortController().signal,
    );
    expect(raised[0]?.residency).toBe(0);
  });

  it('is dispatched by the same path as one that does its work in the sandbox', async () => {
    const { raise } = raising({ content: 'over the pipe', ok: true });
    const registry = resolveCapabilities(
      ['spawn'],
      [supervised({ name: 'spawn', description: 'Spawn one.', schema: {} }, raise, RECORD)],
    );

    const result = await dispatch(registry, aCall('c1', 'spawn'), new AbortController().signal, CLOCK);
    expect(result).toEqual({ content: 'over the pipe', ok: true, ms: 0 });
  });

  it('is declared to the model as any other capability is', async () => {
    const { raise } = raising();
    const client = scripted([asks(aCall('c1', 'spawn')), says('Spawned.')]);
    const agent = new Runtime({
      record: aRecord({ tools: ['spawn'] }),
      capabilities: [
        supervised({ name: 'spawn', description: 'Spawn one.', schema: { type: 'object' } }, raise, RECORD),
      ],
      client,
      clock: CLOCK,
    });

    expect(await agent.turn('Go.')).toBe('Spawned.');
    expect(client.requests[0]).toContain('"name":"spawn"');
    expect(agent.events).toMatchObject([
      { type: 'charter' },
      { type: 'message', from: 'parent' },
      { type: 'tool_call', name: 'spawn' },
      { type: 'usage' },
      { type: 'tool_result', id: 'c1', ok: true, content: 'a-2' },
      { type: 'message', from: 'self' },
      { type: 'usage' },
    ]);
  });
});

/**
 * The third shape: a declaration that raises *and* does something in place.
 *
 * `read` is the one that ships, and what these hold is the part that is not about
 * transcripts — that composing is invisible from outside the declaration. If the loop, the
 * dispatcher or the protocol ever came to know which kind it was handling, the runtime would
 * hold knowledge about a particular capability, which is the authority `capability.ts`
 * exists to deny it.
 */
describe('a capability may raise and work in place in one invocation', () => {
  /** A declaration that pages: it raises until the answers run out, then reports the total. */
  function paging(): { pages: unknown[]; declaration: Parameters<typeof supervised>[0] } {
    const pages: unknown[] = [];
    return {
      pages,
      declaration: {
        name: 'read',
        description: 'Read a transcript.',
        schema: {},
        async compose({ input, ask, record }: Composing) {
          let at = 0;
          for (;;) {
            const answer = await ask({ id: (input as { id: string }).id, from: at });
            if (!answer.ok) return answer;
            pages.push(answer.content);
            at += 1;
            if (at === 3) break;
          }
          return { ok: true, content: `${at} pages for ${record.id}` };
        },
      },
    };
  }

  it('raises more than once within a single invocation, under its own name', async () => {
    const { raised, raise } = raising();
    const { pages, declaration } = paging();

    const result = await supervised(declaration, raise, aRecord({ id: 'a' })).invoke(
      { id: 'a-1' },
      new AbortController().signal,
    );

    expect(raised).toEqual([
      { kind: 'read', input: { id: 'a-1', from: 0 }, residency: 0 },
      { kind: 'read', input: { id: 'a-1', from: 1 }, residency: 0 },
      { kind: 'read', input: { id: 'a-1', from: 2 }, residency: 0 },
    ]);
    expect(pages).toHaveLength(3);
    expect(result).toEqual({ ok: true, content: '3 pages for a' });
  });

  it('acts on the answer before the result reaches the loop', async () => {
    const { raise } = raising({ content: 'the whole transcript', ok: true });
    const result = await supervised(
      {
        name: 'read',
        description: 'Read a transcript.',
        schema: {},
        compose: async ({ ask }) => ({ ok: true, content: `kept ${(await ask({})).content.length} bytes` }),
      },
      raise,
      RECORD,
    ).invoke({}, new AbortController().signal);

    expect(result).toEqual({ ok: true, content: 'kept 20 bytes' });
  });

  it('passes a refusal through as the invocation’s own result', async () => {
    const { raise } = raising({ content: '"a-2" is not below you.', ok: false });
    const { declaration } = paging();

    const result = await supervised(declaration, raise, RECORD).invoke({ id: 'a-2' }, new AbortController().signal);

    expect(result).toEqual({ ok: false, content: '"a-2" is not below you.' });
  });

  it('is dispatched by the same call as one that only raises, and recorded the same way', async () => {
    const { raise } = raising();
    const { declaration } = paging();
    const client = scripted([asks(aCall('c1', 'read'), aCall('c2', 'spawn')), says('Checked.')]);
    const agent = new Runtime({
      record: aRecord({ id: 'a', tools: ['read', 'spawn'] }),
      capabilities: [
        supervised(declaration, raise, aRecord({ id: 'a' })),
        supervised({ name: 'spawn', description: 'Spawn one.', schema: {} }, raise, RECORD),
      ],
      client,
      clock: CLOCK,
    });

    expect(await agent.turn('Check the child.')).toBe('Checked.');
    // Two results, indistinguishable in kind: the transcript records what each invocation
    // produced and has nowhere to say that one of them also wrote a file.
    expect(agent.events).toMatchObject([
      { type: 'charter' },
      { type: 'message', from: 'parent' },
      { type: 'tool_call', name: 'read' },
      { type: 'tool_call', name: 'spawn' },
      { type: 'usage' },
      { type: 'tool_result', id: 'c1', ok: true, content: '3 pages for a' },
      { type: 'tool_result', id: 'c2', ok: true, content: 'a-2' },
      { type: 'message', from: 'self' },
      { type: 'usage' },
    ]);
  });

  it('is declared to the model exactly as one that does no local work is', () => {
    const { raise } = raising();
    const { declaration } = paging();
    const registry = resolveCapabilities(
      ['read'],
      [supervised({ ...declaration, schema: { type: 'object' } }, raise, RECORD)],
    );

    expect(registry.get('read')).toMatchObject({
      name: 'read',
      description: 'Read a transcript.',
      schema: { type: 'object' },
    });
    // The hook is the declaration's own and does not survive onto the capability: what
    // `dispatch` holds is a name, a description, a schema and an `invoke`.
    expect(Object.keys(registry.get('read')!)).toEqual(['name', 'description', 'schema', 'invoke']);
  });
});
