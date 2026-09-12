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
 * The four operations are creation, process execution, destruction, and release of the
 * agent's workspace. There is deliberately no fifth. In particular there is no operation
 * for configuring network policy: there is no policy, so it would do nothing, and a no-op
 * kept for shape is dead code that reads as a feature. When restriction arrives it will
 * have a definite shape, and this file should take *that* shape rather than whichever one
 * seemed plausible beforehand.
 */
import type { Readable } from 'node:stream';

/**
 * Where a secret is to be found, never the secret itself.
 *
 * A record carrying values would have to be guarded wherever it was written down. Carrying
 * references instead makes it inert, and safe to persist beside the project.
 *
 * `name` is the variable the resolved value is delivered under; `ref` says where to resolve
 * it from, in a form the resolver understands.
 */
export interface CredentialReference {
  name: string;
  ref: string;
}

/** Turns a reference into the secret it points at. Called during creation, never before. */
export type CredentialResolver = (reference: CredentialReference) => Promise<string>;

/**
 * What creation is given.
 *
 * Nothing here describes the agent's place in a hierarchy — no parent, no depth, no flag
 * for the agent nobody spawned. That absence is the point rather than an omission: the
 * primitive is identical for every agent, and the caller is what differs between the root
 * and one spawned four levels down.
 */
export interface AgentRecord {
  /** Identifies the agent. Its workspace is keyed by this, and outlives any one sandbox. */
  id: string;
  /**
   * The environment the agent's sandbox is built from, in whatever form the substrate's
   * driver understands. The substrate supplies no default and builds nothing: a default
   * here would quietly become the thing everyone used, and defining the toolchain is the
   * project's job.
   */
  environment: string;
  /** Where inside the sandbox the agent's workspace is rooted. */
  workspace: string;
  /** Resolved at creation and delivered into the sandbox's environment. */
  credentials: CredentialReference[];
}

/** How a process ended. Deliberately not a way to address it while it runs. */
export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExecOptions {
  /** Where inside the sandbox to run. Defaults to the agent's workspace. */
  cwd?: string;
}

/**
 * A process running inside a sandbox: its output as it is produced, and its ending.
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
  create(record: AgentRecord): Promise<Sandbox>;
  releaseWorkspace(agentId: string): Promise<void>;
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
