/**
 * The container driver: the one sandbox driver, and the whole of what knows about
 * containers.
 *
 * It reaches the runtime by running the `docker` command-line client as a subprocess. No
 * client library, because a library would mean the substrate gains a package manifest and
 * a dependency, which `agent-substrate` rules out. The cost is that output has to be
 * parsed; it is kept small by asking for machine-readable output with an explicit
 * `--format` and reading only the values actually needed.
 *
 * **This module imports nothing from `node:fs`, and must not.** The credential requirement
 * — no secret on disk, ever, inside the sandbox or outside it — is held by this module
 * writing no files at all, which makes disposal a property of the sandbox's destruction
 * rather than a cleanup step that can be skipped or interrupted. `docker.test.ts` guards
 * the absence at the source level, because a write added later would be invisible to any
 * behavioural test that did not happen to look for it.
 *
 * **Writing no file of its own is not enough, though, and that is the subtlety to hold on
 * to: the runtime writes files too.** Anything handed to it as container configuration —
 * `--env` in either spelling included — it keeps in the container's own record for as long
 * as the container exists, where `inspect` reads it back in full. So creation hands it no
 * environment at all, and credentials reach each process over that process's standard
 * input. See {@link DELIVER}.
 *
 * Podman speaks the same command-line surface and is expected to work unchanged, but
 * nothing here is tested against it.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

import { SandboxError } from './index.js';

import type { Readable } from 'node:stream';
import type { AgentRecord, CredentialReference, CredentialResolver, Exit, Process, Sandbox, SandboxDriver } from './index.js';

/** Prefixes and labels. `jen.run` and `jen.agent` are what an orphan sweep finds. */
const SANDBOX_PREFIX = 'jen-sandbox';
const WORKSPACE_PREFIX = 'jen-workspace';
const RUN_LABEL = 'jen.run';
const AGENT_LABEL = 'jen.agent';

/**
 * What a sandbox runs while it holds no process of its own.
 *
 * Creation provisions and idles; `exec` is what starts processes. Making the agent runtime
 * the container's main process instead would give the interface two ways to run a process —
 * one implied by creation and one explicit — and would put the protocol's stdio into
 * creation's return type, which is exactly the detail this primitive must not know about.
 *
 * `sh` and `sleep` are the only things this asks of an image. A shell loop rather than a
 * long single `sleep` because the maximum argument `sleep` accepts varies between
 * implementations; nothing depends on the interval.
 */
const IDLE = ['sh', '-c', 'while :; do sleep 3600; done'];

/**
 * How a credential reaches a process: read from standard input, exported, and gone.
 *
 * This is the mechanism the design recorded as its fallback, and it is the one in use. The
 * primary — `--env NAME` with no `=value`, which forwards the value from the `docker`
 * process's own environment — does work, and it satisfies only half of what it was for. The
 * secret stays out of argv; the runtime then resolves it into the container's configuration,
 * where it can be read back in full for as long as the container exists. The requirement is
 * that no file inside or outside the sandbox holds the secret, and a record the runtime
 * keeps past the call is what that forbids.
 *
 * The fallback had to move as well. As recorded it delivered to the *entrypoint*, and that
 * cannot work: a process started by `exec` takes its environment from the container's
 * configuration rather than from the process already running inside, so an entrypoint that
 * exported the credentials would be the only thing that ever saw them. Delivery is therefore
 * per process, at the moment one starts. Creation still resolves the references, which is
 * what keeps an unresolvable credential a creation failure rather than a surprise later.
 *
 * The block is one `NAME=value` per line, ended by an empty line — so a value may not
 * contain a newline, and {@link DockerSandboxDriver.create} refuses one that does rather
 * than delivering a truncated secret. `sh` is all this asks of an image, which is what a
 * sandbox already idles on, and `$0` is a throwaway so `"$@"` is the caller's command
 * exactly.
 */
const DELIVER = 'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done; exec "$@"';

/**
 * What a name has to look like for {@link DELIVER} to be able to export it.
 *
 * The portable shell grammar, and it is narrower than the characters a line of the block
 * could physically carry — which is the distinction that was missed. Excluding only what
 * breaks the *protocol* (an empty name, a newline, an `=`) lets through names the *shell*
 * refuses: `1BAD`, `A-B` and `A B` all reach the container intact and die there with
 * `export: bad variable name`. Checked against the shell this delivers to rather than
 * reasoned about.
 *
 * Enforced at creation, because the alternative is a creation that succeeds and every
 * process started in it failing afterwards in the credential prologue — a protocol error
 * deferred to a place it cannot be understood from.
 */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A started subprocess: its output as it is produced, and its ending. */
