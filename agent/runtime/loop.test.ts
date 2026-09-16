/**
 * The loop, and the turn boundary that is the whole of an agent's completion signal.
 *
 * Everything here runs against the scripted client. The property under test is what the
 * runtime *does with what it is given*, and a live model would make that non-deterministic
 * for reasons unrelated to any of it.
 */
import { describe, expect, it } from 'vitest';

import { aCall, aCapability, aRecord, asks, declines, says, scripted } from '../fixture.ts';
import { Runtime } from './index.ts';

const CLOCK = () => 1_767_225_600_000;

function runtime(script: Parameters<typeof scripted>[0], overrides: Partial<Parameters<typeof aRecord>[0]> = {}) {
  const client = scripted(script);
  return {
    client,
    agent: new Runtime({
      record: aRecord({ tools: ['fs'], ...overrides }),
      capabilities: [aCapability('fs')],
      client,
      clock: CLOCK,
    }),
  };
}

describe('a turn ends on content with nothing outstanding', () => {
  it('returns that content as the message to the parent', async () => {
    const { agent, client } = runtime([says('There are two files.')]);
    await expect(agent.turn('What is here?')).resolves.toBe('There are two files.');
    expect(client.taken).toBe(1);
  });

  it('writes the agent’s own words into the log as its message', async () => {
    const { agent } = runtime([says('Done.')]);
    await agent.turn('Go.');
    expect(agent.events.filter((event) => event.type === 'message')).toMatchObject([
      { from: 'parent', content: 'Go.' },
      { from: 'self', content: 'Done.' },
    ]);
  });

  // No status field, no completion channel, nothing the agent writes to announce it has
  // finished. The content with nothing outstanding is the entire signal.
  it('records nothing else that could be read as a completion signal', async () => {
    const { agent } = runtime([says('Done.')]);
    await agent.turn('Go.');
    const types = new Set(agent.events.map((event) => event.type));
    expect([...types].sort()).toEqual(['charter', 'message', 'usage']);
  });
});

/**
 * A refusal ends the turn too, and is an answer rather than the absence of one.
 *
 * The model was asked for something and said what it would not do. Nothing about that is a
 * failure of the loop, so it takes the ordinary path: recorded as the agent's message,
 * returned to the parent, and replayed to the model on the next step — see `events.ts` for
 * why it is this event rather than a channel of its own.
 */
describe('a refusal is the agent’s message like any other', () => {
  it('goes back to the parent as the answer, rather than as an empty string', async () => {
    const { agent, client } = runtime([declines('I will not do that.')]);
    await expect(agent.turn('Do the thing.')).resolves.toBe('I will not do that.');
    expect(client.taken).toBe(1);
  });

  it('is written into the log, flagged as the field it came back in', async () => {
    const { agent } = runtime([declines('I will not do that.')]);
    await agent.turn('Do the thing.');
    expect(agent.events.filter((event) => event.type === 'message')).toMatchObject([
      { from: 'parent', content: 'Do the thing.' },
      { from: 'self', content: 'I will not do that.', refusal: true },
    ]);
  });

  // The consequence that outlives the turn: a step missing from the log is a step missing
  // from the conversation, and the model would meet the next message with no memory of
  // having declined the last one.
  it('is still in the conversation the next turn sends', async () => {
    const { agent, client } = runtime([declines('I will not do that.'), says('That one I can.')]);
    await agent.turn('Do the thing.');
    await agent.turn('How about this instead?');

    const sent = JSON.parse(client.requests[1] ?? '{}') as { messages: Record<string, unknown>[] };
    expect(sent.messages).toContainEqual({ role: 'assistant', content: null, refusal: 'I will not do that.' });
  });
});

describe('a step continues when capabilities are called', () => {
  it('dispatches each one, appends its result, and takes another step', async () => {
    const { agent, client } = runtime([asks(aCall('c1', 'fs', { path: '.' })), says('Two files.')]);
    await expect(agent.turn('What is here?')).resolves.toBe('Two files.');

    expect(client.taken).toBe(2);
    expect(agent.events.map((event) => event.type)).toEqual([
      'charter',
      'message',
      'tool_call',
      'usage',
      'tool_result',
      'message',
      'usage',
    ]);
    // Asserting the result succeeded, so this cannot pass on a dispatch that failed and
    // was recorded as a result anyway — which is what a missing registration looks like.
    expect(agent.events.filter((event) => event.type === 'tool_result')).toMatchObject([{ ok: true }]);
  });

  it('hands the capability the arguments the model produced', async () => {
    const capability = aCapability('fs');
    const agent = new Runtime({
      record: aRecord({ tools: ['fs'] }),
      capabilities: [capability],
      client: scripted([asks(aCall('c1', 'fs', { path: 'README.md' })), says('Read it.')]),
      clock: CLOCK,
    });
    await agent.turn('Go.');
    expect(capability.inputs).toEqual([{ path: 'README.md' }]);
  });

  it('carries the results back into what the next step sends', async () => {
    const { agent } = runtime([asks(aCall('c1', 'fs')), says('Two files.')]);
    await agent.turn('Go.');
    const messages = agent.request().messages;
    expect(messages.filter((message) => message.role === 'tool')).toMatchObject([{ content: 'done' }]);
  });
});

