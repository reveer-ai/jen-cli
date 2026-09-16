/**
 * Test support: the records and logs every suite here starts from.
 *
 * Not imported by anything the substrate runs. It lives beside the sources rather than
 * under a test directory because the substrate keeps its tests beside its sources, and a
 * builder that drifts from the type it builds is caught by the same typecheck as the rest.
 */
import type { AgentRecord } from './record.ts';
import type { Call, Capability, CapabilityResult } from './runtime/capability.ts';
import type { ModelClient, ModelStep } from './runtime/model.ts';

/**
 * Every capability the supervisor routes.
 *
 * For the tiers that cannot name what they use: an integration test drives a whole tree
 * through a shell peer whose script decides what it calls, so there is nothing at the test's
 * own level that could name a narrower set honestly. A unit test is not in that position and
 * should not reach for this — see {@link aRecord}.
 */
export const EVERY_CAPABILITY = ['spawn', 'stop', 'send', 'await', 'read'];

/**
 * A complete, valid record. Every field is filled, because a builder that left optional
 * gaps would let a test pass against a record no supervisor would ever produce.
 *
 * **`tools` is empty, and stays empty.** The supervisor refuses any request whose kind the
 * caller's record does not name, so a test that drives one has to say so — which is the
 * honest default: it makes the authority a test needed part of what the test says, and a
 * test that stopped needing one stops claiming it. Defaulting to everything would let a test
 * pass without ever stating what it was allowed to do, which is the thing the grant check
 * exists to make impossible for an agent.
 */
export function aRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-1',
    name: 'scout',
    charter: 'Find out what is in the repository and report back.',
    model: {
      provider: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-5',
      credential: 'MODEL_API_KEY',
    },
    workspace: '/workspace',
    environment: 'jen/agent:latest',
    tools: [],
    credentials: [{ name: 'MODEL_API_KEY', ref: 'env:JEN_MODEL_API_KEY' }],
    parent: null,
    ...overrides,
  };
}

/**
 * A model that says exactly what it was told to say, and writes down what it was asked.
 *
 * Every loop and resume test runs against this and never against a live model. The property
 * those tests are about is *what the runtime sends*, and a real model makes that comparison
 * non-deterministic for reasons that have nothing to do with what is under test.
 *
 * `requests` holds each request as it was serialized, which is what byte-identity is
 * claimed about — `toEqual` on the objects would not see key order, and key order is part
 * of what a provider's prompt cache keys on.
 */
export interface ScriptedClient extends ModelClient {
  requests: string[];
  taken: number;
}

export function scripted(script: readonly Partial<ModelStep>[]): ScriptedClient {
  const client: ScriptedClient = {
    requests: [],
    taken: 0,
    step(request) {
      client.requests.push(JSON.stringify(request));
      const step = script[client.taken];
      client.taken += 1;
      if (step === undefined) {
        throw new Error(`the script has ${script.length} steps and the loop asked for ${client.taken}`);
      }
      return Promise.resolve({
        content: step.content ?? '',
        refusal: step.refusal ?? null,
        calls: step.calls ?? [],
        reasoning: step.reasoning ?? null,
        usage: step.usage ?? { in: 0, out: 0, model: 'scripted' },
      });
    },
  };
  return client;
}

/** A step that ends the turn. */
export function says(content: string): Partial<ModelStep> {
  return { content };
}

/** A step in which the model declined. It ends the turn the way any other answer does. */
export function declines(refusal: string): Partial<ModelStep> {
  return { refusal };
}

/** A step that calls capabilities and therefore does not end the turn. */
export function asks(...calls: Call[]): Partial<ModelStep> {
  return { calls };
}

/**
 * A capability that does whatever the test needs, and records that it was reached.
 *
 * Nothing else in this change exercises the capability interface — no capability ships in
 * it — so this is the only thing standing in for one. It is the sandbox's one-driver
 * problem again, held the same way.
 */
export function aCapability(
  name: string,
  invoke: (input: unknown) => Promise<CapabilityResult> | CapabilityResult = () => ({ content: 'done', ok: true }),
): Capability & { inputs: unknown[] } {
  const capability: Capability & { inputs: unknown[] } = {
    name,
    description: `A capability called ${name}.`,
    schema: { type: 'object', properties: { value: { type: 'string' } } },
    inputs: [],
    async invoke(input) {
      capability.inputs.push(input);
      return invoke(input);
    },
  };
  return capability;
}

/** A call the model made, as the loop receives it. */
export function aCall(id: string, name: string, args: Record<string, unknown> = {}): Call {
  return { id, name, arguments: JSON.stringify(args) };
}
