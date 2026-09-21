/**
 * The supervisor: the one component outside every sandbox, and the only one that is not an
 * agent.
 *
 * It holds what no agent may — provisioning and destroying sandboxes, moving messages
 * between agents, and storing records and transcripts — because the alternatives fail. A
 * parent servicing its children's requests leaves the agent nobody spawned needing a path
 * none of the others use, which makes the root structurally special. A sandbox-provisioning
 * capability inside every runtime is homogeneous, and it grants every agent at every depth
 * authority over the machine equal to the runtime's own, and it requires a parent's body to
 * outlive every descendant that might still run — which forecloses suspension entirely.
 *
 * **It holds no reasoning, and that is the price of existing at all.** It encodes no rule
 * about what a role may do, does not decide when an agent has finished, does not decide how
 * long a body should be kept, and does not resolve a stalled tree. Every behaviour it grows
 * that an agent could have expressed instead is a policy moved out of the weights and into
 * code, where no charter can reach it. It is the component to keep smallest.
 *
 * ## Two lifetimes, and only one of them is what residency is about
 *
 * An **agent** exists because its record exists. It starts at spawn and ends only at `stop`;
 * there is no completed state, and a child that has reported is dormant rather than
 * finished. Its **body** is a sandbox, which exists only while the agent is thinking and is
 * created and destroyed many times over one agent's life. None of that appears in the
 * agent's transcript.
 *
 * ## The one thing to get right
 *
 * A deliberately suspended `await` and a process killed mid-call leave the stored log in
 * **exactly the same shape** — a call with no result — and `answerInterrupted` runs on every
 * construction and cannot tell them apart. A naively resumed agent would therefore be told
 * its `await` was interrupted, reason about a failure that never happened, and leave a
 * transcript that looks fine.
 *
 * Three things follow, and they are the spine of this file. State is **stored** rather than
 * inferred, because inferring it from the log is exactly what cannot work. The answering
 * result is appended to the log **before** the body boots, so the runtime constructs on a
 * complete log and `answerInterrupted` finds nothing to do. And `await` stays an ordinary
 * correlated request, so suspension is something that happens *to* an agent rather than
 * something its runtime has a code path for.
 */
import { encode, parseFromAgent, lines, ProtocolError } from '../protocol.ts';
import { Store, StoreError, type AgentState, type Message, type StoredAgent } from './store.ts';

import type { AgentRecord } from '../record.ts';
import type { Event } from '../runtime/events.ts';
import type { FromAgent, RequestFrame } from '../protocol.ts';
import type { Process, Sandbox, SandboxDriver } from '../sandbox/index.ts';

/** What a request the supervisor could not carry out is reported as. */
export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisorError';
  }
}

/**
 * What a failure to give an agent a body is reported as, and the whole of how settling tells
 * that failure from any other.
 *
 * **Settling catches this and nothing else**, so the class boundary is load-bearing: what it
 * covers becomes a message to the agent's parent, and what it does not keeps the exit it
 * always had — out through `#settle` to the request in flight, or to `onFailure` from a frame
 * that has no request to fail into. A store that could not be written is the supervisor's own
 * trouble whether or not it happened to fail underneath a boot, and a parent told `<id> could
 * not be given a body: the store is gone` would be handed a judgment — retry, replace,
 * escalate — about a machine it has no reach into.
 *
 * **It is applied at the seam that knows**, around the driver's own calls in `#boot`, rather
 * than sniffed for by the catch. Sniffing asks the error what it is; `#boot` knows which call
 * it made. The difference shows the first time a driver throws something it did not construct
 * itself, or a store starts throwing something that looks driver-shaped.
 */
export class UnprovisionedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnprovisionedError';
  }
}

/**
 * Run the driver's part of a boot, and mark whatever comes out of it.
 *
 * The message is carried through unchanged because it is what the agent's parent is told, and
 * the original is kept as `cause` for whoever is reading a log rather than a mailbox.
 */