describe('a runtime holding no capabilities is valid', () => {
  it('reasons and produces a message to its parent, offering no tools at all', async () => {
    const agent = new Runtime({ record: aRecord({ tools: [] }), client: scripted([says('I thought about it.')]), clock: CLOCK });
    await expect(agent.turn('Think.')).resolves.toBe('I thought about it.');
    expect(agent.request().tools).toBeUndefined();
  });

  it('fails construction when its record names one that cannot be resolved', () => {
    expect(() => new Runtime({ record: aRecord({ tools: ['spawn'] }), client: scripted([]) })).toThrow(/"spawn"/);
  });

  it('does not begin a turn with a reduced set instead', async () => {
    const client = scripted([says('Done.')]);
    expect(() => new Runtime({ record: aRecord({ tools: ['fs', 'spawn'] }), capabilities: [aCapability('fs')], client })).toThrow();
    expect(client.taken).toBe(0);
  });
});

describe('the charter opens the conversation', () => {
  it('seeds it into an empty log, as the agent’s first event', async () => {
    const { agent } = runtime([says('Done.')]);
    expect(agent.events[0]).toMatchObject({ type: 'charter', content: aRecord().charter });
  });

  it('does not seed a second one into a log that already carries it', () => {
    const client = scripted([]);
    const first = new Runtime({ record: aRecord(), client, clock: CLOCK });
    const resumed = new Runtime({ record: aRecord(), events: first.events, client, clock: CLOCK });
    expect(resumed.events.filter((event) => event.type === 'charter')).toHaveLength(1);
  });
});

/**
 * The runtime is identical at every depth, and nothing here branches on `parent`. The test
 * is a comparison rather than an assertion about a field, because "no branch distinguishes
 * them" is a claim about behaviour and not about a value.
 */
describe('the root’s runtime holds nothing extra', () => {
  it('sends the same request and runs the same loop as one constructed at depth', async () => {
    const script = [asks(aCall('c1', 'fs')), says('Done.')];
    const root = runtime(script, { parent: null });
    const child = runtime(script, { parent: 'agent-0' });

    await expect(root.agent.turn('Go.')).resolves.toBe('Done.');
    await expect(child.agent.turn('Go.')).resolves.toBe('Done.');

    expect(root.client.requests).toEqual(child.client.requests);
    expect(root.agent.events).toEqual(child.agent.events);
  });

  it('offers the same operations to both', () => {
    const root = runtime([], { parent: null }).agent;
    const child = runtime([], { parent: 'agent-0' }).agent;
    const operations = (agent: Runtime) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(agent) as object).sort();
    expect(operations(root)).toEqual(operations(child));
    expect(operations(root)).toEqual(['constructor', 'events', 'request', 'run', 'turn']);
  });

  // The runtime implements none of them. `spawn` and the rest arrive as capabilities like
  // anything else, which is what keeps a runtime from holding authority one below it lacks.
  it('names no operation that provisions, destroys, or routes', () => {
    const operations = Object.getOwnPropertyNames(Runtime.prototype).join(' ');
    expect(operations).not.toMatch(/spawn|send|await|stop|sandbox|provision|destroy|route/i);
  });
});

/**
 * The log is the substrate's only verification surface: a parent that cannot reconstruct
 * what a child did from it has no way to catch a confident lie, and a claim an agent writes
 * about itself is exactly as forgeable as the prose beside it. What makes that possible is
 * the part the provider's message array cannot carry — when a step happened, what it cost,
 * and how each invocation went.
 */
