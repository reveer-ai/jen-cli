/**
 * Test support: a sandbox driver that provisions nothing, and a peer that stands in for a
 * runtime.
 *
 * Almost all of the supervisor is a state machine over stored data, and driving it through
 * a real container runtime and a real model would make every one of its properties depend
 * on two things that are neither under test nor deterministic. So:
 *
 * - **{@link TestDriver}** implements the sandbox interface with objects. Sandboxes are
 *   objects, `exec` hands back pipes this file holds both ends of, and destruction is
 *   observable. No daemon, no images, no network.
 * - **{@link Peer}** is the other end of one of those pipes: it emits frames from a script
 *   and records what it receives, and makes no model calls. It is `fixture.ts`'s scripted
 *   model client one layer out — the same instrument, standing in for a runtime rather than
 *   for a provider.
 *
 * A side benefit worth naming: until this existed, exactly one driver implemented
 * `sandbox/index.ts`, so nothing could reveal an assumption that had leaked through that
 * seam. A second implementor is better evidence than a careful reading of the interface.
 *
 * Not imported by anything the substrate runs.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { encode, parseToAgent, type FromAgent, type ToAgent } from '../protocol.ts';
import { SandboxError } from '../sandbox/index.ts';
import { Supervisor } from './index.ts';
import { Store } from './store.ts';

import type { Event } from '../runtime/events.ts';
import type { Exit, Input, Process, Sandbox, SandboxDriver, SandboxRequest } from '../sandbox/index.ts';
import type { Message } from './store.ts';

/**
 * One agent's body, from the inside: what the supervisor said to it, and what it says back.
 *
 * Deliberately not a runtime. It takes no steps, calls no model and holds no loop — the
 * properties the supervisor's suite is about are what it does with frames, and a peer that
 * reasoned would make every one of them depend on reasoning.
 */
export class Peer {
  readonly agent: string;
  /** The opening input: the credential block's tail and this agent's boot frame. */
  readonly boot: string;
  readonly received: ToAgent[] = [];
  /** Frames the supervisor sent that were not readable as frames. */
  readonly unreadable: string[] = [];
  destroyed = false;
  /**
   * Set where this body takes nothing that is sent to it, and never says so.
   *
   * **The one thing a real channel can do that objects cannot.** A body's input is a pipe
   * with a finite buffer and one thread behind it, so a send to a body that has stopped
   * reading does not come back — not as a failure, which the supervisor handles, but not at
   * all. `send` here resolves the instant it is called, so nothing else in this file can
   * ask what the supervisor does while one is outstanding, and the answer used to be that
   * it did nothing for anybody.
   */
  deaf = false;

  readonly #out = new PassThrough();
  /**
   * The other stream a real process has.
   *
   * A field rather than a fresh one per access, because the supervisor keeps whatever it
   * reads here and a test has to be able to put something in it. What it cannot model is
   * the *pressure*: this accepts whatever is written whether or not anybody reads it, which
   * is exactly why an unread stream is a thing only `containers.test.ts` can ask about.
   */
  readonly #said = new PassThrough();
  #woken: (() => void)[] = [];
  #ending!: (exit: Exit) => void;
  readonly #exit = new Promise<Exit>((resolve) => (this.#ending = resolve));
  #buffered = '';

  constructor(agent: string, boot: string) {
    this.agent = agent;
    this.boot = boot;
  }

  /** The handle the supervisor is given. */
  get process(): Process {
    const stdin: Input = {
      send: async (text) => {
        if (this.destroyed) throw new SandboxError(`the sandbox of ${this.agent} is gone, so nothing was sent.`);
        if (this.deaf) return new Promise<void>(() => {});
        this.#take(text);
      },
      end: async () => {},
    };
    return { stdout: this.#out, stderr: this.#said, stdin, exit: this.#exit };
  }

  #take(text: string): void {
    this.#buffered += text;
    for (let at = this.#buffered.indexOf('\n'); at !== -1; at = this.#buffered.indexOf('\n')) {
      const line = this.#buffered.slice(0, at);
      this.#buffered = this.#buffered.slice(at + 1);
      if (line.trim() === '') continue;
      try {
        this.received.push(parseToAgent(line));
      } catch {
        this.unreadable.push(line);
      }
    }
    this.#wake();
  }

  #wake(): void {
    for (const wake of this.#woken.splice(0)) wake();
  }

  /** Say something on the channel, exactly as a runtime would. */
  say(frame: FromAgent): void {
    this.#out.write(encode(frame));
  }

  /** Whatever the test wants on the wire, including something that is not a frame at all. */
  raw(line: string): void {
    this.#out.write(line);
  }