async function provisioning<T>(what: () => Promise<T>): Promise<T> {
  try {
    return await what();
  } catch (error) {
    throw new UnprovisionedError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/**
 * How the substrate's own words are marked where an agent reads them.
 *
 * The flag on the message is the structural half and this is the half the model sees. Both
 * are needed: a parent reasoning about a child's report has only the text in front of it,
 * and a report of a death that read like the child's own last words would be the substrate
 * misleading a parent about who spoke.
 */
export const SUBSTRATE = '[substrate]';

/**
 * What the root calls the agent above it.
 *
 * The root's parent is the human, and a human has no agent id to be addressed by — so
 * messaging upward from the root needs one name, and this is it. Only the root can mean it:
 * for every other agent it is an ordinary string matching no relation it has, and a child's
 * id is built from its parent's with a `-`, so no real agent can be addressed by it either.
 *
 * It is the name and not the route. The route is `null`, which is what {@link
 * SupervisorOptions.onMessage} has always been reached by and what a root's own termination
 * report already travels on; this is only how an agent says it.
 */
export const HUMAN = 'human';

/**
 * Who sent it, as the recipient reads it.
 *
 * A parent holding four children has four conversations in one mailbox, and without this it
 * has nothing to tell them apart — which takes away the substrate's own answer to a message
 * that arrived from the wrong child, that the agent reads who sent it and decides.
 *
 * The substrate's mark is unchanged and does not gain a sender. Its content already names
 * the agent it concerns, and the question that mark answers — whether these are an agent's
 * words at all — is the prior one.
 */
function mark(message: Message): string {
  if (message.substrate === true) return SUBSTRATE;
  return message.from === null ? '[from the human]' : `[from ${message.from}]`;
}

/**
 * Keep an agent's own words out of the mark position.
 *
 * A mark is text and the message beside it is text some other agent wrote, so nothing but
 * this separates them. A child opening its report with `[substrate] ...` — quoting a message
 * it was itself sent, which is how a confused agent reaches this rather than a hostile one —
 * would otherwise be read by its parent as a death.
 *
 * One character, at one position, because one position is what a mark can occupy. A
 * mark-shaped string in the *middle* of a message is deliberately left alone: escaping every
 * occurrence mangles any message that legitimately discusses the substrate's output,
 * including a parent asking a child about a report it received.
 */
function unmarked(content: string): string {
  return content.startsWith('[') ? `\\${content}` : content;
}

/** What an agent is handed when a message is delivered to it. */
export function render(message: Message): string {
  // The substrate's own report is not escaped, and what makes that safe is *position* rather
  // than authorship. The report may carry an agent's own bytes — {@link Supervisor.#ended}
  // appends an ended body's last words to it — but always behind `<id>'s body ended: `, so
  // position 0 is the substrate's throughout and there is nothing there to escape. Escaping
  // anyway would put a backslash in front of every death report the mark starts.
  //
  // This rests on {@link unmarked} guarding position 0 and no other. Anything that widened
  // it to every occurrence would have to revisit this branch rather than keep it, because
  // what is downstream of the mark here is no longer only the substrate's own words.
  return `${mark(message)} ${message.substrate === true ? message.content : unmarked(message.content)}`;
}

/**
 * A stall, as a line for a person.
 *
 * Exported for the same reason {@link render} is: the operator is the real consumer, and a
 * sentence each caller writes for itself is one each caller gets subtly wrong. What it has
 * to carry is which agents are the cause — a run halted by a body that ended names that
 * agent, and a report that listed it among the waiting would name everything except the
 * thing to look at.
 *
 * **The ordinary deadlock keeps the sentence it had.** Nothing stopped means every agent is
 * waiting on something that is not coming, which is usually a question the person can
 * answer, and that case should not be made to read like a failure.
 */
export function describeStall(
  run: string,
  stalled: { waiting: readonly string[]; stopped: readonly string[] },
): string {
  if (stalled.stopped.length === 0) {
    return `every agent in ${run} is waiting and nothing is pending: ${stalled.waiting.join(', ')}`;
  }
  const waiting = stalled.waiting.length === 0 ? '' : `, and waiting: ${stalled.waiting.join(', ')}`;
  return `nothing in ${run} can make progress. stopped: ${stalled.stopped.join(', ')}${waiting}`;
}

/** What a body is, for as long as there is one. */
interface Body {
  sandbox: Sandbox;
  process: Process;
  timer?: ReturnType<typeof setTimeout>;
  /** Set where the supervisor is the one ending it, so its exit is not read as a death. */
  intended?: true;
  /**
   * A message this body was handed and has not yet said it recorded.
   *
   * **The one thing the supervisor gives away without writing down first.** A message that
   * answers an outstanding call reaches a dormant agent through `#answerInLog`, which is
   * durable by construction; a message that *begins a turn* is written by the runtime, as
   * the first act of `turn()`, so between `#say` and the event coming back it exists in a
   * pipe and nowhere else. It has already left the mailbox, because `#deliver` takes it out
   * before it hands it over.
   *
   * Which is survivable for a body that *dies* — the exit is a termination its parent can
   * act on — and is not survivable for one the supervisor ends itself, because an intended
   * ending is reported to nobody. `shutdown()` straight after a `tell()` is the ordinary
   * way to reach it, and what it costs is a person's instruction, silently: gone from the
   * mailbox, absent from the log, and the agent left recorded as `working` on a transcript
   * that has nothing new in it.
   */
  handed?: Message;
  /**
   * Frames on their way to this body, in the order they were said.
   *
   * **A write to one body must never be something the rest of the run waits behind**, and
   * until this existed it was exactly that. The channel is a pipe with a finite buffer and
   * the process at the far end is one thread, so a body that has stopped reading — wedged,
   * stopped, or merely busy — is one a write to never completes. {@link Supervisor.#say}
   * used to be awaited from inside the serial queue, so that one write held every transition
   * in the run: no delivery anywhere, no frame from any other body read, no transcript
   * written. Every container still up, none of them using any CPU, and nothing able to say
   * why. That is what the live pass found, and one wedged body was the whole of what it
   * took.
   *
   * Nothing was ever waiting on the flush for its own sake: a write to a body that has gone
   * is deliberately swallowed, because its exit is already on its way to `#ended`, which is
   * where an agent that ended without speaking becomes something its parent can act on. So
   * the result was discarded the moment it arrived and the only thing the `await` bought was
   * the order — which this keeps, per body, without anyone waiting for it.
   */
  sent: Promise<void>;
  /**
   * The tail of what this body wrote on its standard error.
   *
   * **Kept because it has to be read, and reported because it is worth something.** A pipe
   * nobody reads is a pipe that fills, and this one had no reader at all. It needs no
   * misbehaviour to reach: the process at the far end blocks in a write once the buffer is
   * full, and since a container runtime carries a process's two output streams over one
   * connection, a blocked standard error stops its standard output with it. The body then
   * sits alive, idle and silent for good, its stored state still saying `working` — which
   * is indistinguishable from an agent thinking, and is the thread the whole freeze above
   * hangs from.
   *
   * Draining is therefore not optional, and what is drained may as well be what it is: a
   * runtime that could not read its boot frame says why here and nowhere else, so
   * {@link Supervisor.#ended} hands it to the parent being told this agent will not speak.
   */
  said: string;
}

/**
 * How much of a body's standard error is kept.
 *
 * A bound rather than a policy, and the distinction is what makes a number acceptable in
 * this file at all: it decides how much of a diagnostic is held in memory, not anything
 * about what an agent may do or how long it may take. It has to be bounded, because a body
 * can write without limit and this process is holding every agent in the run.
 *
 * The **tail** rather than the head, because the failure is at the end. A runtime that could
 * not read its boot frame says so in one line and exits; one that died deep in a turn is
 * explained by its last words rather than by its first.
 */
const SAID = 4096;

export interface SupervisorOptions {
  store: Store;
  driver: SandboxDriver;
  /**
   * What a sandbox runs to become an agent.
   *
   * A value rather than a constant, because the substrate's own entry point is what a real
   * sandbox carries and a test drives something far smaller. Nothing here reads it.
   */
  command?: string[];
  /**
   * Where a message the root addresses to its parent goes.
   *
   * The root's parent is the human. A message it sends upward has to reach one, and a human
   * addressing the root comes back through {@link Supervisor.tell} — the same path a
   * parent's message takes, because the human is a participant in this graph rather than an
   * exception to it.
   *
   * It defaults to a line on standard error for the reason {@link onStalled} does, and for
   * one that is this hook's alone: `send` answers its caller `delivered to human`, so a
   * default of nothing is the substrate telling an agent its message landed somewhere it
   * did not. Silence was defensible while the only things arriving here were a root's
   * turn-end report and its termination report, neither of which is acknowledged to
   * anyone. An agent that can call `send` and be answered is what ended that.
   *
   * **What arrives is the raw {@link Message}, not what an agent in the same position would
   * have been handed.** Every other recipient is delivered `render(message)`; this is the
   * one path that skips it, so the sender's mark is absent and — the part that costs
   * something — {@link render}'s escape has not been applied, the escape that exists so a
   * child quoting `[substrate] ...` back is not read as a death. A consumer that prints
   * `message.content` shows a person a forgery no other recipient in the substrate can be
   * shown, and the human is the one recipient who cannot ask the substrate about it. So a
   * consumer renders what it is handed; {@link render} is exported and the default below is
   * the worked example.
   */
  onMessage?: (message: Message) => void;
  /**
   * Where a stalled tree is reported.
   *
   * Reported and nothing else: no agent is woken, messaged or terminated. Choosing how to
   * break a deadlock is a judgment about the work, and the human is who the substrate has
   * for that.
   *
   * It defaults to a line on standard error rather than to silence. What "surfaced to the
   * human" should concretely mean is genuinely open — a log line, an exit, something an
   * interface renders — and the interface that would consume it does not exist yet. But a
   * default of nothing would make a stalled tree indistinguishable from a working one for
   * every caller that has not thought about it, which is the one outcome the requirement
   * exists to prevent.
   *
   * **It names what stopped as well as what is waiting**, because those want different
   * things from the person reading them. An agent that is merely waiting is behaving, and
   * a stall of nothing but those is the ordinary deadlock — a question nobody answered.
   * An agent whose body ended, or one that could not be given a body at all, is the cause
   * rather than a participant, and a report that listed it among the waiting would name
   * everything except the thing to look at.
   */
  onStalled?: (stalled: { waiting: readonly string[]; stopped: readonly string[] }) => void;
  /**
   * Where the supervisor's own trouble goes.
   *
   * Not an agent's failure — a bad request is answered to the agent that made it, and a body
   * that dies is a message to its parent. This is what is left: a sandbox that could not be
   * provisioned, a store that could not be written, a channel that broke while being read.
   * None of it is anything an agent can act on and all of it is something a human needs to
   * know, and the alternative to a destination is an unhandled rejection ending the one
   * process that is holding every agent in the run.
   *
   * It defaults to standard error for the same reason {@link onStalled} does.
   */
  onFailure?: (agent: string, error: unknown) => void;
  /** Milliseconds since the epoch. Injected so a test can hold the transcript still. */
  clock?: () => number;
}

export class Supervisor {
  readonly #store: Store;
  readonly #driver: SandboxDriver;
  readonly #command: string[];
  readonly #onMessage: (message: Message) => void;
  readonly #onStalled: (stalled: { waiting: readonly string[]; stopped: readonly string[] }) => void;
  readonly #onFailure: (agent: string, error: unknown) => void;
  readonly #clock: () => number;
  readonly #bodies = new Map<string, Body>();
  /**
   * The agents whose last attempt at a body failed to provision one, remembered rather than
   * stored.
   *
   * It holds down the noise and nothing else: an outage is one message to a parent instead
   * of one per request that settles during it. An id goes in when delivery to it throws an
   * {@link UnprovisionedError} and comes out the moment `#deliver` returns without throwing
   * — including its early returns, neither of which is a provisioning failure: nothing was
   * queued, or the mail was already answered with a body, and the second of those is
   * `#revived`'s to report rather than this mark's. Delivery that failed some other way
   * marks nothing, because what the mark means to the stall read below is "no body and no
   * way to get one", which a store that could not be written is not a report of.
   *
   * **Deliberately not a fourth status on the record.** In the store it would make
   * "unreachable" something an agent *is*, which needs a way back out that nothing has asked
   * for; here a supervisor that restarts earns the mark back by trying. Nothing branches on
   * it but the report above and the stall read below.
   *
   * The stall read needs it independently: "has mail and no body" describes every dormant
   * agent settling is about to wake, so only "we tried and it failed" picks out a stuck one.
   */
  readonly #unreachable = new Set<string>();
  /**
   * The agents already given a body in answer to the mail they are still holding.
   *
   * **One message buys one body.** Revival leaves the message pending — an agent continuing
   * an unfinished turn is not at the boundary where a message begins one — so without this
   * the message that triggered a revival is still at the head of the mailbox when the new
   * body dies, and `#ended` → `#settle` → `#deliver` reads it as a fresh instruction. An
   * agent that dies whenever it is given a body is then given one forever, each turn of it
   * a sandbox created, a boot, a model call and another substrate report posted into a
   * parent that is awake and spending a turn on each. One parent message, unbounded cost,
   * and nothing able to say so.
   *
   * That is the loop mail-triggering was supposed to prevent, and triggering on mail does
   * not prevent it on its own: what it rules out is a settle reviving unbidden, not one
   * instruction being re-read as a new one after every death. **A revival answers the
   * message that caused it, so a further revival wants a further message** — which is a
   * bound with no counter and no timer in it, and leaves "what is pending stays pending"
   * exactly as it was.
   *
   * An id goes in when a body is successfully provisioned for a bodiless agent, and comes
   * out when anything is posted to that agent — a second decision, which buys a second
   * body — or when the revived body reaches a turn boundary, having got somewhere. Nothing
   * goes in for a revival that could not be provisioned: no body was made, and
   * `#unprovisioned` promises the parent its message will be delivered when the agent can be
   * provisioned again.
   *
   * **The stall read needs it for the same reason it needs `#unreachable`.** Mail for an
   * agent that will not be revived again is not work about to happen either, and a bodiless
   * agent holding mail nothing will act on is invisible to the backstop without this — the
   * same silent stall in a different coat.
   */
  readonly #revived = new Set<string>();
  /**
   * Everything that changes state, one at a time.
   *
   * **Not a throughput concern — a correctness one.** Every transition here is read the
   * stored value, change it, write it back, and each of those spans an `await`. Two of them
   * interleaved on one agent lose whichever wrote first: two messages posted to the same
   * mailbox become one, and nothing reports anything. The supervisor moves messages between
   * tens of agents, so serializing the whole of it costs nothing worth measuring and removes
   * an entire category of failure that would show up as a tree quietly stopping.
   *
   * Only the outermost entry points queue. Nothing reached from inside a queued task may
   * queue again, which is why the public calls are thin wrappers over private ones.
   */
  #queue: Promise<unknown> = Promise.resolve();
  #reported = false;
  #closing = false;

  constructor(options: SupervisorOptions) {
    this.#store = options.store;
    this.#driver = options.driver;
    this.#command = options.command ?? ['jen-agent'];
    this.#onMessage =
      options.onMessage ??
      ((message) => {
        process.stderr.write(`${render(message)}\n`);
      });
    this.#onStalled =
      options.onStalled ??
      ((stalled) => {
        process.stderr.write(`${describeStall(this.#store.run, stalled)}\n`);
      });
    this.#onFailure =
      options.onFailure ??
      ((agent, error) => {
        const said = error instanceof Error ? error.message : String(error);
        process.stderr.write(`the supervisor could not carry on for ${agent}: ${said}\n`);
      });
    this.#clock = options.clock ?? Date.now;
  }

  get store(): Store {
    return this.#store;
  }

  /** Which agents currently hold a body. For a test asking what suspension actually did. */
  get resident(): string[] {
    return [...this.#bodies.keys()];
  }

  /**
   * Every agent waiting, and nothing pending anywhere that can be delivered.
   *
   * **Residency is deliberately not part of this.** A timer only decides whether a body
   * stays up; it can never produce a message, so a stalled tree is stalled whether or not
   * one is armed, and waiting for timers to expire before saying so would delay the
   * diagnosis and change nothing about it.
   *
   * **Mail that delivering would do nothing with is not work about to happen.** A pending
   * message counts here on the grounds that delivery will wake somebody. That grounds is
   * gone where delivery is what failed, and gone again where the message has already been
   * answered with a body the agent did not survive — see `#revived` — and counting it
   * anyway in either case reports a tree that has stopped as a tree that is working, the
   * one outcome this read exists to prevent. So such an agent's mailbox is read as empty,
   * and this is the backstop for a parent that was told its child had no body and did
   * nothing about it.
   *
   * **One window makes `working` with no body transient rather than terminal**, and it is
   * this getter's to know about because it is public. `#deliver` saves `working` before it
   * boots on the dormant path, so between those two lines an agent that is about to be
   * woken looks exactly like one whose body ended. Nothing in the supervisor can see it:
   * `stalled` is read from `#settle`, on the serial queue, after every `#deliver` of the
   * pass has returned. A test that reads this getter mid-delivery would.
   */
  get stalled(): boolean {
    const live = this.#live();
    if (live.length === 0) return false;
    return live.every((id) => this.#cannotMove(id));
  }

  /** Every agent that has not been dismissed. A dismissed one is finished, not stuck. */
  #live(): string[] {
    return this.#store.ids().filter((id) => this.#store.agent(id).state.status !== 'dismissed');
  }

  /**
   * One condition, covering three shapes of stuck.
   *
   * **An agent cannot move when it has nothing to act on and is not working in a body.**
   * That is the agent suspended with an empty mailbox, the agent whose mail cannot be
   * delivered because nothing can be provisioned for it, and the agent left with no body
   * and nothing pending to give it one. The last is the backstop, and it holds whatever
   * ended that agent — a signal, an OOM, a daemon that went away, a cause nobody has found
   * yet — which is what makes this a read of the whole class rather than a fix for one
   * member of it.
   *
   * The pairs it has to get right, since two of them look alike: `working` with a body can
   * move, because that is a turn in flight; `working` with no body but with mail can move,
   * because delivery is about to give it one; `working` with no body and nothing pending
   * cannot, because nothing will.
   *
   * **Mail already answered with a body does not count either**, for the same reason mail
   * to an agent nothing can provision does not: delivering it would do nothing. A revival
   * answers the message that caused it, so the message left pending behind a body that then
   * died will not produce another one — see `#revived`. Without this clause that agent
   * reads as work about to happen forever, which is this whole class of silent stall with
   * one more cause in it. The mark only ever describes a `working` agent with no body,
   * which is why it is read against that status rather than on its own.
   */
  #cannotMove(id: string): boolean {
    const agent = this.#store.agent(id);
    const working = agent.state.status === 'working';
    const inABody = working && this.#bodies.has(id);
    const nothingDeliveryWouldDo = this.#unreachable.has(id) || (working && this.#revived.has(id));
    return !inABody && (agent.mailbox.length === 0 || nothingDeliveryWouldDo);
  }

  /**
   * Bring an agent into existence, optionally with something to do.
   *
   * The opening instruction goes into its mailbox and is delivered by the same two paths any
   * message takes, so an agent's first turn and its hundredth arrive identically.
   */
  async add(record: AgentRecord, opening?: string): Promise<string> {
    return this.#serial(() => this.#add(record, opening));
  }

  async #add(record: AgentRecord, opening?: string): Promise<string> {
    const parent = record.parent;
    const state: StoredAgent = {
      state: { status: 'waiting', request: null },
      parent,
      children: [],
      mailbox: opening === undefined ? [] : [{ from: parent, content: opening }],
    };
    await this.#store.add(record, state);

    if (parent !== null) {
      const above = this.#store.agent(parent);
      await this.#store.save(parent, { ...above, children: [...above.children, record.id] });
    }

    await this.#settle();
    return record.id;
  }

  /** A human's message to the agent nobody spawned, by the path a parent's message takes. */
  async tell(content: string): Promise<void> {
    return this.#serial(() => this.#tell(content));
  }

  async #tell(content: string): Promise<void> {
    const root = this.#store.root;
    if (root === null) throw new SupervisorError('this run has no agent to address.');
    await this.#post(root, { from: null, content });
    await this.#settle();
  }

  /**
   * Take over a store a previous supervisor left, whatever state it left it in.
   *
   * **The sweep comes first, and it ends bodies and releases no workspace.** Whatever a
   * killed supervisor left running is unusable anyway: the protocol rides each agent's own
   * standard streams, so a sandbox that outlived its supervisor has dead pipes and there is
   * nothing to re-attach to. Sweeping by the run's marking and resuming from the store is
   * the only correct move, and it needs no handle on anything.
   *
   * **Nothing here reports a termination**, which is the distinction 6.3 is about. A body
   * lost while the supervisor was watching is a death; a supervisor restarting over a store
   * finds *every* agent bodiless, and reading that as a tree of deaths would deliver a
   * termination report for every agent in the run at the moment it was recovering.
   */
  async resume(): Promise<void> {
    return this.#serial(() => this.#resume());
  }

  async #resume(): Promise<void> {
    await this.#driver.destroyAll();
    const failed: { id: string; error: unknown }[] = [];
    for (const id of this.#store.ids()) {
      // `working` is the whole of the question: the agent was mid-turn when its supervisor
      // went, so it owes the model a step whether its log ends in a call nobody answered or
      // in a step whose end nobody heard.
      if (this.#store.agent(id).state.status !== 'working') continue;
      try {
        await this.#boot(id, true);
      } catch (error) {
        // Same rule as settling, including its limit: one agent that cannot be provisioned
        // must not abort the rescue of every agent after it in `ids()`, and a store that
        // could not be read is not that — a recovery running over a store it cannot read has
        // nothing to recover and should say so where it is heard.
        if (!(error instanceof UnprovisionedError)) throw error;
        //
        // **And its stored state is left exactly as it was**, which is what makes `resume()`
        // idempotent over it: fix the daemon, call it again, and it boots from the transcript
        // it stopped at with nothing lost and nothing repeated. It cannot borrow settling's
        // retry — a `working` agent has nothing queued, so no later settle has anything to
        // try. Setting it back to `waiting` so that delivery would retry it was the
        // alternative, and it is wrong: a `working` agent is owed a step, and the next
        // message would reach it as a fresh turn on a log that ends mid-step.
        failed.push({ id, error });
      }
    }
    // After the loop, for the reason `#settle` posts after its walk: a parent ordered before
    // its failing child would otherwise take the report into a mailbox already passed.
    for (const { id, error } of failed) await this.#unprovisioned(id, error);
    await this.#settle();
  }

  /** End every body this supervisor is holding. Records, transcripts and workspaces stay. */
  async shutdown(): Promise<void> {
    return this.#serial(() => this.#shutdown());
  }

  async #shutdown(): Promise<void> {
    this.#closing = true;
    for (const id of [...this.#bodies.keys()]) await this.#suspend(id);

    // **The sweep is here because the loop above cannot be the whole of it.** It walks
    // `#bodies`, which can only ever hold what nothing has already dropped — and `#ended`
    // drops every body that ends on its own. Each of those destroys its own sandbox, so on
    // the ordinary path this finds nothing; what it is for is the one that failed, where
    // the alternative is a container held until some later run of the same name.
    //
    // **It ends bodies and releases no workspace** — see {@link SandboxDriver.destroyAll},
    // where that distinction is held — so a run stopped for the day resumes from everything
    // it had.
    //
    // **Swallowed, and this is the one place that is right.** A shutdown must not fail
    // through the action a person takes to stop for the day, which is the argument
    // `#suspend`'s store write already carries; and what this cleans up was reported when
    // its own destroy failed, so a failure here is a second account of a leak already said
    // once rather than a diagnosis going missing.
    await this.#driver.destroyAll().catch(() => {});

    await this.#store.close();
  }

  /**
   * The supervisor's own trouble, said once and never rethrown from here.
   *
   * Reached from paths that have nowhere else to fail: a body's channel, and the exit
   * handler. Both are promises nobody holds, so a throw from either is an unhandled
   * rejection — which ends the one process holding every agent in the run.
   */
  #failed(id: string, error: unknown): void {
    try {
      this.#onFailure(id, error);
    } catch {
      // A destination that throws is not going to be told about it here.
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const done = this.#queue.then(task, task);
    // The queue itself never rejects, so one failed task does not poison every one after it.
    this.#queue = done.then(
      () => {},
      () => {},
    );
    return done;
  }

  // ---------------------------------------------------------------- bodies

  /**
   * Provision from the record, boot a runtime on the stored transcript, and start listening.
   *
   * The boot frame carries the record and the log together on the sandbox's standard input,
   * behind the credential block — see `runtime/boot.ts`.
   *
   * **`owed` is the one thing the runtime cannot work out for itself**, and it is this
   * file's to answer. A log that ends at a complete step belongs either to an agent standing
   * at a turn boundary or to one whose turn ended in a step this supervisor never heard the
   * end of, and those two want opposite things — wait, and take a step. What separates them
   * is the stored state, which is stored rather than inferred for exactly this class of
   * reason. A runtime left to guess guesses wrong in silence.
   */
  async #boot(id: string, owed: boolean): Promise<Body> {
    const record = this.#store.record(id);
    // **The two driver calls are marked and the store read between them is not**, which is
    // the line settling catches on — see {@link UnprovisionedError}. Both of these are the
    // machine failing to hand over a body, which is the agent's parent's business; the
    // transcript read is this supervisor's own trouble and leaves by its own route, the same
    // one it left by before settling caught anything at all.
    const sandbox = await provisioning(() =>
      this.#driver.create({
        id: record.id,
        environment: record.environment,
        workspace: record.workspace,
        credentials: record.credentials,
      }),
    );

    const events = await this.#store.transcript(id);
    const started = await provisioning(() =>
      sandbox.exec(this.#command, {
        input: `${JSON.stringify({ record, events, owed })}\n`,
      }),
    );

    const body: Body = { sandbox, process: started, sent: Promise.resolve(), said: '' };
    this.#bodies.set(id, body);

    // **Both of these are promises nobody holds**, so a rejection escaping either is an
    // unhandled rejection — which under Node's default ends this process, and this process is
    // holding every other agent in the run. The same argument narrowed `Input` away from a
    // stream in `sandbox/index.ts`: one agent's failure must not be every agent's.
    void this.#listen(id, body).catch((error: unknown) => this.#failed(id, error));
    // **Every stream this body has is read, and this is the one that had no reader at
    // all.** See {@link Body.said}.
    void this.#overhear(body).catch((error: unknown) => this.#failed(id, error));
    void started.exit
      .then(
        (exit) => this.#serial(() => this.#ended(id, body, exit.signal ?? `exit ${exit.code ?? 0}`)),
        (error: unknown) =>
          this.#serial(() => this.#ended(id, body, error instanceof Error ? error.message : String(error))),
      )
      .catch((error: unknown) => this.#failed(id, error));

    return body;
  }

  /**
   * Read this body's frames, in the order it sent them.
   *
   * Handled one at a time and awaited, because the order is load-bearing: an event and the
   * request that follows it are the same step, and a store that took them concurrently
   * could write the request's answer into a log the event had not reached.
   */
  async #listen(id: string, body: Body): Promise<void> {
    for await (const line of lines(body.process.stdout)) {
      if (this.#bodies.get(id) !== body) return;

      let frame: FromAgent;
      try {
        frame = parseFromAgent(line);
        // **The one frame this loop reads rather than only routes**, and it is read here
        // rather than in `#frame` on purpose. What it acknowledges is {@link Body.handed} —
        // the body has taken down the message it was given, so there is nothing left for a
        // suspension to put back. `#frame` runs on the queue, and a frame sitting behind a
        // queued `shutdown` would not be reached until after that shutdown had already
        // decided whether the message was lost. Ordering makes this exact rather than
        // approximate: frames arrive in the order the body sent them and this is the first
        // thing it sends on a turn, so an unread acknowledgement means nothing of that turn
        // has been read.
        if (frame.t === 'event' && frame.event.type === 'message' && frame.event.from === 'parent') {
          body.handed = undefined;
        }
      } catch (error) {
        // Reported to the agent that sent it, and nothing else happens: its other
        // outstanding requests are untouched, because none of them is what was unreadable.
        this.#say(id, {
          t: 'malformed',
          reason: error instanceof ProtocolError ? error.message : String(error),
        });
        continue;
      }

      try {
        await this.#serial(() => this.#frame(id, frame));
      } catch (error) {
        // A request that could not be carried out is a result the agent can read and act
        // on, never a reason for the supervisor to stop — one agent's bad request must not
        // take the run with it.
        //
        // An event or a turn frame has no such answer to fail into: there is no request id
        // to attach a refusal to, and the agent asked for nothing. What reaches here from
        // one is the supervisor's own trouble — a daemon that went away under a boot, a
        // store it could not write — which no agent can act on and a human has to hear
        // about. So it is reported and the channel carries on, rather than becoming a
        // rejection that ends the run.
        if (frame.t !== 'request') {
          this.#failed(id, error);
          continue;
        }
        this.#say(id, {
          t: 'answer',
          id: frame.id,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Read this body's standard error for as long as it has one, keeping the tail.
   *
   * **The reading is the point and the keeping is the dividend.** See {@link Body.said}: the
   * pipe exists whether or not anybody wants what comes out of it, and one that is never
   * read fills and stops the process behind it. So this cannot be a `resume()` with the
   * bytes thrown away *and* be honest about why it is here; the tail is what a parent is
   * told when the body ends, and it is the only place a runtime that failed to boot ever
   * says why.
   *
   * Nothing checks whether this is still the agent's body. A stream that ends is what ends
   * this loop, and abandoning one early is precisely the mistake above.
   */
  async #overhear(body: Body): Promise<void> {
    body.process.stderr.setEncoding('utf8');
    for await (const chunk of body.process.stderr) {
      body.said = (body.said + (chunk as string)).slice(-SAID);
    }
  }

  /**
   * A body that ended, and whether that is a death.
   *
   * An agent whose state still says `working` never spoke, so its parent is waiting for a
   * message that will never arrive — and without this, nothing notices: the parent waits,
   * the tree stops, and no failure is reported anywhere. An agent that reported first is in
   * `waiting` by the time its body ends, which is also what a suspension leaves behind, so
   * neither is mistaken for a death.
   *
   * **The stored state is still deliberately left as it is, and that now means something
   * different.** It was left alone so the parent owned the decision; what changed is that
   * the decision is one the parent can carry out. An agent left `working` with no body is
   * given one the moment anybody addresses it — see `#deliver` — so leaving the state is
   * what holds the agent's place until its parent says whether to continue it, rather than
   * what made it unreachable for the rest of the run.
   */
  async #ended(id: string, body: Body, how: string): Promise<void> {
    if (this.#bodies.get(id) !== body) return;
    this.#disarm(id);
    this.#bodies.delete(id);

    // **Dropping the body from the map is what makes the container this call's to release,
    // and here is the only place left that can.** `#shutdown` walks `#bodies`, so the line
    // above has just put this one out of its reach; nothing else holds a handle on it. The
    // rule the two are easiest to read as one is: the two places that take a body out of
    // `#bodies` are the two places that destroy its sandbox, and this is the other one.
    //
    // **Above every return below it, and that is the point rather than an ordering detail.**
    // A body whose agent already reported ends `waiting` and returns at the status guard;
    // an intended ending and a shutdown return at the line after this. Each of those is a
    // container, and the leak is not specific to the ending this method reports on.
    //
    // **What is left running is not idle.** A sandbox's PID 1 is the keepalive, so the exec
    // dying leaves a container up and sleeping — no exit to notice, nothing in `docker
    // events` but the `exec_die`. `destroyAll()` sweeps by the run's label and would reap
    // it, but only on a *later* run of the same name, which is not a lifetime.
    //
    // **Reported rather than swallowed**, unlike {@link Supervisor.#suspend}'s. A suspension
    // has a caller and an outcome; this has neither, so a destroy that fails here is a
    // container held for the rest of the run with nobody in a position to notice — the
    // supervisor's own trouble, in the exact sense {@link SupervisorOptions.onFailure} is
    // for, and nothing an agent can act on. `#failed` never rethrows, so the report below
    // still goes out.
    await body.sandbox.destroy().catch((error: unknown) => this.#failed(id, error));

    if (body.intended === true || this.#closing) return;

    const agent = this.#store.agent(id);
    if (agent.state.status !== 'working') return;

    // Delivered as an ordinary message, by the ordinary paths. Turning a failure into input
    // is what lets the parent's weights choose between retrying, replacing, escalating and
    // giving up — none of which the substrate should be choosing.
    //
    // **What the body said on its way out is part of that input**, where it said anything. A
    // signal and an exit code tell a parent that a child stopped; a runtime that could not
    // read its boot frame, or that died on a step, wrote the reason on its standard error
    // and nowhere else, and a parent choosing between retrying and replacing is choosing on
    // that. Appended rather than substituted, because the ending is the fact and this is the
    // account of it — and omitted where there is nothing, rather than reported as an empty
    // one.
    //
    // **And what it says about what is still available is load-bearing.** It said
    // `terminated` while that was the whole truth; it is not one any more. The agent's
    // transcript and workspace survive its body, and addressing it gives it a new one — so
    // a report a parent reads as a death has it replace a child it could have continued,
    // throwing away the work that child had already done. That choice is the parent's and
    // this is the account it makes it on.
    const said = body.said.trim();
    await this.#post(agent.parent, {
      from: id,
      content:
        `${id}'s body ended: ${how}${said === '' ? '' : `. It last said: ${said}`}. Its work is ` +
        `kept: send it a message to have it carry on from where it stopped, in a new body. ` +
        `Replacing it instead discards what it has already done.`,
      substrate: true,
    });
    await this.#settle();
  }

  /** Sync the log, then end the body. Never the other way round, and never in parallel. */
  async #suspend(id: string): Promise<void> {
    const body = this.#bodies.get(id);
    if (body === undefined) return;
    this.#disarm(id);
    this.#bodies.delete(id);
    body.intended = true;

    // The one ordering that cannot be relaxed. An agent resumed from a log missing its final
    // steps does not fail — it repeats work it had already done, or reports on work that is
    // no longer there, and nothing distinguishes either from an agent that behaved.
    await this.#store.sync(id).catch(() => {});
    await body.sandbox.destroy().catch(() => {});

    // **What the body never acknowledged goes back where it came from.** An intended ending
    // is reported to nobody, so a message lost here is lost in silence — see {@link
    // Body.handed}. It is restored to the head of the mailbox and the agent to the state it
    // was taken out of, which is exactly the state `#deliver` read: `waiting` on nothing,
    // because a message that begins a turn is one no request was outstanding for.
    //
    // **Nothing is settled from here, and the decision belongs to the caller.** There are
    // three. A shutdown is closing every body, and delivering again would be the opposite of
    // what was asked for. A dismissal's agent is not `waiting` and is skipped by the guard
    // below. An ordinary residency expiry is the one that wants delivery, and {@link
    // #retire} is where it asks for it — a restored message sitting in the mailbox of a
    // `waiting` agent with no body is work nothing else notices, because `stalled` reads
    // held mail as a tree still moving.
    const handed = body.handed;
    if (handed === undefined) return;
    const agent = this.#store.agent(id);
    if (agent.state.status !== 'working') return;
    await this.#store
      .save(id, {
        ...agent,
        state: { status: 'waiting', request: null },
        mailbox: [handed, ...agent.mailbox],
      })
      // **Never allowed out of here**, because `#shutdown` walks every body in a bare loop:
      // a rejection would take that loop with it, leaving every body after this one holding
      // its container and skipping `store.close()` — a clean exit failed through the very
      // action a person takes to stop for the day. A disk that filled while the run worked
      // is the ordinary way to arrive here, and it is exactly when you most want the rest
      // ended. Reported rather than swallowed like the two calls above it: a message that
      // could not be written back is lost the way it was lost before any of this existed,
      // and that is the supervisor's own trouble rather than something an agent can act on.
      .catch((error: unknown) => this.#failed(id, error));
  }

  /**
   * Arm the agent's own number, or tear down where it named none.
   *
   * **There is no default, minimum, maximum or adjustment here, and there must never be
   * one.** Only the agent can know which case it is in, because it has just decided what it
   * dispatched — an agent coordinating several short-lived children would pay a sandbox
   * start on every wake for nothing, and one waiting on a day of work should cost nothing at
   * all meanwhile. A constant in this file deciding that would be policy in code.
   */
  #residency(id: string, keep: number): void {
    this.#disarm(id);
    const body = this.#bodies.get(id);
    if (body === undefined) return;
    if (keep <= 0) {
      this.#retire(id);
      return;
    }
    body.timer = setTimeout(() => this.#retire(id), keep);
  }

  /**
   * The ordinary suspension, and the only one that asks for a delivery afterwards.
   *
   * {@link #suspend} puts back whatever the body never acknowledged and decides nothing
   * about it, because its other two callers want nothing done: a shutdown is ending the run
   * and a dismissal's agent is gone. A residency expiry is neither, and what it can leave
   * behind is an agent `waiting` with a message at the head of its mailbox and no body to
   * take it. Nothing else would find that: delivery only happens in a settle, and `stalled`
   * counts held mail as a tree still moving, so `onStalled` would not fire either. The
   * window is a timer firing as a `tell` arrives — which is what a busy tree does.
   *
   * **Asks for, rather than performs.** This runs as a queued task, so a timer that fired
   * while a shutdown was walking bodies lands behind it and reaches {@link #settle} over a
   * closed run; the settle declines there, for the whole class of callers that can arrive
   * late rather than for this one. Nothing here needs to know whether the run is still open.
   *
   * Nobody holds this promise, so a store that cannot be written leaves through
   * {@link #failed} rather than as an unhandled rejection ending the process every agent in
   * the run is living in.
   */
  #retire(id: string): void {
    void this.#serial(async () => {
      await this.#suspend(id);
      await this.#settle();
    }).catch((error: unknown) => this.#failed(id, error));
  }

  #disarm(id: string): void {
    const body = this.#bodies.get(id);
    if (body?.timer === undefined) return;
    clearTimeout(body.timer);
    body.timer = undefined;
  }

  // ---------------------------------------------------------------- frames

  async #frame(id: string, frame: FromAgent): Promise<void> {
    if (frame.t === 'event') {
      await this.#store.append(id, frame.event);
      return;
    }
    if (frame.t === 'turn') {
      await this.#turn(id, frame.message, frame.residency);
      return;
    }
    await this.#request(id, frame);
  }

  /**
   * The turn ended: the agent produced content with nothing outstanding.
   *
   * That content *is* the message to its parent — there is no completion channel and no
   * status field an agent writes. The agent is now at a turn boundary, which is the same
   * `waiting` an `await` reaches, arrived at without asking, which is why the runtime
   * carries zero for its body.
   */
  async #turn(id: string, message: string, residency: number): Promise<void> {
    const agent = this.#store.agent(id);
    // A revived body that reached a boundary got somewhere, so whatever bound was spent on
    // giving it one is spent history rather than a standing refusal — see `#revived`. The
    // loop that mark exists to stop is bodies that die without ever reaching here.
    this.#revived.delete(id);
    await this.#store.save(id, { ...agent, state: { status: 'waiting', request: null } });
    await this.#post(agent.parent, { from: id, content: message });
    if (this.#store.agent(id).mailbox.length === 0) this.#residency(id, residency);
    await this.#settle();
  }

  /**
   * Every request, and the two things true of all of them before any handler runs.
   *
   * **The grant is checked once, here, for every kind — including kinds added after this.**
   * A rule enforced in some handlers and not others is reachable by exactly the agent it was
   * written for: an agent that hand-writes a raw frame is the one whose request should be
   * trusted least, and it only has to find the handler that forgot. This is the second of the
   * two places a grant is read, and both stay — the runtime offers an agent only what its
   * record names, and only one of the two is on the path a raw frame takes.
   *
   * **The order is the part that is not obvious.** A record never names a kind that does not
   * exist, so a grant check placed first answers a typo with "your record does not grant
   * `sned`", sending an agent to fix a grant when what it has is a spelling mistake.
   * Establishing that the kind is routable first keeps the unknown-kind answer meaning what
   * it says.
   *
   * **Nothing is written above either check**, which is where `spawn`'s "so nothing was
   * spawned" tail went. The refusal is uniform now and the guarantee rests on the position of
   * the check rather than on each message claiming it.
   */
  async #request(id: string, frame: RequestFrame): Promise<void> {
    // A kind nothing handles is a result the model can read, not a transport failure.
    if (!ROUTABLE.has(frame.kind)) {
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content: `There is no capability named "${frame.kind}".`,
      });
    }

    if (!this.#store.record(id).tools.includes(frame.kind)) {
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content: `Your record does not grant \`${frame.kind}\`.`,
      });
    }

    const input = (typeof frame.input === 'object' && frame.input !== null ? frame.input : {}) as Record<
      string,
      unknown
    >;

    const kind = frame.kind as Routed;
    switch (kind) {
      case 'await':
        return this.#awaiting(id, frame);
      case 'send':
        return this.#sending(id, frame, input);
      case 'spawn':
        return this.#spawning(id, frame, input);
      case 'stop':
        return this.#stopping(id, frame, input);
      case 'read':
        return this.#reading(id, frame, input);
      default: {
        // Unreachable, and it is the typecheck rather than this line that says so: `kind` is
        // narrowed to `never` here only while every name in `ROUTED` has a case above.
        const unhandled: never = kind;
        throw new SupervisorError(`"${String(unhandled)}" is routable and nothing handles it.`);
      }
    }
  }

  /**
   * The agent asked to receive a message.
   *
   * **Nothing here is a suspend path.** The request is correlated like any other and the
   * agent is simply waiting for its answer; suspension is what this supervisor may do with
   * the body meanwhile, and the runtime is never told which happened.
   */
  async #awaiting(id: string, frame: RequestFrame): Promise<void> {
    const agent = this.#store.agent(id);
    await this.#store.save(id, { ...agent, state: { status: 'waiting', request: frame.id } });
    // Only where there is nothing to deliver. Arming first would tear a body down at
    // residency zero and immediately provision another one to hand over a message that was
    // already sitting in the mailbox.
    if (agent.mailbox.length === 0) this.#residency(id, frame.residency);
    await this.#settle();
  }

  /**
   * A message to this agent's parent or to one of its children, and to nobody else.
   *
   * For the root, its parent is the human, addressed by {@link HUMAN} because a person has
   * no agent id — the one name in this vocabulary that is not one.
   */
  async #sending(id: string, frame: RequestFrame, input: Record<string, unknown>): Promise<void> {
    const agent = this.#store.agent(id);
    const to = typeof input.to === 'string' ? input.to : null;
    const content = typeof input.content === 'string' ? input.content : null;

    if (to === null || content === null) {
      return this.#say(id, { t: 'answer', id: frame.id, ok: false, content: 'A send needs a `to` and a `content`.' });
    }
    // The root addressing the human, which is upward like any other message and needs a name
    // because the agent above the root is a person. Resolved here, where the routing decision
    // is, into the `null` `#post` already takes — so the name exists in the vocabulary an
    // agent speaks and nowhere in the tree.
    const upward = agent.parent === null && to === HUMAN;

    // The topology is a tree, so this is a parent pointer and a list of children. There is
    // no graph here and no route to compute — and a sibling is not reachable by construction
    // rather than by a rule about who may talk to whom.
    if (!upward && to !== agent.parent && !agent.children.includes(to)) {
      // Two refusals, because the root is the one agent for which the other one is false.
      // `agent.parent` is `null` there and no string equals `null`, so the generic wording
      // would answer a root's every attempt to speak upward by telling it the human is
      // neither its parent nor its child — the one thing the rest of the substrate is
      // careful to insist is untrue. What it needs instead is the name it was reaching for.
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content:
          agent.parent === null
            ? `"${to}" is not one of your children, and the human — who is your parent — is addressed as \`${HUMAN}\`. Nothing was sent.`
            : `"${to}" is neither your parent nor one of your children, so nothing was sent.`,
      });
    }

    // A dismissed agent is still in its parent's `children`, so the routing above passes for
    // it and `#post` would drop the message while this answered `delivered`. A sender told
    // its message landed waits on an answer that cannot come; a sender told it was refused
    // has made a mistake it can reason about. Checked here, where the routing decision
    // already is, rather than in `#post` — whose other caller is a termination report for an
    // agent that was dismissed while its child was dying, and that one is a genuine drop.
    if (!upward && this.#store.agent(to).state.status === 'dismissed') {
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content: `"${to}" has been dismissed, so nothing was sent.`,
      });
    }

    // Durable first. `send` is fire-and-forget to the agent that calls it, so an
    // acknowledgement that outran the write would be the substrate lying about the one
    // thing the caller can check.
    await this.#post(upward ? null : to, { from: id, content });
    this.#say(id, { t: 'answer', id: frame.id, ok: true, content: `delivered to ${to}` });
    await this.#settle();
  }

  /**
   * A child, built from what the parent asked for and from the parent's own record.
   *
   * **The request is a requested configuration, not a record.** A caller names what its
   * child is *for* and what it may reach; everything that decides what the child can
   * actually get at — its id, its parentage, its credentials, its environment, its workspace
   * and the endpoint its model is behind — is constructed here from the parent's own record.
   * Accepting a record and overwriting two fields of it would put construction policy on
   * both sides of the channel and make parentage and credentials caller-supplied in every
   * case nobody thought to overwrite.
   *
   * **Every check is here rather than in the schema the model was shown.** A schema is a
   * guide to a model; a raw frame reaches this method without passing through one, and the
   * agent that would send a raw frame is precisely the one whose request should not be
   * trusted. So the fields, the tool subset and the model identifier are all read again here
   * — and every one of those refusals happens **before** anything is stored, so a spawn
   * refused for what it *said* leaves no record, no parent link and no sandbox behind. A
   * spawn that fails while provisioning the child's body is the opposite shape — everything
   * was written, so it is answered with the child's id and the body is reported to the
   * parent: see `AGENTS.md` beside this file.
   *
   * The caller's *grant* is not among them any more. It is read at `#request` for every kind
   * at once, above anything that writes, which is the same guarantee held in one place.
   *
   * **Nothing is filtered, substituted or ignored.** A tool the parent does not hold, a
   * duplicate, a `model` that is an object rather than an identifier, a field the supervisor
   * owns — each is refused by name. Silently dropping one creates an agent that cannot do
   * what its parent asked for and tells the parent it can, which is a lie the parent has no
   * way to detect; silently honouring one would be worse.
   */
  async #spawning(id: string, frame: RequestFrame, input: Record<string, unknown>): Promise<void> {
    const parent = this.#store.record(id);
    const agent = this.#store.agent(id);
    const refuse = (content: string): void => {
      this.#say(id, { t: 'answer', id: frame.id, ok: false, content });
    };

    // Supplied and not honoured is the one outcome worth refusing outright: a caller that
    // named one of these believes it will take effect, and it never can.
    const owned = OWNED.filter((field) => input[field] !== undefined);
    if (owned.length > 0) {
      return refuse(
        `${owned.map((field) => `\`${field}\``).join(' and ')} ${owned.length === 1 ? 'is' : 'are'} the ` +
          "supervisor's to set and cannot be named in a spawn, so nothing was spawned.",
      );
    }

    const name = phrase(input.name);
    const charter = phrase(input.charter);
    if (name === null || charter === null) {
      return refuse('A spawn needs a non-empty `name` and `charter`.');
    }

    // Present and empty is refused rather than treated as absent: an opening is what starts
    // the child, and one with nothing in it boots a body to read nothing at all, where
    // leaving it out creates a dormant child on purpose. The two are different requests.
    if (input.opening !== undefined && phrase(input.opening) === null) {
      return refuse('An `opening` is the first message to the child, so it must be a non-empty string.');
    }
    const opening = input.opening === undefined ? undefined : (input.opening as string);

    const tools = requestedTools(input.tools, parent.tools);
    if (typeof tools === 'string') return refuse(tools);

    // An identifier only. A whole model configuration would let a spawn point the *parent's*
    // credential at an endpoint of the caller's choosing while reading as a model choice, so
    // anything that is not a non-empty string is refused rather than reached into.
    if (input.model !== undefined && phrase(input.model) === null) {
      return refuse(
        'A `model` is the identifier of a model at your own provider, so it must be a non-empty string. ' +
          'The provider, endpoint and credential are inherited and cannot be set by a spawn.',
      );
    }
    const model = input.model === undefined ? parent.model.model : (input.model as string);

    // **The id is the supervisor's**, because an agent naming its own child's could name
    // one that already exists — and two agents sharing an id share a workspace, a
    // transcript and a mailbox.
    const record: AgentRecord = {
      id: `${parent.id}-${agent.children.length + 1}`,
      name,
      charter,
      // Inherited but for the identifier, so an agent that says only what its child is for
      // gets one that can reach the same provider from the same kind of sandbox — and one
      // that names a model reaches that model at the endpoint it was already using.
      model: { ...parent.model, model },
      // The path inside the sandbox, which is the same for every agent; what isolates a
      // child's work is its own id, which the sandbox keys its workspace on.
      workspace: parent.workspace,
      environment: parent.environment,
      // Never widened, and never silently narrowed either: exactly what was asked for, or a
      // refusal above. Omitted means none rather than the parent's, so an agent is granted
      // something only by a parent that chose to grant it.
      tools,
      // References, never values. The record stays inert, which is what makes it safe to
      // persist beside the project and to hand back to a parent that asks what its child is.
      credentials: parent.credentials,
      parent: parent.id,
    };

    // **The answer follows the store, and does not follow the child.** `#add` writes the
    // record and the parent link, posts the opening into the mailbox and settles — which
    // starts the child's body where there is something for it to do. It does not wait for a
    // model step, a report, or anything the child does with what it was given: an id
    // returned only after the child had finished would make every fan-out a join.
    await this.#add(record, opening);
    this.#say(id, { t: 'answer', id: frame.id, ok: true, content: record.id });
  }

  /**
   * Dismiss a child, and with it everything below that child.
   *
   * **The cascade is not a convenience.** A dismissed agent's mailbox is never read again,
   * so a grandchild left running holds a body, keeps working, and addresses a parent that
   * has gone — every report it makes dropped, every `send` it makes refused. The one call
   * whose purpose is to end an agent would be the call that leaks containers, and the deeper
   * the subtree the more of them.
   *
   * **The workspace is kept**, for every agent this reaches, which is the safe default and
   * this change's answer to the question `design.md` left open: releasing it is
   * irreversible, whatever a dismissed agent built may be exactly what its parent dismissed
   * it for, and no request has asked for it to go.
   *
   * **A report is not a stop.** A child that has answered its parent is dormant rather than
   * finished, and stays addressable until this is called for it.
   */
  async #stopping(id: string, frame: RequestFrame, input: Record<string, unknown>): Promise<void> {
    const agent = this.#store.agent(id);
    const target = typeof input.id === 'string' ? input.id : null;

    if (target === null || !agent.children.includes(target)) {
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content: `"${String(target)}" is not one of your children, so nothing was stopped.`,
      });
    }

    // Deepest first, so that nothing is left addressing a parent that has already gone
    // while this walk is still running.
    for (const one of this.#below(target).reverse()) {
      const agent = this.#store.agent(one);
      if (agent.state.status === 'dismissed') continue;
      await this.#store.save(one, { ...agent, state: { status: 'dismissed' }, mailbox: [] });
      await this.#suspend(one);
    }

    this.#say(id, { t: 'answer', id: frame.id, ok: true, content: `stopped ${target}` });
    await this.#settle();
  }

  /** An agent and everything below it, nearest first. The tree walked downward. */
  #below(id: string): string[] {
    const found = [id];
    for (let at = 0; at < found.length; at += 1) {
      found.push(...this.#store.agent(found[at]!).children);
    }
    return found;
  }

  /**
   * A transcript, where the target is below the reader in the tree.
   *
   * The restriction follows from the tree rather than from a policy about roles, which is
   * what keeps it out of the class of rules the substrate places in the weights: an agent
   * may inspect the work it is accountable for, and it is accountable for its descendants.
   *
   * **A refusal is a refusal**, never an empty transcript — silence and emptiness are
   * indistinguishable from a target that did nothing.
   */
  async #reading(id: string, frame: RequestFrame, input: Record<string, unknown>): Promise<void> {
    const target = typeof input.id === 'string' ? input.id : null;
    if (target === null || !this.#store.has(target)) {
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content: `There is no agent "${String(target)}" in this run.`,
      });
    }
    if (!this.#descends(target, id)) {
      return this.#say(id, {
        t: 'answer',
        id: frame.id,
        ok: false,
        content: `"${target}" is not below you, so its transcript is not yours to read.`,
      });
    }

    const from = typeof input.from === 'number' && input.from >= 0 ? Math.floor(input.from) : 0;
    const count =
      typeof input.count === 'number' && input.count > 0 ? Math.floor(input.count) : Number.POSITIVE_INFINITY;
    const events = await this.#store.transcript(target, from, count);

    this.#say(id, {
      t: 'answer',
      id: frame.id,
      ok: true,
      content: JSON.stringify({ id: target, from, total: await this.#store.length(target), events }),
    });
  }

  /** Whether `target` is below `above`, walked over the stored parentage. */
  #descends(target: string, above: string): boolean {
    let at = this.#store.agent(target).parent;
    while (at !== null) {
      if (at === above) return true;
      at = this.#store.agent(at).parent;
    }
    return false;
  }

  // ---------------------------------------------------------------- delivery

  /** Put a message where its recipient will find it, durably, before anyone is told. */
  async #post(to: string | null, message: Message): Promise<void> {
    if (to === null) {
      // The root's parent is the human.
      this.#onMessage(message);
      return;
    }
    const agent = this.#store.agent(to);
    if (agent.state.status === 'dismissed') return;
    // A second decision buys a second body. Everything that reaches an agent arrives here,
    // so this is the one place the bound in `#revived` is re-armed, and it is re-armed by
    // the only thing that should: somebody choosing to address the agent again.
    this.#revived.delete(to);
    await this.#store.save(to, { ...agent, mailbox: [...agent.mailbox, message] });
  }

  /**
   * A body that could not be provisioned, told to the agent's parent.
   *
   * **The same destination and the same shape `#ended` uses**, because from the parent's
   * side it is the same fact: a child that is not going to speak. Turning it into input is
   * what lets the parent's weights choose between retrying, replacing, escalating and giving
   * up — the choice `#ended` already declines to make, and this has no more business making
   * it. `#post(null, …)` carries a root's out to the human, so the agent nobody spawned
   * needs no special path.
   *
   * **Not `onFailure`.** That hook is for what no agent can act on — a store that could not
   * be written, a channel that broke. A child with no body is its parent's business.
   *
   * **The wording is load-bearing on both sides.** It cannot be read as a death: the agent
   * is still addressable and whatever it has done is kept, and a parent that believed
   * otherwise would replace a child that is about to wake up fine. And it cannot be read as
   * a loss: what was queued is still queued, and a parent whose fair reading was "my message
   * did not arrive" would send it again, waking the child to two copies of its instruction.
   *
   * **It has two callers now and says only what is true of both.** It used to say the agent
   * "has not started and has not ended", which was true of the only caller there was — a
   * dormant agent being woken — and is false of the other: an agent whose body ended and
   * whose revival could not be provisioned has both started and ended. What the two share
   * is the part that matters to a parent, that the agent is still there and still
   * addressable, so that is what it says.
   */
  async #unprovisioned(id: string, error: unknown): Promise<void> {
    const said = error instanceof Error ? error.message : String(error);
    await this.#post(this.#store.agent(id).parent, {
      from: id,
      substrate: true,
      content:
        `${id} could not be given a body: ${said}. It is not gone — whatever work it has is kept ` +
        `and it is still addressable. Anything queued for it is still queued and will be ` +
        `delivered when it can be provisioned again.`,
    });
  }

  /**
   * Deliver whatever can be delivered, then say whether the tree can still move.
   *
   * **A failure belongs to the agent it happened to and to nobody else.** `#deliver`
   * rethrows when it cannot boot a body — deliberately, having put the mailbox back exactly
   * as it found it — and this loop is what eight call sites end in. Letting that throw
   * through would fail whichever agent's request happened to be in flight, about whichever
   * agent it happened to be about, and would abandon delivery to every agent ordered after
   * the failing one in `ids()`. So each agent is attempted, every {@link UnprovisionedError}
   * is caught, and the pass finishes.
   *
   * **Every other failure still leaves through here**, unchanged and on purpose. The problem
   * above is that one agent's missing body is not another agent's business; a store this
   * supervisor cannot write is every agent's business at once, and it belongs to the human
   * the moment it happens rather than to a parent's next judgment call.
   *
   * **Reports are posted after the walk, never during it.** A report goes into a parent's
   * mailbox, and a parent that comes before its failing child in `ids()` would take it into
   * a mailbox this pass has already gone past — so it would wait for some unrelated later
   * request, or, if the run went quiet, for nothing. Posting after and walking again is what
   * delivers it now.
   *
   * **The repeat terminates.** An agent produces at most one report per settle, whatever the
   * driver does between passes, so each pass has strictly fewer agents left that can cause
   * another one and the loop is bounded by the size of the run.
   *
   * **A closing run delivers nothing, and that is held here rather than at the callers.**
   * Every delivery goes through here — `#deliver` is reached from nowhere else — and a
   * dormant agent is given a body in order to be delivered to, so this line is also what
   * keeps a sandbox from outliving the run that created it.
   *
   * It has to be here because the callers are not one path: `#shutdown` runs on the serial
   * queue, and every task already queued behind it still runs after it. A residency timer
   * that has fired is past disarming; a frame read off a body's channel a moment before it
   * was destroyed is already queued; `add()` and `tell()` queue from outside altogether.
   * Each of those ends in a settle, over a store where the messages the shutdown just
   * restored are at the head of `waiting` mailboxes — so each of them would take one and
   * boot a fresh sandbox for an agent the run is done with. Guarding one caller would leave
   * the rest, and there is no caller that wants a delivery after {@link shutdown}.
   *
   * `#closing` is never cleared: a supervisor that has shut down is finished, and a run is
   * taken up again by constructing another one over the store — which is also why
   * {@link resume} needs no guard of its own, although it is the one path that provisions
   * without delivering. It is a caller deliberately taking a run up rather than work
   * arriving late, and nothing that exists can queue it behind a shutdown: the operator arms
   * its signal handlers before it, so an interrupt during a recovery queues the shutdown
   * *after* the recovery rather than in front of it.
   */
  async #settle(): Promise<void> {
    if (this.#closing) return;
    const told = new Set<string>();
    for (;;) {
      const failed: { id: string; error: unknown }[] = [];
      for (const id of this.#store.ids()) {
        try {
          await this.#deliver(id);
          // Including `#deliver`'s early returns. Nothing was queued, or what was queued
          // has already been answered with a body — and neither is this mark's meaning,
          // which is a body that could not be provisioned. The second case is still a
          // stopped agent, and `#revived` is what says so to the stall read; clearing here
          // only means an agent that is reached again is reportable again.
          this.#unreachable.delete(id);
        } catch (error) {
          // **Only a missing body is caught here.** Everything else `#deliver` can throw is
          // the supervisor's own trouble and keeps the exit it had before this loop learned
          // to catch: out to the request in flight, or to `onFailure` from a frame with no
          // request to fail into. Swallowing it would relabel a store that cannot be written
          // as a body that cannot be provisioned — reported to a parent that can do nothing
          // about it, counted as unreachable by the stall read, and never heard by the hook
          // whose whole remit it is. The report loop below is unwrapped for the same reason.
          if (!(error instanceof UnprovisionedError)) throw error;
          if (!this.#unreachable.has(id) && !told.has(id)) failed.push({ id, error });
          this.#unreachable.add(id);
        }
      }

      if (failed.length === 0) break;
      for (const { id, error } of failed) {
        told.add(id);
        await this.#unprovisioned(id, error);
      }
    }

    if (!this.stalled) {
      this.#reported = false;
      return;
    }
    if (this.#reported) return;
    this.#reported = true;
    // Split by what the person should do about each. An agent that is `waiting` and
    // reachable is behaving and is part of the ordinary deadlock; anything else here is
    // the cause — a body that ended, or one that could not be provisioned at all.
    const live = this.#live();
    this.#onStalled({
      waiting: live.filter((id) => this.#waiting(id)),
      stopped: live.filter((id) => !this.#waiting(id)),
    });
  }

  /** Waiting in the ordinary way: suspended, and reachable if anything is sent to it. */
  #waiting(id: string): boolean {
    return this.#store.agent(id).state.status === 'waiting' && !this.#unreachable.has(id);
  }

  /**
   * The two paths a message reaches a conversation by, chosen by what the agent is doing and
   * by nothing else.
   *
   * A message for an agent that asked to receive one is the result of that request. A
   * message for an agent at a turn boundary begins a new turn, in the position that agent's
   * parent occupies in its conversation — which is the same operation at every depth, a
   * human addressing the root included. **A message for a working agent waits**: an
   * in-flight turn is not interrupted by a message's arrival.
   */
  async #deliver(id: string): Promise<void> {
    const agent = this.#store.agent(id);
    const [message, ...rest] = agent.mailbox;
    // **Mail is what triggers everything below, a revival included**, and the supervisor
    // revives nothing it was not asked to: an agent whose body ended and that nobody has
    // addressed stays exactly as it is. Making it automatic would move the judgment of
    // whether to retry out of the parent's reasoning and into this file, where no charter
    // can reach it.
    //
    // It is not on its own what keeps an agent that dies whenever it is given a body out of
    // a loop. Triggering on mail rules out a settle reviving unbidden; the message a
    // revival leaves pending would still be re-read as a new instruction after every death.
    // The bound on that is `#revived`, below.
    if (message === undefined) return;

    // **An agent with no body gets one when somebody addresses it**, whatever left it
    // without one. This is `resume()`'s rule applied at delivery instead of at recovery:
    // an agent recorded as working is owed a step, and that is as true of one whose body
    // died mid-run as of one whose supervisor was restarted. Without it the state is a
    // tombstone — `#ended` reports the ending and deliberately leaves the stored state
    // alone so the parent owns the decision, and the obvious decision, telling the child
    // to carry on from a transcript and workspace that are both sitting there intact,
    // would be the one thing the parent could not do.
    //
    // **What is pending stays pending.** An agent continuing an unfinished turn is not at
    // the boundary where a message begins one, so the mailbox and the stored state are
    // left untouched and the message is delivered by the ordinary path at the boundary
    // this agent reaches. That is also why this branch needs no restore on failure, where
    // the `waiting` path below does: it writes nothing before `#boot`, so an
    // `UnprovisionedError` leaves the store exactly as it found it and `#settle`'s
    // existing handling reports it with the message still queued. And there is no double
    // boot behind it — `#settle` visits each id once per pass, and a revived agent holds a
    // body by the time anything looks again.
    //
    // **A revival answers the message that caused it, and a further one wants a further
    // message.** The message stays pending, so without the mark it is still at the head of
    // this mailbox when the new body dies and reads as a fresh instruction on the way back
    // through here — one parent message buying bodies forever, at a sandbox and a model
    // call each, with `#cannotMove` reading the driving message as work about to happen and
    // staying silent throughout. The mark is what makes the branch bounded; `#revived` is
    // where the whole of that reasoning is. It is taken only where a body was actually
    // provisioned, because a revival that could not be is one the parent has been promised
    // a retry of.
    if (agent.state.status === 'working' && !this.#bodies.has(id)) {
      if (this.#revived.has(id)) return;
      await this.#boot(id, true);
      this.#revived.add(id);
      return;
    }

    // **What is left of the old guard is what it always meant**: do not deliver to an
    // agent that is working *in a body*, because that is an in-flight turn, which a
    // message's arrival does not interrupt. It will come back to a boundary on its own and
    // the message is delivered there. A dismissed agent falls out here too, as it did
    // before, although nothing posts to one.
    if (agent.state.status !== 'waiting') return;

    const answering = agent.state.request;
    const content = render(message);
    await this.#store.save(id, { ...agent, mailbox: rest, state: { status: 'working' } });

    const body = this.#bodies.get(id);
    if (body !== undefined) {
      this.#disarm(id);
      // Only where the message begins a turn. An answer to an outstanding call is written
      // into the log by the runtime as a `tool_result` either way, and for a dormant agent
      // it is written by `#answerInLog` before anything boots — neither is a message this
      // supervisor is holding alone. See {@link Body.handed}.
      if (answering === null) body.handed = message;
      this.#say(
        id,
        answering === null ? { t: 'message', content } : { t: 'answer', id: answering, ok: true, content },
      );
      return;
    }

    // No body: the agent is dormant and is about to be woken in a fresh one. Where it was
    // waiting on a request, the answer is written into the log **first** — see this file's
    // header for why that ordering is the whole design.
    try {
      if (answering !== null) await this.#answerInLog(id, content);
      // A body booted onto a log that now carries the answer has an input to work from and
      // nothing coming on the channel, so it owes a step. A body woken at a turn boundary is
      // about to be handed a message frame, and a step taken before that arrived would be a
      // step on nothing.
      const woken = await this.#boot(id, answering !== null);
      if (answering === null) {
        woken.handed = message;
        this.#say(id, { t: 'message', content }, woken);
      }
    } catch (error) {
      // **The message is now in no mailbox, no log and no living process.** It left the
      // mailbox above, and the boot that was supposed to consume it did not happen — so
      // without this, a daemon that went away costs a human's instruction or a child's whole
      // turn of work, and what is left behind is an agent recorded as `working` that a later
      // supervisor resumes into a body never told what it was woken for. The resident path
      // needs none of this: `#say` swallows a write to a body that has gone and the exit
      // already on its way becomes a termination its parent can act on.
      //
      // Restoring is exact rather than approximate. Where the answer reached the log before
      // the boot failed, the retry finds the call already answered and appends nothing —
      // `#answerInLog` returns on an outstanding call it cannot find — so the message is
      // delivered once across both attempts rather than twice.
      await this.#store.save(id, agent).catch(() => {});
      throw error;
    }
  }

  /**
   * Append the answering result to the stored log, where the agent's body is gone.
   *
   * This is less clever than it looks and it should read as ordinary. For a
   * supervisor-backed capability the supervisor *is* what produces the result: normally it
   * sends it down the pipe and the runtime appends it. When there is no pipe, it appends the
   * same value to the same place itself — same result, same position, different delivery.
   *
   * The call it answers is the outstanding one in the log, not a request id: a request id
   * belongs to the runtime that raised it, and that runtime is gone.
   */
  async #answerInLog(id: string, content: string): Promise<void> {
    const events = await this.#store.transcript(id);
    const answered = new Set(events.flatMap((event) => (event.type === 'tool_result' ? [event.id] : [])));
    const outstanding = events.filter(
      (event): event is Extract<Event, { type: 'tool_call' }> => event.type === 'tool_call' && !answered.has(event.id),
    );
    const call = outstanding.at(-1);

    // Nothing outstanding means the stored state and the stored log disagree, which should
    // not happen: the runtime appends a call's event before it raises the request. Read as a
    // turn boundary rather than repaired, because that reading is recoverable — a message
    // that begins a turn is never lost — while writing a result for a call that is not there
    // produces a log the provider rejects outright on the next step.
    if (call === undefined) return;

    const answer: Event = {
      type: 'tool_result',
      at: new Date(this.#clock()).toISOString(),
      id: call.id,
      content,
      ok: true,
      ms: 0,
    };
    await this.#store.append(id, answer);
  }

  /**
   * One frame to one agent, said now and waited for by nobody.
   *
   * **A body that cannot be written to is not a run-ending failure, and nor is one that is
   * merely not listening.** The second is what this shape is for — see {@link Body.sent}.
   * The far end of the channel is one thread behind a pipe with a finite buffer, so a body
   * that has stopped reading is a body a write to does not come back from; awaiting it from
   * inside the serial queue made one such body enough to stop every agent in the run.
   *
   * Nothing is given up by not waiting. The failure was already swallowed here and is
   * reported by the body's own exit, at `#ended`, where an agent that ended without speaking
   * becomes something its parent can act on — and the order frames are said in is kept by
   * the chain rather than by the caller.
   */
  #say(id: string, frame: Parameters<typeof encode>[0], to?: Body): void {
    const body = to ?? this.#bodies.get(id);
    if (body === undefined) return;
    const text = encode(frame);
    body.sent = body.sent.then(
      async () => {
        try {
          await body.process.stdin.send(text);
        } catch {
          // The body has gone. Its exit is already on its way here, and that is where an
          // agent that ended without speaking is turned into something its parent can act
          // on.
        }
      },
      () => {},
    );
  }
}