describe('the log carries what the message array cannot', () => {
  it('records when each step occurred and what it cost in tokens', async () => {
    const client = scripted([
      { content: '', calls: [aCall('c1', 'fs')], usage: { in: 412, out: 17, model: 'a-model' } },
      { content: 'Done.', usage: { in: 480, out: 4, model: 'a-model' } },
    ]);
    const agent = new Runtime({
      record: aRecord({ tools: ['fs'] }),
      capabilities: [aCapability('fs')],
      client,
      clock: CLOCK,
    });
    await agent.turn('Go.');

    expect(agent.events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', at: new Date(CLOCK()).toISOString(), in: 412, out: 17, model: 'a-model' },
      { type: 'usage', at: new Date(CLOCK()).toISOString(), in: 480, out: 4, model: 'a-model' },
    ]);
    expect(agent.events.every((event) => typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at)))).toBe(true);
  });

  it('records each invocation’s duration and whether it succeeded', async () => {
    let tick = 0;
    const agent = new Runtime({
      record: aRecord({ tools: ['fs', 'boom'] }),
      capabilities: [
        aCapability('fs'),
        aCapability('boom', () => {
          throw new Error('no');
        }),
      ],
      client: scripted([asks(aCall('c1', 'fs'), aCall('c2', 'boom')), says('Done.')]),
      // Advances once per reading, so a duration that was never measured reads as zero.
      clock: () => 1_767_225_600_000 + tick++ * 5,
    });
    await agent.turn('Go.');

    expect(agent.events.filter((event) => event.type === 'tool_result')).toMatchObject([
      { id: 'c1', ok: true, ms: 5 },
      { id: 'c2', ok: false, ms: 5 },
    ]);
  });

  // None of it reaches the model. The transcript is richer than the conversation, which is
  // the whole reason it is stored as events rather than as what was sent.
  it('sends none of it to the model', async () => {
    const client = scripted([says('Done.')]);
    const agent = new Runtime({ record: aRecord({ tools: [] }), client, clock: CLOCK });
    await agent.turn('Go.');
    expect(client.requests[0]).not.toMatch(/"at"|"ms"|"ok"|"usage"|tokens/);
  });
});

/**
 * The log leaves the process as it grows, not when the agent stops.
 *
 * `events` is still the truth and still returns the array; the callback only decides when a
 * copy of it leaves. So the property worth asserting is that the two never disagree — an
 * event the log carries that nothing outside the process heard about is a step a resumed
 * agent silently repeats, which looks exactly like an agent that behaved.
 */
describe('events are emitted as they are appended', () => {
  function emitting(script: Parameters<typeof scripted>[0]) {
    const emitted: { type: string }[] = [];
    const agent = new Runtime({
      record: aRecord({ tools: ['fs'] }),
      capabilities: [aCapability('fs')],
      client: scripted(script),
      clock: CLOCK,
      emit: (event) => emitted.push(event),
    });
    return { agent, emitted };
  }

  it('emits exactly the log, in the order the log holds it', async () => {
    const { agent, emitted } = emitting([asks(aCall('c1', 'fs')), says('Done.')]);
    await agent.turn('Go.');

    expect(emitted).toEqual(agent.events);
  });

  it('emits a step’s events before the step after it is taken', async () => {
    let seen: string[] = [];
    const client = scripted([asks(aCall('c1', 'fs')), says('Done.')]);
    const emitted: { type: string }[] = [];
    const agent = new Runtime({
      record: aRecord({ tools: ['fs'] }),
      capabilities: [
        aCapability('fs', () => {
          // Read from inside the first step's own capability call: everything the step
          // decided is already out, and nothing of the step after it can be.
          seen = emitted.map((event) => event.type);
          return { content: 'done', ok: true };
        }),
      ],
      client,
      clock: CLOCK,
      emit: (event) => emitted.push(event),
    });

    await agent.turn('Go.');
    expect(seen).toEqual(['charter', 'message', 'tool_call', 'usage']);
  });

  it('emits the charter it seeds for a log that has none', () => {
    const { emitted } = emitting([says('Done.')]);
    expect(emitted).toMatchObject([{ type: 'charter', content: aRecord().charter }]);
  });

  /**
   * The collision the supervisor's whole suspension design is built around, from this side:
   * a log ending in an unanswered call gets one synthesized, and that answer has to reach
   * the store or the next boot synthesizes it again.
   */
  it('emits the answer it synthesizes for a call the log left outstanding, and nothing already in it', () => {
    const prior = [
      { type: 'charter' as const, at: 'x', content: aRecord().charter },
      { type: 'message' as const, at: 'x', from: 'parent' as const, content: 'Go.' },
      { type: 'tool_call' as const, at: 'x', id: 'c1', name: 'fs', arguments: '{}' },
      { type: 'usage' as const, at: 'x', in: 1, out: 1, model: 'scripted' },
    ];
    const emitted: { type: string }[] = [];
    new Runtime({
      record: aRecord({ tools: ['fs'] }),
      capabilities: [aCapability('fs')],
      client: scripted([]),
      clock: CLOCK,
      events: prior,
      emit: (event) => emitted.push(event),
    });

    expect(emitted).toMatchObject([{ type: 'tool_result', id: 'c1', ok: false }]);
  });
});