export interface Started {
  stdout: Readable;
  stderr: Readable;
  exit: Promise<Exit>;
}

/**
 * How this driver starts a subprocess.
 *
 * A seam rather than a mock: tests wrap the real spawner to record the argv that was
 * actually passed, which is the only way to hold the credential requirement — that a
 * secret reaches no command line — against the command line that really ran.
 *
 * `input` is written to the subprocess's standard input, which is then closed. It has one
 * caller — credential delivery — and it is why that delivery leaves no trace anywhere else
 * in this module: a secret sent this way is in a pipe and in the receiving process's
 * memory, and in no argument, no file, and no record the runtime keeps.
 *
 * Part of the contract, and the part a wrapper around this cannot leave to the default: a
 * pipe that breaks is reported through `exit` and never as an uncaught error.
 */
export type Spawner = (command: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => Started;

/** The default spawner, over `node:child_process`. */
export const spawner: Spawner = (command, args, env, input) => {
  // Standard input is a pipe only when there is something to send. Left open on the many
  // calls that send nothing it would be a descriptor per call, and descriptors are one of
  // the things a create/destroy cycle is required not to accumulate.
  const child = spawn(command, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });

  // **Every pipe is listened to, and that is not defensive tidiness.** A stream reports its
  // own failure by emitting `error`, and an `error` with nothing listening is not dropped:
  // Node raises it as an uncaught exception and the process dies. The process here is the
  // supervisor, so one agent's broken pipe would end every other agent's run with it.
  //
  // The reachable case is the credential block with no reader left — `docker exec` refused,
  // or a container gone between the call and the runtime's attempt at it — which ends the
  // write in `EPIPE`. That error is emitted on `child.stdin`, never on `child`, so the
  // listeners below are not where it arrives.
  let broken: Error | undefined;
  for (const pipe of [child.stdin, child.stdout, child.stderr]) {
    pipe?.on('error', (error: Error) => {
      broken ??= error;
    });
  }

  const exit = new Promise<Exit>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A broken pipe means something did not arrive: credentials on the way in, or output
      // on the way back. Where the subprocess failed anyway, its own exit and its stderr
      // account for that better than the broken pipe does, and that is what the caller
      // gets — a failed process, which is what a caller can act on. Where it *succeeded*,
      // nothing else would ever mention it: a command that ran without the credentials it
      // was sent looks exactly like one that had them, and that is the case this must not
      // let pass as a success.
      if (broken !== undefined && code === 0) {
        reject(new SandboxError(`a pipe to \`${command}\` broke before it was finished with: ${broken.message}`, { cause: broken }));
        return;
      }
      resolve({ code, signal });
    });
  });

  // After the listeners, not before: this write is asynchronous, and its failure is one of
  // the events they exist to catch.
  child.stdin?.end(input);

  // `stdout`/`stderr` are non-null under the `pipe` stdio above; the types allow null
  // because other stdio settings would leave them absent.
  return { stdout: child.stdout as Readable, stderr: child.stderr as Readable, exit };
};

/**
 * Resolve `env:NAME` against an environment.
 *
 * The error names the *reference*, never the value: an error message is the one place a
 * secret escapes to a log without anybody meaning it to.
 */
export function resolveFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CredentialResolver {
  return async (reference: CredentialReference) => {
    const separator = reference.ref.indexOf(':');
    const scheme = separator === -1 ? '' : reference.ref.slice(0, separator);
    if (scheme !== 'env') {
      throw new SandboxError(`the credential \`${reference.name}\` names an unsupported reference \`${reference.ref}\`.`);
    }
    const value = environment[reference.ref.slice(separator + 1)];
    if (value === undefined || value === '') {
      throw new SandboxError(`the credential \`${reference.name}\` resolves to \`${reference.ref}\`, which is not set.`);
    }
    return value;
  };
}

export interface DockerDriverOptions {
  /** Labelled onto everything this driver creates, so a sweep can find what a run left. */
  run: string;
  /** The runtime's command-line client. Tests point this at a path that does not exist. */
  docker?: string;
  /** The environment `docker` is run with. Tests point this at an unreachable runtime. */
  env?: NodeJS.ProcessEnv;
  resolve?: CredentialResolver;
  spawn?: Spawner;
}

/** A subprocess that has finished, with everything it wrote. */
interface Completed extends Exit {
  stdout: string;
  stderr: string;
}

