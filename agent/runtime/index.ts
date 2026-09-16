/**
 * The runtime: the process an agent *is* while it works.
 *
 * **Every sandbox carries this same runtime, the root's included.** There is no
 * construction path, argument or configuration by which one differs in kind from another,
 * and nothing here implements spawning, message routing or sandbox lifecycle. A runtime
 * that implemented the capabilities its children call would leave the agent nobody spawned
 * holding something a spawned one lacks, and homogeneity would be over at its first line.
 * What an agent may do comes from its *record*, never from its runtime — see
 * `capability.ts`.
 *
 * **The loop is the runtime's own.** It decides when to call the model, dispatches what the
 * model calls, appends the results, and decides when the exchange is over. It is not
 * delegated to a client library, a framework, or the coding assistant. The assistant is a
 * capability an agent reaches for; if the assistant's loop were the agent's loop, reaching
 * it through an adapter would mean nothing, because the agent's behaviour would change
 * wholesale with the assistant rather than one of its tools changing.
 *
 * One **step** is one model call plus the results of the capabilities it invoked. One
 * **turn** is a message from the parent through to the agent's reply. A turn ends when the
 * model returns content with no calls outstanding — that content *is* the message to the
 * parent. There is no completion channel and no status field an agent writes.
 */
import { answerInterrupted, type Event } from './events.ts';
import { declare, dispatch, resolveCapabilities, type Capability } from './capability.ts';
import { project } from './projection.ts';

import type { AgentRecord } from '../record.ts';
import type { ModelClient, ModelRequest } from './model.ts';

export interface RuntimeOptions {
  record: AgentRecord;
  /** Everything that has happened so far. Empty denotes an agent that has not yet run. */
  events?: readonly Event[];
  /** What is offered to resolve the record's tool names against. */
  capabilities?: readonly Capability[];
  client: ModelClient;
  /** Milliseconds since the epoch. Injected so a test can hold the transcript still. */
  clock?: () => number;
  /**
   * Called as each event is appended, before anything else happens.
   *
   * **This decides when a copy of the log leaves the process, and nothing else.** The array
   * is still the truth and {@link Runtime.events} still returns it; the loop, the
   * projection, the record and the capability surface are unaware this exists. A container
   * may end at any moment, and a transcript emitted when the agent stops is a transcript
   * lost in exactly the case it exists for.
   *
   * Events are emitted **in the order they sit in the log**, which for everything the loop
   * appends is the order they were decided. The one event that is not appended at the end
   * is the charter, and it is added only to a log that carries none — an empty one, for any
   * agent a supervisor manages — so the two orders agree and a listener that appends what
   * it is given ends up with the same array.
   */
  emit?: (event: Event) => void;
}

export class Runtime {
  readonly #record: AgentRecord;
  readonly #registry: ReadonlyMap<string, Capability>;
  readonly #client: ModelClient;
  readonly #clock: () => number;
  readonly #emit: (event: Event) => void;
  #events: Event[];

