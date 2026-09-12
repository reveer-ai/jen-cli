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
 */
export type Spawner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Started;

/** The default spawner, over `node:child_process`. */
export const spawner: Spawner = (command, args, env) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<Exit>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
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

    try {
      mine = await this.#ensureWorkspace(workspace, record.id);

      // The secrets live in the environment of the `docker` child and nowhere else.
      const env: NodeJS.ProcessEnv = { ...this.#env };
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
        '--volume',
        `${workspace}:${record.workspace}`,
        '--workdir',
        record.workspace,
      ];

      for (const credential of record.credentials) {
        env[credential.name] = await this.#resolve(credential);
        // `--env NAME` with no `=value` forwards the value from this process's own
        // environment. Both obvious alternatives violate the credential requirement:
        // `--env NAME=value` puts the secret in argv, readable by every process on the
        // machine for the life of the call, and `--env-file` puts it on disk.
        args.push('--env', credential.name);
      }

      // No network flag: the sandbox takes the runtime's default, which is unrestricted and
      // is no code at all. There is no policy to configure, so there is nothing to pass.
      args.push(record.environment, ...IDLE);

      await this.#must(args, `creating a sandbox for ${record.id}`, env);
    } catch (error) {
      await this.#unwind(name, mine ? workspace : undefined);
      throw error;
    }

    return this.#sandbox(name, record.workspace);
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
  #sandbox(name: string, workspace: string): Sandbox {
    return {
      exec: async (command, options) =>
        this.#start(['exec', '--workdir', options?.cwd ?? workspace, name, ...command]),

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
      await this.#collect(args, this.#env);
    } catch {
      // The failure that sent us here is the one the caller needs to see.
    }
  }

  /** Start a subprocess, reporting a runtime that cannot be run at all as such. */
  #start(args: string[]): Process {
    const started = this.#spawn(this.#docker, args, this.#env);
    const exit = started.exit.catch((error: unknown) => {
      throw this.#unreachable(error);
    });
    // The caller is not obliged to await this, and an unawaited rejection is a crash.
    exit.catch(() => {});
    return { stdout: started.stdout, stderr: started.stderr, exit };
  }

  async #collect(args: string[], env: NodeJS.ProcessEnv): Promise<Completed> {
    const started = this.#spawn(this.#docker, args, env);
    let stdout = '';
    let stderr = '';
    started.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    started.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    try {
      return { ...(await started.exit), stdout, stderr };
    } catch (error) {
      throw this.#unreachable(error);
    }
  }

  /** Run to completion, and turn a non-zero exit into an error naming what failed. */
  async #must(args: string[], what: string, env: NodeJS.ProcessEnv = this.#env): Promise<Completed> {
    const done = await this.#collect(args, env);
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