export class DockerSandboxDriver implements SandboxDriver {
  readonly #run: string;
  readonly #docker: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolve: CredentialResolver;
  readonly #spawn: Spawner;

  constructor(options: DockerDriverOptions) {
    this.#run = options.run;
    this.#docker = options.docker ?? 'docker';
    this.#env = options.env ?? process.env;
    this.#resolve = options.resolve ?? resolveFromEnvironment(this.#env);
    this.#spawn = options.spawn ?? spawner;
  }

  /**
   * Ensure the agent's workspace, then start its sandbox.
   *
   * The two steps are why a failure partway needs care. "Leave nothing behind" cannot mean
   * "remove the workspace": on a resume the workspace already existed and holds the agent's
   * work. So this tracks what *this call* brought into existence and unwinds only that.
   */
  async create(record: AgentRecord): Promise<Sandbox> {
    const workspace = workspaceName(record.id);
    const name = `${SANDBOX_PREFIX}-${slug(record.id)}-${randomBytes(4).toString('hex')}`;
    let mine = false;
    let credentials = '';
    let rooted = '';

    try {
      mine = await this.#ensureWorkspace(workspace, record.id);
      credentials = await this.#deliverable(record.credentials);
      rooted = containerPath(record.workspace);

      const args = [
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        `${RUN_LABEL}=${this.#run}`,
        '--label',
        `${AGENT_LABEL}=${record.id}`,
        // The agent's workspace, and the only thing mounted. No directory of the machine's
        // is mounted in, and the runtime's own socket never is — that one is not one
        // measure among several, since mounting it grants trivial root outside the sandbox
        // and would make every other guarantee here decorative.
        //
        // This argument is *composed* from caller data rather than handed it whole, which
        // is what {@link containerPath} is for: the two sides are joined by a `:`, and a
        // `:` arriving from the record would move the join. Both positions take the
        // checked value, because the guarantee is that they name the same one place.
        '--volume',
        `${workspace}:${rooted}`,
        '--workdir',
        rooted,
      ];

      // Nothing of the credentials is passed here — not in an argument, and not in the
      // environment this child is given. What the runtime is told at creation it writes
      // down, so it is told nothing; delivery is DELIVER, per process.
      //
      // No network flag either: the sandbox takes the runtime's default, which is
      // unrestricted and is no code at all. There is no policy to configure.
      //
      // **Everything from here is an operand, never an option**, and the two things holding
      // that are doing different jobs. The terminator is what the runtime enforces: after
      // `--` the next token is read as the image however it is spelled. {@link operand} is
      // what holds where the terminator does not — that `--` ends option parsing is a fact
      // about *this* runtime's argument parser, and the driver is meant to run against
      // another one that nothing here tests.
      args.push('--', operand(record.environment), ...IDLE);

      await this.#must(args, `creating a sandbox for ${record.id}`);
    } catch (error) {
      await this.#unwind(name, mine ? workspace : undefined);
      throw error;
    }

    return this.#sandbox(name, rooted, credentials);
  }