/**
 * The request kinds this channel routes.
 *
 * One list, and the switch in `#request` is typed from it — so a name added here without a
 * case fails the typecheck, and a case for a name that is not here cannot be written. That
 * is what keeps the grant check above the switch honest: the kinds it refuses on behalf of
 * are exactly the kinds something handles.
 *
 * Exported for one reader: `fixture.ts`'s `EVERY_CAPABILITY`, which is a third copy of this
 * list that the typecheck above cannot reach. Deriving it there would pull this file into the
 * import graph of every runtime test that touches the fixture, so `channel.test.ts` asserts
 * the two agree instead — the drift fails as a named assertion in the fast tier rather than
 * as a hung container in the slow one.
 */
export const ROUTED = ['await', 'send', 'spawn', 'stop', 'read'] as const;

type Routed = (typeof ROUTED)[number];

const ROUTABLE = new Set<string>(ROUTED);

/**
 * The record fields a spawn may not name, whatever it puts in them.
 *
 * Not a list of dangerous strings — a list of the fields whose *value* is the supervisor's
 * decision. `id` and `parent` are what make parentage something the substrate knows rather
 * than something an agent asserts; `environment` and `workspace` are what a sandbox is built
 * and isolated from. A request naming one is refused rather than ignored, because a caller
 * that named it expects it to take effect.
 *
 * **Two kinds of name, on purpose.** `credentials` is a record field; `provider`, `baseURL`
 * and `credential` are *model* fields listed at the top level, because flattening a model's
 * configuration into the request is exactly what a confused caller produces. Those three are
 * the trio that decides which endpoint an inherited secret reaches, and refusing two of them
 * while ignoring the third would leave this change's one rule with an exception in it — the
 * model-facing description in `runtime/main.ts` promises a caller that all three are
 * inherited and unsettable, and silence is not that promise kept.
 */