  /** Said on the other stream: what a runtime writes when it cannot go on. */
  wrote(text: string): void {
    this.#said.write(text);
  }

  append(event: Event): void {
    this.say({ t: 'event', event });
  }

  ask(id: string, kind: string, input: unknown = {}, residency = 0): void {
    this.say({ t: 'request', id, kind, input, residency });
  }

  /** The turn ended. Zero, because an agent at a boundary has asked for nothing. */
  answered(message: string, residency = 0): void {
    this.say({ t: 'turn', message, residency });
  }

  /** The answers this peer has been given, by the id of the request each belongs to. */
  answers(): Map<string, { ok: boolean; content: string }> {
    return new Map(
      this.received.flatMap((frame) => (frame.t === 'answer' ? [[frame.id, { ok: frame.ok, content: frame.content }]] : [])),
    );
  }

  /** The messages this peer was told to begin a turn on. */
  messages(): string[] {
    return this.received.flatMap((frame) => (frame.t === 'message' ? [frame.content] : []));
  }

  /**
   * Ended without speaking, the way a killed process does.
   *
   * **The ending settles after the streams do, which is what a real process's does.** Node
   * reports a child's ending on `close` — after its output has been flushed and read — so a
   * supervisor that has the exit has, by then, also had whatever the process said on its way
   * out. A double that settled first would let a report of an ending be written before the
   * words explaining it arrived, and the test would be watching a race the driver it stands
   * in for does not have.
   */
  die(exit: Exit = { code: 137, signal: null }): void {
    this.destroyed = true;
    this.#out.end();

    const settle = (): void => {
      this.#ending(exit);
      this.#wake();
    };
    // Only where something is actually reading it. An unread stream never reaches `end`, so
    // waiting on one would hang a test rather than order it — and a reader is what the
    // ordering is for.
    const read = this.#said.listenerCount('readable') > 0 || this.#said.listenerCount('data') > 0;
    if (read) this.#said.once('end', settle);
    this.#said.end();
    if (!read) settle();
    this.#wake();
  }

  async until(satisfied: () => boolean, what = 'what the test was waiting for'): Promise<void> {
    const started = Date.now();
    while (!satisfied()) {
      if (Date.now() - started > 5_000) {
        throw new Error(`${this.agent} never reached ${what}. received: ${JSON.stringify(this.received)}`);
      }
      await Promise.race([
        new Promise<void>((wake) => this.#woken.push(wake)),
        new Promise<void>((wake) => setTimeout(wake, 10)),
      ]);
    }
  }
}

/**
 * The sandbox interface, implemented with objects.
 *
 * A workspace is a map that outlives every sandbox keyed on it, which is what makes "the
 * sweep leaves workspaces alone" a thing this can actually be asked about rather than a
 * property only a real runtime could show.
 */
export class TestDriver implements SandboxDriver {
  /** Every body ever started, oldest first, whether or not it is still running. */
  readonly peers: Peer[] = [];
  /** What each agent has written, surviving every sandbox it ever had. */
  readonly workspaces = new Map<string, Map<string, string>>();
  readonly released: string[] = [];
  /** How many times the run-wide release was asked for. */
  sweeps = 0;

  /**
   * Called as a body is about to end, before it ends.
   *
   * The one hook this double has, and it is here because the ordering it exposes cannot be
   * seen any other way: "the transcript is stored before the container is allowed to exit"
   * is a statement about a moment, and a test that reads the store afterwards would pass
   * against a supervisor that synced after destroying.
   */
  beforeDestroy?: (agentId: string) => Promise<void>;

  readonly #live = new Set<Peer>();
  readonly #provisioning = new Set<string>();

  async create(request: SandboxRequest): Promise<Sandbox> {
    // **The assumption `agent/AGENTS.md` records, made observable.** Two creations in flight
    // for one agent would each believe they made its workspace, and a failure in either
    // would then delete the other's work. Nothing in the real driver would notice; this is
    // where the supervisor finds out it grew a path that could.
    if (this.#provisioning.has(request.id)) {
      throw new SandboxError(`two sandboxes are being provisioned for ${request.id} at once.`);
    }
    this.#provisioning.add(request.id);
    try {
      if (!this.workspaces.has(request.id)) this.workspaces.set(request.id, new Map());

      let peer: Peer | undefined;
      const sandbox: Sandbox = {
        exec: async (_command, options) => {
          peer = new Peer(request.id, options?.input ?? '');
          this.peers.push(peer);
          this.#live.add(peer);
          return peer.process;
        },
        destroy: async () => {
          if (peer === undefined) return;
          await this.beforeDestroy?.(request.id);
          this.#live.delete(peer);
          peer.die({ code: 0, signal: null });
        },
      };
      return sandbox;
    } finally {
      this.#provisioning.delete(request.id);
    }
  }