  /**
   * Resolve every reference into the block a process is sent as it starts.
   *
   * Resolution happens at creation so that a credential that cannot be resolved fails the
   * creation it belongs to, and unwinds with it, rather than surfacing later as a process
   * mysteriously missing a variable.
   *
   * The two refusals are the delivery's — {@link VARIABLE_NAME} for the name, the line
   * protocol for the value — and they are refusals rather than escapes on purpose: a
   * truncated secret is worse than a failed creation, because it arrives looking like a
   * secret. Both name the credential and never the value — an error message is the one place
   * a secret escapes to a log without anybody meaning it to.
   */
  async #deliverable(credentials: readonly CredentialReference[]): Promise<string> {
    let block = '';
    for (const credential of credentials) {
      if (!VARIABLE_NAME.test(credential.name)) {
        throw new SandboxError(`the credential \`${credential.name}\` is not a usable variable name.`);
      }
      const value = await this.#resolve(credential);
      if (/[\n\r]/.test(value)) {
        throw new SandboxError(
          `the credential \`${credential.name}\` resolves to a value containing a newline, which cannot be delivered.`,
        );
      }
      block += `${credential.name}=${value}\n`;
    }
    // The empty line is what tells the receiving shell the block has ended.
    return `${block}\n`;
  }

  /** Ends the agent, not a period of its activity. Succeeds when there is nothing left. */
  async releaseWorkspace(agentId: string): Promise<void> {
    await this.#must(
      ['volume', 'rm', '--force', workspaceName(agentId)],
      `releasing the workspace for ${agentId}`,
    );
  }

  /**
   * The handle creation returns.
   *
   * An object closing over the driver's private members rather than a class beside it,
   * because a separate class could not reach them and would need them made public — which
   * would put the sandbox's name, a container concept, onto something a caller can see.
   */
  #sandbox(name: string, workspace: string, credentials: string): Sandbox {
    return {
      /**
       * Every process starts through DELIVER, whether or not this agent has a credential —
       * one path, so the path that carries them is the one every test here exercises.
       * `--interactive` is what keeps standard input attached long enough for the block to
       * arrive; it is closed straight after, which the command sees as the end of its own
       * input.
       */
      exec: async (command, options) =>
        this.#start(
          ['exec', '--interactive', '--workdir', options?.cwd ?? workspace, name, 'sh', '-c', DELIVER, 'sh', ...command],
          credentials,
        ),

      /**
       * Explicit removal, rather than `--rm` at creation.
       *
       * `--rm` is tempting for leak-freeness and it makes destruction implicit and
       * untestable: a test asserting that this removed the sandbox could not tell it from
       * one the runtime removed on its own, and a sandbox that died unexpectedly would
       * disappear along with whatever would have explained why.
       *
       * `--force` is what makes the two awkward cases behave: a sandbox already gone exits
       * zero rather than failing, which matters because an ordinary teardown and a sweep
       * can both reach the same one; and a sandbox whose process is still running is
       * stopped rather than waited for.
       */
      destroy: async () => {
        await this.#must(['rm', '--force', name], `destroying the sandbox ${name}`);
      },
    };
  }

  /**
   * Whether this call created the workspace.
   *
   * `volume ls` with an anchored filter rather than `volume inspect`, and the difference is
   * not stylistic. `inspect` exits non-zero both when the workspace is absent and when the
   * runtime cannot be reached, and reading the second as the first is how a transient
   * failure on a *resume* ends up reported as a workspace this call created — which hands
   * the unwind below permission to delete a day of the agent's work. `ls` exits zero
   * whether or not it matched, so a non-zero exit means only that something really failed.
   */
  async #ensureWorkspace(workspace: string, agentId: string): Promise<boolean> {
    const found = await this.#must(
      ['volume', 'ls', '--filter', `name=^${workspace}$`, '--format', '{{.Name}}'],
      `looking for the workspace of ${agentId}`,
    );
    if (found.stdout.trim() === workspace) return false;

    await this.#must(
      ['volume', 'create', '--label', `${RUN_LABEL}=${this.#run}`, '--label', `${AGENT_LABEL}=${agentId}`, workspace],
      `creating the workspace for ${agentId}`,
    );
    return true;
  }

  /** Undo what this call created, and only that. Failures here never mask the original. */
  async #unwind(name: string, workspace: string | undefined): Promise<void> {
    await this.#quietly(['rm', '--force', name]);
    if (workspace !== undefined) await this.#quietly(['volume', 'rm', '--force', workspace]);
  }

  async #quietly(args: string[]): Promise<void> {
    try {
      await this.#collect(args);
    } catch {
      // The failure that sent us here is the one the caller needs to see.
    }
  }

  /** Start a subprocess, reporting a runtime that cannot be run at all as such. */
  #start(args: string[], input?: string): Process {
    const started = this.#spawn(this.#docker, args, this.#env, input);
    const exit = started.exit.catch((error: unknown) => {
      // A broken pipe is already this driver's own account of what happened, and the
      // runtime was reachable enough to break it. Only a failure to run it at all is
      // #unreachable, and reporting the two the same way would name the wrong cause.
      throw error instanceof SandboxError ? error : this.#unreachable(error);
    });
    // The caller is not obliged to await this, and an unawaited rejection is a crash.
    exit.catch(() => {});
    return { stdout: started.stdout, stderr: started.stderr, exit };
  }

  async #collect(args: string[]): Promise<Completed> {
    const started = this.#spawn(this.#docker, args, this.#env);
    let stdout = '';
    let stderr = '';
    started.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    started.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    try {
      return { ...(await started.exit), stdout, stderr };
    } catch (error) {
      throw error instanceof SandboxError ? error : this.#unreachable(error);
    }
  }

  /** Run to completion, and turn a non-zero exit into an error naming what failed. */
  async #must(args: string[], what: string): Promise<Completed> {
    const done = await this.#collect(args);
    if (done.code === 0) return done;
    const how = done.signal ?? `exit ${done.code}`;
    throw new SandboxError(`${what} failed (${how}): ${done.stderr.trim().slice(0, 500)}`);
  }

  /**
   * The runtime could not be started at all — typically because it is not installed.
   *
   * Reported as a failure, never as a fallback to something less isolated. A run that
   * quietly lost its isolation would be indistinguishable from one that kept it.
   */
  #unreachable(error: unknown): SandboxError {
    const detail = error instanceof Error ? error.message : String(error);
    return new SandboxError(`the container runtime could not be run as \`${this.#docker}\`: ${detail}`, {
      cause: error,
    });
  }
}

