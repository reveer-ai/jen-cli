/**
 * How a capability the agent does not hold becomes an ordinary one.
 *
 * `fs.invoke` will do real work inside the sandbox; `spawn.invoke` writes a line to the
 * supervisor and waits for the answer. **`dispatch` cannot tell them apart and neither can
 * the model** — which is what `capability.ts` was written to hold, and what keeps an agent
 * from ever *holding* the ability to spawn rather than only asking for it.
 *
 * **Nothing is registered here.** The registry is `main.ts`'s, which is where `spawn`,
 * `stop`, `send`, `await` and `read` are declared. What this defines is how one of them is
 * built — and the shape held for five capabilities written against it after the first two,
 * rather than being settled by whichever of them was written first.
 */
import type { AgentRecord } from '../record.ts';
import type { Capability, CapabilityResult } from './capability.ts';

/**
 * Raise a request and wait for its answer.
 *
 * `residency` is the agent's own instruction about how long its body should be kept while
 * this is outstanding, in milliseconds — see `../protocol.ts`. It is a parameter rather
 * than something the channel decides, because the party that knows is the one that just
 * decided what it dispatched.
 */
export type Raise = (kind: string, input: unknown, residency: number) => Promise<CapabilityResult>;

/**
 * Raise a request of this declaration's own kind, and wait for its answer.
 *
 * {@link Raise} with the name and the residency already supplied, which is the whole of the
 * difference: a declaration composing its own invocation still must not be the place its own
 * name is spelled a second time, and it has no business naming another capability's kind.
 */
export type Ask = (input: unknown) => Promise<CapabilityResult>;

/** What a declaration that composes local work with its requests is handed. */
export interface Composing {
  /** What the model supplied, exactly as it wrote it and checked against nothing. */
  input: unknown;
  /** The request channel, bound to this declaration's kind. Callable more than once. */
  ask: Ask;
  /**
   * The agent's own record.
   *
   * Here because work done *in place* happens somewhere, and the only honest answer to
   * where is this agent's own workspace — the same reason `workspace.ts`'s `local()` takes
   * one. Every declaration is handed it whether it composes or not, which keeps this from
   * being a parameter that says which capability is special.
   */
  record: AgentRecord;
  /** How an invocation is told to stop. See {@link Capability.invoke}. */
  signal: AbortSignal;
}

export interface SupervisedCapability {
  name: string;
  description: string;
  schema: object;
  /**
   * How long this agent wants its body kept, read from what the model asked for.
   *
   * Absent means zero, which is the absence of a request rather than a choice made on the
   * agent's behalf. A capability that is not a suspension leaves it out; one that is —
   * `await` — reads the number the model named out of its own input, which is the only
   * place it can come from without a constant appearing somewhere no charter can reach.
   *
   * **What arrives here is what the model wrote, and nothing has checked it against the
   * schema beside it.** `dispatch` parses the call's JSON and invokes; a declared
   * `type: integer` does not stand between a model and a `keep` of `"60000"`. So a hook
   * guards rather than trusts, and the reason is the blast radius rather than tidiness:
   * returning something `../protocol.ts`'s `count()` refuses makes the *request frame*
   * unreadable at the supervisor, so there is no request and no answer, and the agent is
   * left on a call that never returns — strictly worse than the residency being wrong.
   *
   * It reads whatever is about to be raised, which for a composing declaration is that
   * declaration's own wire input rather than the model's. The two are the same input
   * everywhere else, and a capability that both suspends its body and pages the supervisor
   * does not exist; when one does, this is where the difference will need saying.
   */
  residency?(input: unknown): number;
  /**
   * The whole of the invocation, where raising once and returning the answer is not it.
   *
   * A declaration with one of these may look at an answer before the loop does, may raise
   * again off the back of it, and may do work in the agent's own sandbox in between —
   * `read` fetches a transcript in pages and writes it to the workspace, and is the only
   * one today. **Nothing about it reaches outside this function.** `dispatch` invokes it by
   * the same call it makes for every other capability, the loop records the result the same
   * way, and the protocol carries the same request frames; where an invocation's own body
   * does its work is not a thing any of the three can observe.
   *
   * Which is why the hook is here rather than a third kind beside {@link supervised} and
   * `local()`: the substrate's two disjoint kinds were a fact about the capabilities that
   * existed, not a constraint the runtime imposes, and the rule that actually matters is
   * that no capability has a path of its own through the loop, the dispatcher or the
   * protocol. This one does not.
   *
   * **A failure is this invocation's result, never a throw.** `dispatch` would convert one
   * anyway; returning it is what lets the message name what the capability was doing.
   */
  compose?(context: Composing): Promise<CapabilityResult>;
}

/** Turn a supervisor-backed request into something `dispatch` cannot distinguish. */
export function supervised(declaration: SupervisedCapability, raise: Raise, record: AgentRecord): Capability {
  const ask: Ask = (input) => raise(declaration.name, input, declaration.residency?.(input) ?? 0);
  return {
    name: declaration.name,
    description: declaration.description,
    schema: declaration.schema,
    // The default is the composition of one raise and nothing else, spelled as the absence
    // of a hook rather than as a hook every declaration has to supply — so a declaration
    // written before this existed behaves exactly as it did.
    invoke: (input, signal) =>
      declaration.compose === undefined ? ask(input) : declaration.compose({ input, ask, record, signal }),
  };
}
