/**
 * The sandbox primitive: an isolated environment for one agent, created and destroyed on
 * demand.
 *
 * The supervisor is the only caller. An agent never reaches this, because an agent that
 * could provision its own sandbox would hold authority its children lack — which is the
 * homogeneity constraint the substrate is built on.
 *
 * Nothing declared below belongs to any one driver. That is a requirement rather than a
 * preference, and it carries more weight than it normally would: exactly one driver exists
 * at this stage, so nothing else exercises this seam and nothing else can reveal an
 * assumption that leaked through it. The seam is held open by reading this file, which is
 * why the vocabulary of any particular implementation is kept out of it entirely — out of
 * the comments as much as the declarations, so that "read it and check" is a thing someone
 * can actually do. `index.test.ts` makes that reading a test.
 *
 * The five operations are creation, process execution, destruction, release of the agent's
 * workspace, and release of every sandbox belonging to a run. The fifth was added because
 * the other four cannot express it: destruction acts on a sandbox the caller is *holding*,
 * and the caller this exists for — one that was killed while its sandboxes were running —
 * is holding none. There is deliberately no sixth. In particular there is no operation for
 * configuring network policy: there is no policy, so it would do nothing, and a no-op kept
 * for shape is dead code that reads as a feature. When restriction arrives it will have a
 * definite shape, and this file should take *that* shape rather than whichever one seemed
 * plausible beforehand.
 */
import type { AgentRecord, CredentialReference } from '../record.ts';
import type { Readable } from 'node:stream';

export type { CredentialReference };

/** Turns a reference into the secret it points at. Called during creation, never before. */
export type CredentialResolver = (reference: CredentialReference) => Promise<string>;

/**
 * What creation is given: the fields of an agent's record that provisioning reads, and no
 * others.
 *
 * **Derived from the record rather than declared beside it**, and that is not a stylistic
 * preference. Handing the whole record over would deliver the agent's parent to a primitive
 * this specification forbids from receiving it — the primitive is identical for every
 * agent, and the caller is what differs between the agent nobody spawned and one spawned
 * four levels down. Narrowing is what keeps that true by construction.
 *
 * Deriving also cannot drift. A second hand-written interface would agree with the record
 * on the day it was written and stop agreeing the day a field was renamed, with nothing
 * failing; a field renamed on the record fails to resolve here instead.
 */
export type SandboxRequest = Pick<AgentRecord, 'id' | 'environment' | 'workspace' | 'credentials'>;

/** How a process ended. Deliberately not a way to address it while it runs. */
export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExecOptions {
  /** Where inside the sandbox to run. Defaults to the agent's workspace. */
  cwd?: string;
  /**
   * The **first** thing the process reads on its standard input, after the credentials.
   *
   * One channel rather than two, and the ordering is the whole of it. A process is sent its
   * credentials as it starts; whatever the caller has to say next follows on the same
   * input, so there is no second channel to open, to close, or to get the order wrong on.
   *
   * It is the first thing written and no longer the only one — see {@link Process.stdin}.
   * The property that was paid for here is unchanged: the credentials and this are one
   * write, so nothing interleaves and nothing arrives early. What changed is that the
   * input is not closed where they end, because a caller that can say one thing is not a
   * party to a conversation.
   */
  input?: string;
}

/**
 * What a caller sends to a running process after its first input.
 *
 * Narrower than a writable stream, and the narrowing is the contract. A stream reports a
 * failed write by emitting `error`, and an `error` with nothing listening is raised as an
 * uncaught exception that ends the process which did the listening — here, the one caller,
 * which is holding every other agent in the run. A promise cannot be ignored into a crash:
 * a send that could not be delivered rejects, the caller is told, and the caller lives.
 */
export interface Input {
  /** Send. Resolves once it has gone; rejects, rather than crashing, where it could not. */
  send(text: string): Promise<void>;
  /** Nothing further. The process observes this as its input ending. */
  end(): Promise<void>;
}

/**
 * A process running inside a sandbox: its output as it is produced, what may still be sent
 * to it, and its ending.
 *
 * Streams rather than collected output, and that is the one shape decision here with a
 * consumer already waiting on it. The only real caller attaches a line-delimited protocol
 * to a long-running process. Collected output would arrive when that process exits, which
 * for a process built to stay up and converse is never. A test wanting the whole of it can
 * accumulate a stream in a line or two; a caller wanting a stream cannot recover one from
 * a buffer.
 */
export interface Process {
  stdout: Readable;
  stderr: Readable;
  stdin: Input;
  exit: Promise<Exit>;
}

/**
 * One agent's isolated environment, while it is working.
 *
 * `destroy` ends a single period of the agent's activity, not the agent. The workspace
 * survives it — see {@link SandboxDriver.releaseWorkspace}.
 */
export interface Sandbox {
  exec(command: string[], options?: ExecOptions): Promise<Process>;
  destroy(): Promise<void>;
}

/**
 * Provisions sandboxes, and releases what outlives them.
 *
 * The two lifetimes are separate operations rather than one operation with a mode, because
 * they have different subjects: `destroy` ends a period of activity and `releaseWorkspace`
 * ends the agent. A single call taking a flag reads as one operation with a modifier, and
 * the mistake it invites — passing the wrong mode on a suspension — destroys a day of an
 * agent's work.
 */
export interface SandboxDriver {
  create(request: SandboxRequest): Promise<Sandbox>;
  releaseWorkspace(agentId: string): Promise<void>;
  /**
   * End every sandbox of this driver's run, holding a handle on none of them.
   *
   * **It ends bodies and releases no workspace**, and the naming has to carry that as much
   * as the implementation does. The moment this is reached is after a failure, which is
   * precisely the moment every agent's work is sitting in its workspace waiting to be
   * resumed from; "release everything belonging to the run" read literally would delete all
   * of it, through a call whose purpose reads as tidying up. That is the same distinction
   * {@link Sandbox.destroy} and {@link releaseWorkspace} already hold apart, arriving at
   * the scale where it is easiest to lose.
   *
   * It takes no argument. A driver is constructed for one run and knows its own, so a
   * caller naming one could name another's.
   */
  destroyAll(): Promise<void>;
}

/**
 * What every failure here is reported as.
 *
 * Creation fails rather than substituting something less isolated — not now, and not once
 * a second driver exists. A run that quietly loses its isolation is indistinguishable from
 * one that kept it, which makes silent degradation worse than failure.
 */
export class SandboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
  }
}