  async releaseWorkspace(agentId: string): Promise<void> {
    this.workspaces.delete(agentId);
    this.released.push(agentId);
  }

  /**
   * End every body of this run, and **touch no workspace**.
   *
   * The double is written to be capable of the mistake: `workspaces` is right there, and a
   * sweep that reached for it would pass every test about ending bodies. It is the test that
   * writes into a workspace, sweeps, and reads it back that holds this.
   */
  async destroyAll(): Promise<void> {
    this.sweeps += 1;
    for (const peer of [...this.#live]) {
      this.#live.delete(peer);
      peer.die({ code: 137, signal: null });
    }
  }

  /** The body an agent is currently running in, if it has one. */
  latest(agentId: string): Peer | undefined {
    return [...this.peers].reverse().find((peer) => peer.agent === agentId);
  }

  /** Every body of this agent, oldest first — which is how often it has been provisioned. */
  all(agentId: string): Peer[] {
    return this.peers.filter((peer) => peer.agent === agentId);
  }

  get live(): Peer[] {
    return [...this.#live];
  }

  /** What an agent has in its workspace, which no suspension and no sweep may take. */
  workspace(agentId: string): Map<string, string> {
    const held = this.workspaces.get(agentId);
    if (held === undefined) throw new Error(`${agentId} has no workspace`);
    return held;
  }
}

/**
 * A run, assembled: a store in a temporary directory, the driver above, and a supervisor
 * over both. Everything a test of the supervisor needs and nothing a container runtime or a
 * model would have to be running for.
 */
export interface Run {
  supervisor: Supervisor;
  driver: TestDriver;
  store: Store;
  /** The store's root on disk, so a second supervisor can be opened over the same one. */
  directory: string;
  /** Messages the root addressed to its parent, who is the human. */
  toHuman: Message[];
  /** Every time the tree was reported stalled, and who was waiting and who had stopped. */
  stalls: { waiting: readonly string[]; stopped: readonly string[] }[];
  /** The supervisor's own trouble: what it could not do, and which agent it was doing it for. */
  failures: { agent: string; error: unknown }[];
  end(): Promise<void>;
}

export async function aRun(
  options: {
    directory?: string;
    driver?: TestDriver;
    run?: string;
    clock?: () => number;
    /** `null` leaves the supervisor's own default in place, which is what one test is about. */
    onStalled?: null;
    /** The same, for the other destinations the supervisor defaults to standard error. */
    onFailure?: null;
    onMessage?: null;
  } = {},
): Promise<Run> {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'jen-supervisor-')));
  const driver = options.driver ?? new TestDriver();
  const store = await Store.open(join(directory, '.jen'), options.run ?? 'r1');
  const toHuman: Message[] = [];
  const stalls: { waiting: readonly string[]; stopped: readonly string[] }[] = [];
  const failures: { agent: string; error: unknown }[] = [];

  const supervisor = new Supervisor({
    store,
    driver,
    command: ['jen-agent'],
    ...(options.onMessage === null ? {} : { onMessage: (message: Message) => toHuman.push(message) }),
    ...(options.onStalled === null
      ? {}
      : {
          onStalled: (stalled: { waiting: readonly string[]; stopped: readonly string[] }) =>
            stalls.push({ waiting: [...stalled.waiting], stopped: [...stalled.stopped] }),
        }),
    ...(options.onFailure === null ? {} : { onFailure: (agent: string, error: unknown) => failures.push({ agent, error }) }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  return {
    supervisor,
    driver,
    store,
    directory,
    toHuman,
    stalls,
    failures,
    end: async () => {
      await supervisor.shutdown();
    },
  };
}

/** Wait for something about the run itself, rather than about one body's channel. */
export async function until(satisfied: () => boolean, what = 'a condition'): Promise<void> {
  const started = Date.now();
  while (!satisfied()) {
    if (Date.now() - started > 5_000) throw new Error(`the run never reached ${what}.`);
    await new Promise<void>((wake) => setTimeout(wake, 5));
  }
}

/** The same, for something only the store can answer. */
export async function untilStored(satisfied: () => Promise<boolean>, what = 'a condition'): Promise<void> {
  const started = Date.now();
  while (!(await satisfied())) {
    if (Date.now() - started > 5_000) throw new Error(`the run never reached ${what}.`);
    await new Promise<void>((wake) => setTimeout(wake, 5));
  }
}
