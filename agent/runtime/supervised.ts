/**
 * How a capability the agent does not hold becomes an ordinary one.
 *
 * `fs.invoke` will do real work inside the sandbox; `spawn.invoke` writes a line to the
 * supervisor and waits for the answer. **`dispatch` cannot tell them apart and neither can
 * the model** — which is what `capability.ts` was written to hold, and what keeps an agent
 * from ever *holding* the ability to spawn rather than only asking for it.
 *
 * **Nothing is registered here.** The registry is `main.ts`'s, which is where `spawn` and
 * `stop` are declared and where `send`, `await` and `read` will be. What this defines is how
 * one of them is built — and the shape held for five capabilities written against it after
 * the first two, rather than being settled by whichever of them was written first.
 */
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

export interface SupervisedCapability {
  name: string;
  description: string;
  schema: object;
  /**
   * How long this agent wants its body kept, read from what the model asked for.
   *
   * Absent means zero, which is the absence of a request rather than a choice made on the
   * agent's behalf. A capability that is not a suspension leaves it out; one that is — the
   * `await` ENG-198 builds — reads the number the model named out of its own input, which
   * is the only place it can come from without a constant appearing somewhere no charter
   * can reach.
   */
  residency?(input: unknown): number;
}

/** Turn a supervisor-backed request into something `dispatch` cannot distinguish. */
export function supervised(declaration: SupervisedCapability, raise: Raise): Capability {
  return {
    name: declaration.name,
    description: declaration.description,
    schema: declaration.schema,
    invoke: (input) => raise(declaration.name, input, declaration.residency?.(input) ?? 0),
  };
}