const OWNED = ['id', 'parent', 'credentials', 'environment', 'workspace', 'provider', 'baseURL', 'credential'] as const;

/** A string with something in it, or nothing. Whitespace is not a name, charter or model. */
function phrase(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The child's tools, or why they were refused.
 *
 * **Absent is none, never the parent's.** Inheriting would make every child as capable as
 * its parent without the parent having chosen that, and an agent granted `spawn` by default
 * is a tree that widens by omission.
 *
 * **A name the parent lacks is refused rather than dropped.** Intersecting silently would
 * acknowledge a child that cannot do what its parent asked for, and the parent would have
 * no way to find out — it asked for a capable child and was given an id. This is what makes
 * "this agent cannot do X" a property of the record rather than a hope in a charter: the
 * authority of a subtree can only ever narrow going down.
 */
function requestedTools(requested: unknown, held: readonly string[]): string[] | string {
  if (requested === undefined) return [];
  if (!Array.isArray(requested) || requested.some((one) => typeof one !== 'string')) {
    return '`tools` must be an array of capability names, so nothing was spawned.';
  }

  const tools = requested as string[];
  const duplicated = tools.filter((one, at) => tools.indexOf(one) !== at);
  if (duplicated.length > 0) {
    return `\`tools\` names ${[...new Set(duplicated)].map((one) => `"${one}"`).join(', ')} more than once, so nothing was spawned.`;
  }

  const widening = tools.filter((one) => !held.includes(one));
  if (widening.length > 0) {
    return (
      `You do not hold ${widening.map((one) => `"${one}"`).join(', ')}, so you cannot grant ` +
      `${widening.length === 1 ? 'it' : 'them'} to a child. Nothing was spawned.`
    );
  }
  return tools;
}

export { Store, StoreError, type AgentState, type Message, type StoredAgent } from './store.ts';