  /**
   * Construct from a record and a prior log.
   *
   * Three things happen here and none of them is conditional on how the agent came to
   * exist. The record's capability names are resolved, failing outright if one cannot be —
   * an agent silently given fewer capabilities than its record grants has a charter it
   * cannot carry out and no way to discover why. Any capability call the log left
   * unanswered is answered. And a log with no charter in it gets one, which is what makes
   * an empty log a valid starting point rather than a special case.
   */
  constructor(options: RuntimeOptions) {
    this.#record = options.record;
    this.#client = options.client;
    this.#clock = options.clock ?? Date.now;
    this.#emit = options.emit ?? (() => {});
    this.#registry = resolveCapabilities(options.record.tools, options.capabilities ?? []);

    const prior = options.events ?? [];
    const events = answerInterrupted(prior, () => this.#at());
    this.#events = events.some((event) => event.type === 'charter')
      ? events
      : [{ type: 'charter', at: this.#at(), content: options.record.charter }, ...events];

    // Construction appends too — the charter for a log with none, and an answer for every
    // call the log left outstanding — and those are events like any other. Emitting them
    // here is what makes "the events emitted are the transcript" true of the whole log
    // rather than of the part the loop happened to produce. Identity against the log we
    // were handed, because `answerInterrupted` returns the same objects where it adds
    // nothing, so nothing already stored is emitted a second time.
    const held = new Set<Event>(prior);
    for (const event of this.#events) if (!held.has(event)) this.#emit(event);
  }

  /** The transcript as it stands. A copy: the log is appended to here and nowhere else. */
  get events(): Event[] {
    return [...this.#events];
  }

  /** What would be sent if a step were taken right now. The only projection there is. */
  request(): ModelRequest {
    const tools = declare(this.#registry);
    return {
      model: this.#record.model.model,
      messages: project(this.#events),
      ...(tools.length === 0 ? {} : { tools }),
    };
  }

  /** Take a message from the parent, and work until there is an answer for it. */
  async turn(content: string): Promise<string> {
    this.#append({ type: 'message', at: this.#at(), from: 'parent', content });
    return this.run();
  }

  /**
   * Work from wherever the log stands.
   *
   * This is the entry a resumed agent uses, and it is deliberately the same one `turn` uses
   * once it has appended the parent's message. A runtime reconstructed in the middle of a
   * turn continues that turn; one reconstructed at a boundary waits to be given the next
   * message. Neither is a mode, and nothing here asks which happened.
   */
  async run(): Promise<string> {
    // Nothing fires this yet. It is threaded through so that a capability which blocks on
    // the supervisor has somewhere to hear about a suspension without every implementation
    // being revised to take a parameter it did not have.
    const { signal } = new AbortController();

    for (;;) {
      const step = await this.#client.step(this.request(), signal);

      // Emission order is fixed here and read by the projection: reasoning, then the
      // agent's own words, then the calls it made. All three fold into one assistant
      // message, and a different order here would be different bytes on the wire.
      if (step.reasoning !== null) {
        this.#append({ type: 'reasoning', at: this.#at(), ...step.reasoning });
      }
      if (step.content !== '') {
        this.#append({ type: 'message', at: this.#at(), from: 'self', content: step.content });
      }
      // A refusal is the agent's message too — the model was asked for something and said
      // what it would not do. Recorded as one so a parent reading the transcript finds an
      // answer where the turn ended, and so the projection has it to replay; the flag is
      // what keeps it out of `content` on the way back. See `events.ts`.
      if (step.refusal !== null) {
        this.#append({ type: 'message', at: this.#at(), from: 'self', content: step.refusal, refusal: true });
      }
      for (const call of step.calls) {
        this.#append({ type: 'tool_call', at: this.#at(), id: call.id, name: call.name, arguments: call.arguments });
      }
      this.#append({ type: 'usage', at: this.#at(), ...step.usage });

      // Content with nothing outstanding is the whole of the ending. A model that produced
      // neither content nor a call has also ended it — there is nothing to take another
      // step on, and looping would be looping forever. A refusal ends it the same way and
      // goes back as the answer: an empty string here would hand the parent the least
      // diagnosable failure there is, a turn that finished and said nothing.
      if (step.calls.length === 0) return step.content !== '' ? step.content : (step.refusal ?? '');

      for (const call of step.calls) {
        const result = await dispatch(this.#registry, call, signal, this.#clock);
        this.#append({
          type: 'tool_result',
          at: this.#at(),
          id: call.id,
          content: result.content,
          ok: result.ok,
          ms: result.ms,
        });
      }
    }
  }

  /**
   * The one place the log grows, which is what makes emission structural.
   *
   * A `push` elsewhere would be an event the log carries and nothing outside the process
   * ever hears about — and the failure would be a resumed agent quietly missing a step,
   * which looks exactly like an agent that behaved.
   */
  #append(event: Event): void {
    this.#events.push(event);
    this.#emit(event);
  }

  #at(): string {
    return new Date(this.#clock()).toISOString();
  }
}

export { CapabilityError, type Capability, type CapabilityResult } from './capability.ts';
export { EventLogError, type Event } from './events.ts';
export { ModelError, openAIClient, type ModelClient, type ModelRequest, type ModelStep } from './model.ts';