/**
 * The record's environment, confirmed to be something a runtime reads as its image rather
 * than as an option.
 *
 * The hazard is worth stating plainly, because the argument list above looks safe and is
 * not: caller data sitting in the runtime's option-parsing position is parsed as options.
 * On this runtime an environment of `--help` is consumed as the help flag, which *exits
 * zero* and creates nothing — so creation would succeed and hand back a sandbox with no
 * container behind it. The same position takes `--privileged`, which would give away the
 * isolation this primitive exists to provide, and it would be given away by a record rather
 * than by any code here.
 *
 * Deliberately not an image-reference grammar. What a reference may look like belongs to
 * the runtime and to whatever registry it talks to, and a driver deciding it here would
 * start refusing things the runtime accepts. The narrow property is the whole of what is
 * wrong: a leading `-` is never a legitimate reference, and it is exactly what makes a
 * token an option.
 */
function operand(environment: string): string {
  if (environment === '' || environment.startsWith('-')) {
    throw new SandboxError(`the environment \`${environment}\` cannot be read as a sandbox image.`);
  }
  return environment;
}

/**
 * The record's workspace, confirmed to be one path inside a sandbox that the arguments
 * carrying it cannot split into something else.
 *
 * The hazard is the same one {@link operand} answers, in its quieter form. The volume
 * argument is *composed* — `source:destination[:options]`, joined by this module — so a
 * record whose workspace is `/workspace:ro` does not name a path with a colon in it. It
 * moves the join: the runtime mounts at `/workspace`, reads `ro` as a mount option, and
 * exits **zero**. `--workdir` is a separate argument and is handed the string whole, so it
 * still names `/workspace:ro` — a directory that does not exist yet, which the runtime
 * creates in the container's writable layer. Creation succeeds, every process starts in a
 * directory that looks right, and the agent's work is written outside its own volume and
 * discarded with the container. Reproduced on this runtime before this check was written.
 *
 * **What is checked is the value, not the flag**, because the value reaches three positions
 * with three different syntaxes — the composed volume argument, `--workdir`, and the default
 * `cwd` of every `exec` — and the property needed is that all three name the same one place.
 * Switching the mount to the `type=volume,dst=…` spelling was the alternative considered and
 * it does preserve a colon; it reads `,` as a delimiter of its own instead, so it relocates
 * the hazard rather than removing it, and it would newly refuse `/a,b`, which the composed
 * form carries intact. A flag can only ever fix its own argument.
 *
 * The two conditions are the whole of it. A colon is the delimiter. Absolute is what makes
 * one path name one place at all, and it is required of a mount destination by the runtime
 * anyway — kept here so the failure names the record's field rather than arriving as a parse
 * error about an argument the caller never wrote. Nothing else is decided here: `..` and
 * repeated separators are normalised by the runtime, and it applies the same normalisation
 * to both positions, so they continue to agree.
 */
function containerPath(workspace: string): string {
  if (!workspace.startsWith('/') || workspace.includes(':')) {
    throw new SandboxError(`the workspace \`${workspace}\` is not a usable path inside a sandbox.`);
  }
  return workspace;
}

/** The agent's workspace. Keyed by the agent, because it outlives any one sandbox. */
function workspaceName(agentId: string): string {
  return `${WORKSPACE_PREFIX}-${slug(agentId)}`;
}

/**
 * An agent's id as the runtime will accept it.
 *
 * The runtime allows only `[a-zA-Z0-9_.-]`, and replacing the rest is lossy — two distinct
 * agents could collapse onto one name, and share a workspace they must never share. The
 * digest of the original is what keeps them apart; the readable part is for whoever is
 * looking at a list of these.
 */
function slug(agentId: string): string {
  const readable = agentId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 32);
  return `${readable}-${createHash('sha256').update(agentId).digest('hex').slice(0, 10)}`;
}
