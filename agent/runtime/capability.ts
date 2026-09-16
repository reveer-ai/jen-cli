/**
 * The capability surface: the one interface through which an agent reaches everything it
 * can do.
 *
 * **The runtime knows this shape and nothing else.** Not what `fs` means, not what `spawn`
 * means, not that either exists. Adding or removing a capability requires no change here,
 * and a runtime holding none at all is valid — an agent that reasons and does nothing else.
 *
 * That is not tidiness, it is the mechanism that keeps every runtime identical. The moment
 * this module contains a branch that knows what spawning is, spawning is something a
 * *runtime* does, and the runtime of the agent nobody spawned holds something the runtimes
 * below it do not. Homogeneity would end at that line.
 *
 * The same uniformity is what keeps the runtime from holding authority it should not.
 * `fs.invoke` will do real work inside the sandbox; `spawn.invoke` will write a line to the
 * supervisor and wait for the answer. {@link dispatch} cannot tell them apart and neither
 * can the model — so an agent never *holds* the ability to spawn, it only asks.
 *
 * **Every capability that ships is a supervised one**, so this interface's other half — a
 * capability that does real work inside the sandbox — is exercised only by the test suite's
 * own. That is the sandbox's one-driver problem again and it gets the same answer: a trivial
 * capability in the tests, plus the requirement that an empty registry be valid, which is
 * what forces the loop to have no capability-specific branch to begin with.
 */

/** What an invocation produced. `ok` is for the transcript; the model sees `content`. */
export interface CapabilityResult {
  content: string;
  ok: boolean;
}

export interface Capability {
  name: string;
  description: string;
  /**
   * JSON Schema for the input, sent to the provider as-is.
   *
   * Schemas rather than a validation library's types, because capabilities are resolved
   * from a list of *names* at construction — they are data, not compile-time shapes. A
   * validation library would be converted to JSON Schema at the wire anyway.
   */
  schema: object;
  /**
   * Do the thing.
   *
   * `signal` is how an invocation is told to stop. Nothing in this change aborts one — the
   * runtime passes a signal it never fires — but a capability that blocks on the supervisor
   * needs somewhere to hear about a suspension, and inventing that parameter later would
   * mean revising every implementation.
   */
  invoke(input: unknown, signal: AbortSignal): Promise<CapabilityResult>;
  /**
   * Optional running commentary, for a capability slow enough that silence is misleading.
   *
   * **Nothing reads this yet.** `dispatch` does not look at it, no capability implements it,
   * and a capability author who writes one today gets silence rather than an error — so it
   * is said here, where they would be reading, rather than left to be discovered.
   *
   * It is declared anyway because `agent-runtime` requires a capability to be *able* to
   * declare one, and the consumer is named: the supervisor's `read` (ENG-212), which is what
   * gives a parent something to watch a long invocation through. `sandbox/index.ts` refuses
   * the mirror of this and the difference is the point — there is no policy behind a sandbox
   * option nobody set, whereas this has a specified shape and a stated reader, and inventing
   * it later would mean revising every implementation written in between.
   */
  progress?(input: unknown): AsyncIterable<string>;
}

/** A capability named by a record that the runtime could not resolve. */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

/**
 * The capabilities this agent may reach, in the order its record names them.
 *
 * Built **from the record**, never from a constant of the runtime. This is the point at
 * which two agents running byte-identical runtimes come to hold unequal authority: they
 * differ because their records differ, never because one runtime carries something the
 * other does not. It is also the seam an allowlist will hang from.
 *
 * A name that cannot be resolved **fails construction**, rather than being dropped. An
 * agent silently offered fewer capabilities than its record grants has been given a charter
 * it cannot carry out and no way to find out why.
 */
export function resolveCapabilities(
  tools: readonly string[],
  available: readonly Capability[],
): Map<string, Capability> {
  const byName = new Map(available.map((capability) => [capability.name, capability]));
  const missing = tools.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new CapabilityError(
      `the record names ${missing.length === 1 ? 'a capability' : 'capabilities'} that cannot be resolved: ${missing
        .map((name) => `"${name}"`)
        .join(', ')}`,
    );
  }

  // Ordered by the record rather than by what was offered, so the declarations below are
  // the same bytes on a resume as they were on the run that was interrupted.
  return new Map(tools.map((name) => [name, byName.get(name)!]));
}

export interface ToolDeclaration {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

/** What the registry looks like to the provider. Order follows the registry's. */
export function declare(registry: ReadonlyMap<string, Capability>): ToolDeclaration[] {
  return [...registry.values()].map((capability) => ({
    type: 'function',
    function: {
      name: capability.name,
      description: capability.description,
      parameters: capability.schema,
    },
  }));
}

export interface Call {
  id: string;
  name: string;
  arguments: string;
}

export interface Dispatched extends CapabilityResult {
  ms: number;
}

/**
 * Run one call the model asked for, and always come back with a result.
 *
 * **Every failure here is a result, never a throw.** A capability that raised, a name the
 * model made up, arguments that are not JSON — each one is something the model can read and
 * do something about on the next step, and none of them is a reason for the agent to stop
 * working. The runtime exiting on a bad tool call would make one capability's bug the whole
 * agent's ending.
 */
export async function dispatch(
  registry: ReadonlyMap<string, Capability>,
  call: Call,
  signal: AbortSignal,
  now: () => number,
): Promise<Dispatched> {
  const started = now();
  const finish = (result: CapabilityResult): Dispatched => ({ ...result, ms: now() - started });

  const capability = registry.get(call.name);
  if (capability === undefined) {
    // The model asked for something it was not offered. Telling it so is more useful than
    // failing, and it is the only account that is true.
    return finish({
      ok: false,
      content: `There is no capability named "${call.name}". The ones available are: ${
        [...registry.keys()].map((name) => `"${name}"`).join(', ') || 'none'
      }.`,
    });
  }

  let input: unknown;
  try {
    input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch (error) {
    return finish({ ok: false, content: `The arguments were not valid JSON: ${message(error)}` });
  }

  try {
    return finish(await capability.invoke(input, signal));
  } catch (error) {
    return finish({ ok: false, content: `"${call.name}" failed: ${message(error)}` });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
