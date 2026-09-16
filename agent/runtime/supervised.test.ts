/**
 * A capability the agent does not hold, made indistinguishable from one it does.
 *
 * Nothing registers one of these yet, so this is what stands in for the five that will. The
 * property worth holding before they are written is the one `capability.ts` was built for:
 * `dispatch` cannot tell a request raised over a pipe from work done in the sandbox, and so
 * neither can the model.
 */
import { describe, expect, it } from 'vitest';

import { aCall, aRecord, asks, says, scripted } from '../fixture.ts';
import { dispatch, resolveCapabilities } from './capability.ts';
import { Runtime } from './index.ts';
import { supervised, type Raise } from './supervised.ts';

const CLOCK = () => 1_767_225_600_000;

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
    const capability = supervised({ name: 'spawn', description: 'Spawn one.', schema: {} }, raise);

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
    await supervised({ name: 'read', description: 'Read a transcript.', schema: {} }, raise).invoke(
      {},
      new AbortController().signal,
    );
    expect(raised[0]?.residency).toBe(0);
  });

  it('is dispatched by the same path as one that does its work in the sandbox', async () => {
    const { raise } = raising({ content: 'over the pipe', ok: true });
    const registry = resolveCapabilities(
      ['spawn'],
      [supervised({ name: 'spawn', description: 'Spawn one.', schema: {} }, raise)],
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
        supervised({ name: 'spawn', description: 'Spawn one.', schema: { type: 'object' } }, raise),
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
