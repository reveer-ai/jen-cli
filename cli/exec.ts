/**
 * The executor: a run request in, a finished stage session out.
 *
 * Everything that touches the world lives here — the run's directory, the clone, the trust
 * entry, the credential, the child process, and the signal. It is deliberately *not* in
 * `run.ts`: the tick's writes-nothing property is held by a source-level guard in
 * `test/dispatch.test.ts`, and that guard keeps meaning what it means only while nothing on
 * the decision path can reach a module that writes. `tick()` takes a launcher as a parameter
 * rather than importing one, so the guard passes unmodified. See `cli/AGENTS.md`.
 *
 * No judgment happens here. The request was decided by the tick and is taken as decided:
 * the skill it names is the skill that runs, the role it names is the identity it runs
 * under, and a status that changed since the decision changes nothing. `stage-execution`
 * states this as a requirement, and the reason is that two runners must not be able to reach
 * different conclusions from the same request — whichever of them dispatched it.
 *
 * Nothing here writes to the tracker — not for a session that failed, and not for one that
 * was terminated. Every tracker write in the pipeline belongs to a stage session, which is
 * what makes a dead session's task read as in flight until a person moves it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { credentialsFor, GitHub, NAMESPACE, remoteUrl, STAGE_SCOPE, VARIABLES, type Credentials, type Environment } from './github.js';
import { openspecBin } from './openspec.js';
import { STAGES } from './stages.js';

import type { RunRequest } from './run.js';
import type { Role } from './stages.js';

/**
 * The warning a session prints when its workspace was never trusted, and the reason this
 * module exists in the shape it does.
 *
 * Matched on the *symptom* rather than on the mechanism, which is what makes it worth more
 * than the mechanism it defends: `CLAUDE_CONFIG_DIR` is undocumented, and if it is withdrawn
 * or the path is written wrong, this fires on the first second of the run instead of the
 * session being denied its own build halfway through with nobody there to grant it.
 *
 * **But the symptom is an entry count, so this is silent on an empty `allow` array.** The CLI
 * prints nothing at all at zero entries — verified on 2.1.260, two otherwise-identical
 * untrusted runs — so a failed trust write is indistinguishable from a healthy start for any
 * project that has not written allow rules of its own. As of ENG-190 that is what jen ships:
 * `scaffold/settings.json` grants nothing, and the coverage above is now conditional on the
 * adopter having added entries jen no longer asks for. Trust gates the *file*, not this one
 * key, so a project whose settings carry only `deny` rules or an `env` block loses them to an
 * untrusted clone with nothing on stderr to say so. Widening the net needs a check that does
 * not key on the entry count — ENG-192.
 */
export const PERMISSION_WARNING = /Ignoring \d+ permissions\.allow entries/;

/** Where the tracker's MCP server lives. Overridable only so a test can point elsewhere. */
export const TRACKER_MCP_URL = 'https://mcp.linear.app/mcp';

/**
 * The key the tracker's server is written under, and therefore the name the session reports
 * it by.
 *
 * Named rather than assumed, because the clone is a full jen installation: a project's own
 * `.mcp.json` contributes servers beside this one, and a failure has to be able to say which
 * of them it was. Diagnosing every unconnected server as the tracker sends whoever reads the
 * report after the wrong thing entirely.
 */
export const TRACKER_SERVER = 'linear';

/** What a finished run is known to have done. Handed back; nothing here records it. */
export interface RunOutcome {
  task: string;
  skill: string;
  role: Role;
  /** Whether the session both ran and reported success. Every signal must agree. */
  ok: boolean;
  /** Every signal that said failure, in the order they were read. Empty when {@link ok}. */
  failures: string[];
  /**
   * What the run has to say that is not a failure. Empty where there is nothing.
   *
   * Deliberately a channel of its own rather than an entry in {@link failures}, because
   * {@link ok} is derived from that array: a misconfiguration an operator should hear about
   * would otherwise stop a pipeline, and the declarations that earn a note here are exactly
   * the ones that changed nothing for any stage. Read on every branch of the report, since a
   * run that succeeded can still have something to say.
   */
  notes: string[];
  /** `total_cost_usd`, where the session reported one. */
  cost?: number;
  sessionId?: string;
  /** The session's own stream, line-delimited, as it was emitted. */
  transcript: string;
  /**
   * Where {@link transcript} was kept, where the operator named somewhere to keep it.
   *
   * Absent by default, and that is the default deliberately: a transcript is the session's
   * entire stream — the repository's content, every tool result, whatever the stage read —
   * so a durable copy of it is a disclosure the operator makes, not one jen makes for them.
   */
  transcriptPath?: string;
  /** Whether the run ended because it was stopped rather than because the session did. */
  terminated: boolean;
  /**
   * Whether the stage session was started at all.
   *
   * Read beside {@link terminated}, which without it cannot tell a run stopped before its
   * session from one stopped in the middle of it. The two leave the task in different
   * states: the first did nothing, and the second left whatever the session had got to.
   */
  sessionStarted: boolean;
}

/** What `tick()` is given so it can act without importing anything that acts. */
export type Launcher = (request: RunRequest) => Promise<RunOutcome>;

/** A spawned child's ending, with everything it wrote. */
export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** A running child: what it will have written, and a way to stop it. */
export interface Child {
  exited: Promise<Exit>;
  kill(signal: NodeJS.Signals): void;
}

export type Spawner = (spec: CommandSpec) => Child;

/**
 * The default spawner, over `node:child_process`.
 *
 * stdin is `'ignore'` rather than inherited, which is the redirect the design costed: a
 * `claude -p` with a live stdin waits about three seconds for input that will never arrive,
 * on every run.
 */
export const spawner: Spawner = (spec) => {
  const child: ChildProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

  const exited = new Promise<Exit>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  return { exited, kill: (signal) => child.kill(signal) };
};

export interface ExecOptions {
  env?: Environment;
  spawn?: Spawner;
  /** The assistant, as a command and its leading arguments. Tests point this at a stub. */
  claude?: string[];
  /** How a repository is addressed for cloning. Tests point this at a local path. */
  remote?: (repo: string) => string;
  /** Where run directories are made. Defaults to the system temporary directory. */
  root?: string;
  trackerMcpUrl?: string;
  github?: GitHub;
  /** Kept after the run rather than removed. Never set outside a test that inspects it. */
  keepDirectory?: boolean;
  /**
   * Where to keep each session's transcript. Unset discards it with the run's directory.
   *
   * Deliberately outside the run's own directory, which is removed when the run ends, and
   * never the clone, which is discarded with it.
   */
  transcripts?: string;
}

/** One event off the session's `stream-json` stream, as much of it as the run reads. */
interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  mcp_server_errors?: unknown[];
  mcp_servers?: { name?: string; status?: string }[];
  is_error?: boolean;
  total_cost_usd?: number;
  result?: string;
}

/** An MCP server the session reported as anything but connected, and what was said about it. */
export interface McpFailure {
  /** The server's own name, where the event carried one. */
  server?: string;
  /** What the event said about it, without a diagnosis attached. */
  detail: string;
}

/** What the session's own stream said, reduced to the three things a verdict rests on. */
export interface SessionReport {
  /** Servers that did not come up, each named. Empty where every one connected. */
  mcpFailures: McpFailure[];
  /** Whether an init event was seen at all. Its absence is itself a failure. */
  started: boolean;
  isError?: boolean;
  cost?: number;
  sessionId?: string;
  resultText?: string;
}

/**
 * Read the session's stream.
 *
 * `stream-json` rather than `json` — and therefore `--verbose`, which it requires — because
 * plain `json` returns only the final result and the MCP verification lives in the
 * `system/init` event. Needing the init event is the whole reason for the format.
 *
 * Both shapes of MCP failure are read: an explicit `mcp_server_errors` list, and a
 * `mcp_servers` entry whose status is anything but connected. The task was written against
 * the first and the harness has been observed emitting the second, and a check that knew
 * only one of them would pass a session that never reached the tracker — which is the
 * failure that feeds straight back into repeated dispatch, since a session that cannot
 * reach the tracker cannot announce itself.
 *
 * Unparseable lines are skipped rather than raised on. The stream carries whatever the
 * session's tools printed, and a run that failed on a stray line would be reporting the
 * wrong failure.
 */
export function readStream(stdout: string): SessionReport {
  const report: SessionReport = { mcpFailures: [], started: false };

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      report.started = true;
      report.sessionId ??= event.session_id;
      for (const failure of event.mcp_server_errors ?? []) {
        const named = typeof failure === 'object' && failure !== null ? (failure as { name?: unknown }).name : undefined;
        report.mcpFailures.push({
          server: typeof named === 'string' ? named : undefined,
          detail: typeof failure === 'string' ? failure : JSON.stringify(failure),
        });
      }
      for (const server of event.mcp_servers ?? []) {
        if (server.status && server.status !== 'connected') {
          report.mcpFailures.push({ server: server.name, detail: `reported \`${server.status}\`` });
        }
      }
    }

    if (event.type === 'result') {
      report.isError = event.is_error ?? report.isError;
      report.cost = event.total_cost_usd ?? report.cost;
      report.sessionId = event.session_id ?? report.sessionId;
      report.resultText = event.result ?? report.resultText;
    }
  }

  return report;
}

/**
 * The verdict, from every signal at once.
 *
 * Success is not concluded from the exit status alone. The task was opened saying an in-run
 * failure prints as the result rather than raising the exit code; verified against 2.1.220,
 * an authentication failure raised *both* — exit 1 and `is_error: true`. So neither signal
 * is reliably the whole story, and reading only one is right by accident. Treating any of
 * them as sufficient for failure costs nothing: they agree on success, and a disagreement is
 * a failure either way.
 *
 * A pure function of what was observed, so every one of these paths is a test rather than
 * something that was thought about once.
 */
export function verdict(report: SessionReport, exit: Exit, stderr: string): string[] {
  const failures: string[] = [];

  if (PERMISSION_WARNING.test(stderr)) {
    failures.push(
      'the session reported that its workspace was never trusted, so the permissions its own checks ' +
        'require were not in force. Establishing trust is this run\'s job and it did not take effect.',
    );
  }
  for (const failure of report.mcpFailures) {
    // Only the tracker's own key earns the tracker's diagnosis. The clone is a full jen
    // installation, so a project's `.mcp.json` contributes servers too, and reporting one of
    // those as the tracker points the reader at the wrong system.
    failures.push(
      failure.server === TRACKER_SERVER
        ? `the tracker connection did not initialize: ${failure.detail}`
        : `an MCP server the session was given did not initialize: ` +
          `${failure.server ? `\`${failure.server}\` ` : ''}${failure.detail}`,
    );
  }
  if (!report.started) {
    failures.push('the session emitted no init event, so it never started.');
  }
  if (report.isError) {
    failures.push(`the session reported failure: ${report.resultText?.slice(0, 300) ?? 'no detail given'}`);
  }
  if (exit.signal) {
    failures.push(`the session was killed by ${exit.signal}.`);
  } else if (exit.code !== 0) {
    failures.push(`the session exited ${exit.code}.`);
  }

  return failures;
}

/**
 * The prompt.
 *
 * Both halves are named and neither is inferred. The skill is named so it is invoked by
 * name rather than matched from its description — selecting a skill from its description is
 * a judgment, and judgment about what to run belongs to the dispatch decision, not to a
 * session nobody is watching.
 *
 * Naming the task is the half that interacts with the session being non-interactive under
 * `-p`. A stage takes its task given or inferred, asks when that is unclear, and stops when it
 * can neither identify one nor ask — and a dispatched run has no asking branch. A session
 * launched with a bare skill name would therefore refuse to act, correctly, spending a
 * dispatch and presenting from outside as a stage failure.
 *
 * `-p` is the part of that which no configuration reaches: it is what makes an answer
 * impossible, whatever else the invocation carries. `--permission-prompts none` sits beside
 * it rather than in place of it, withholding the tools that ask a person instead of leaving
 * them present with nobody to answer — so a session that would go looking for the asking
 * branch does not hold one to reach for. Neither leaves a case in which the task may go
 * unnamed.
 */
export function prompt(request: RunRequest): string {
  return `/${request.skill} ${request.task}`;
}

/** The tracker server, as the session is handed it. */
function mcpConfig(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [TRACKER_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
    },
  });
}

/**
 * The script `GIT_ASKPASS` points at, so the token answers git's prompt out of the
 * environment rather than out of a command line.
 *
 * `cli/AGENTS.md` states the rule as the justification for writing the tracker payload to a
 * file: a command line is readable by every process on the host. An installation token
 * spliced into a clone URL breaks exactly that rule, on the same host, and argv is the worse
 * of the two hiding places — `/proc/<pid>/cmdline` is world-readable where
 * `/proc/<pid>/environ` is owner-only.
 *
 * The script itself holds no secret: it echoes `GH_TOKEN`, which the session's environment
 * already carries for `gh`. That is what lets the session push through the same clone after
 * the run has configured it — the remote URL names the username and nothing else, and the
 * credential is supplied at each use and goes with the run.
 *
 * The username branch is unreachable while the URL names `x-access-token`, and is here so
 * that a URL which stops naming it fails at the clone rather than by prompting into a stdin
 * nobody is attached to.
 */
const ASKPASS = `#!/bin/sh
case "$1" in
Username*) printf '%s' 'x-access-token' ;;
*) printf '%s' "$GH_TOKEN" ;;
esac
`;

/**
 * The `openspec` wrapper the run puts in front of the session, in two places for two
 * callers.
 *
 * The session runs in a bare clone the pipeline never installs dependencies into, so
 * neither `openspec` nor `npx openspec` resolves on its own. Every stage runs `openspec`,
 * so without this the pipeline cannot start. The two invocations reach a command by
 * different routes, and neither route is `PATH` alone:
 *
 *   - `openspec …` resolves off `PATH` — a global install of jen links jen's own bin and
 *     never a dependency's — so the shim goes in a `bin/` that {@link childEnvironment}
 *     prepends to it.
 *   - `npx openspec …` never consults `PATH`. `npm exec` walks up from the cwd for a
 *     `node_modules/.bin/<name>`, then checks jen's global bin, then reaches the registry —
 *     for the unscoped `openspec`, not jen's `@fission-ai/openspec`. So a second copy goes
 *     in a `node_modules/.bin/` above the clone, where that walk-up lands first.
 *
 * Both interpolated paths are jen's own — the `node` running the runner and the entrypoint
 * {@link openspecBin} resolves from jen's dependency tree — so the wrapper runs the exact
 * OpenSpec version jen depends on, with no install, fetch, or pin of its own. They are
 * interpolated at write time rather than passed through the environment: a `JEN_*` name
 * would be stripped by {@link childEnvironment}, and a non-namespaced one is avoidable.
 * Same shape and lifetime as {@link ASKPASS} — written into the run directory, swept with
 * it.
 */
function openspecShim(node: string, bin: string): string {
  return `#!/bin/sh
exec "${node}" "${bin}" "$@"
`;
}

/** What the operator declared about which variables belong to which stage. */
interface Declarations {
  /** Per declaration variable — `JEN_ENV_TEST_TASK` — the variable names it claims. */
  byStage: Map<string, Set<string>>;
  /** Declarations naming something that is not a stage, under the names they were written. */
  unrecognized: string[];
}

/**
 * Every `JEN_ENV_<STAGE>` declaration the runner holds, read whole.
 *
 * *Every* stage's, not the running one's, and that is the part which reads like a bug until
 * the withholding case is in mind: to hand `STAGING_SSH_KEY` to `test-task` a run needs
 * `JEN_ENV_TEST_TASK`, but to keep it from `deliver-task` that run must read
 * `JEN_ENV_TEST_TASK` too — otherwise it has no way to know the name was spoken for.
 *
 * A value is a list of variable *names*, never values: comma-separated, entries trimmed,
 * empty entries dropped, so `A, B` and `A,B` are one declaration. Names are compared
 * case-sensitively because POSIX environment variables are — folding case would claim `Path`
 * where the operator wrote `PATH`, and withhold something they never named.
 */
function declarations(base: Environment): Declarations {
  const known = new Set(STAGES.map((stage) => VARIABLES.stageScope(stage.skill)));
  const byStage = new Map<string, Set<string>>();
  const unrecognized: string[] = [];

  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith(STAGE_SCOPE)) continue;
    // Discarded rather than parsed. `JEN_ENV_TEST` — the plausible misspelling — would
    // otherwise claim its names for a stage no request ever runs, so they would be withheld
    // from every stage and the variable would vanish everywhere. See the note it earns below.
    if (!known.has(key)) {
      unrecognized.push(key);
      continue;
    }
    const names = byStage.get(key) ?? new Set<string>();
    for (const name of (value ?? '').split(',')) {
      const trimmed = name.trim();
      if (trimmed !== '') names.add(trimmed);
    }
    byStage.set(key, names);
  }

  return { byStage, unrecognized };
}

/**
 * The child's environment: what the project's own commands need, this run's role, and
 * nothing of another's.
 *
 * Five things happen to the runner's environment on the way in.
 *
 * **It is inherited.** A project's checks read configuration jen cannot enumerate — the
 * database a suite connects to, the endpoint an integration test reaches — and
 * `stage-execution` requires those variables arrive with the commands that read them. The
 * set is deliberately not inverted into an allow list of names jen can think of: no such
 * list is complete for an arbitrary toolchain, and every name missed would surface as a
 * stage failing at the first command that needed it, mid-run, with nobody watching.
 *
 * **Everything in jen's own namespace is stripped**, rather than the role credentials being
 * filtered down to the running role's. `pipeline-identity` requires that a session cannot
 * obtain another role's credentials, and a runner configured for all three roles holds all
 * three private keys. The session needs none of them: it acts through the minted token,
 * already scoped to its own installation and expiring on its own. Stripping the whole
 * namespace rather than `JEN_GH_` alone also takes the runner's own configuration out, which
 * nothing inside a session reads.
 *
 * **A name another stage claimed is withheld.** This is the lever the spec requires, and it
 * keys on the stage rather than the role — reviewing, testing, and delivering all act as
 * `deliver`, so a role-keyed rule would hand the stage that merges what was meant for the
 * stage that tests. A name claimed by two stages reaches both, which falls out of set
 * membership rather than needing a rule of its own.
 *
 * **The model credential goes in under the name the run holds it as, and every other name it
 * could have been supplied under comes out.** Unlike the rest of jen's own values, this one's
 * *name* varies, so a session that could see both spellings would leave the choice of which to
 * spend to the CLI's precedence — the ambiguity `credentialsFor` refuses upstream.
 *
 * The delete is not defensive. It fires on every tick of a runner that passes each accepted
 * name through unconditionally — which is what a job scheduler's environment block does, and
 * what an adopter driving the tick from one will have written — so the name an
 * adopter never stored arrives as an empty string, `credentialsFor` reads empty as absent and
 * refuses nothing, and the copy loop above filters on nothing — so without this line the unheld
 * name would reach the child as `''`, handing the CLI the empty-versus-unset judgment the
 * refusal exists to take away from it. What the upstream refusal does make unreachable is
 * narrower: a *non-empty* inherited value under the unheld name. That case is kept covered
 * anyway, asserted directly against a constructed environment, so this unit's contract holds on
 * its own terms rather than by its caller's grace.
 *
 * **The run's own `bin/` is prepended to `PATH`.** It holds the `openspec` shim
 * ({@link openspecShim}); the session runs in a bare clone with no `node_modules` and a
 * global install of jen links jen's bin alone, so this is the only way `openspec` resolves.
 * Prepended so it wins, and it stands in for `PATH` entirely where the runner holds none —
 * which is the closed-environment case the tests construct.
 *
 * Notes come back beside the environment rather than being thrown or logged: a declaration
 * that scoped nothing is worth telling the operator about and is not worth stopping a
 * pipeline over, and {@link RunOutcome.notes} is the channel that can say so without failing
 * the run the way a `failures` entry would.
 */
export function childEnvironment(
  base: Environment,
  skill: string,
  credentials: Credentials,
  token: string,
  configDir: string,
  askpass: string,
  binDir: string,
): { env: NodeJS.ProcessEnv; notes: string[] } {
  const { byStage, unrecognized } = declarations(base);
  const mine = byStage.get(VARIABLES.stageScope(skill)) ?? new Set<string>();
  const claimed = new Set([...byStage.values()].flatMap((names) => [...names]));

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith(NAMESPACE)) continue;
    if (claimed.has(key) && !mine.has(key)) continue;
    env[key] = value;
  }

  // Assigned after the copy, so jen's own win over anything inherited and anything withheld.
  // An operator who lists one of these in a declaration has written something inert, and that
  // earns no note: the channel is for a declaration that changed something silently, and this
  // one changes nothing at all.
  env.CLAUDE_CONFIG_DIR = configDir;
  // The one of jen's own values whose *name* varies, so the others cannot be read for it.
  env[credentials.model.variable] = credentials.model.value;
  for (const name of VARIABLES.model) if (name !== credentials.model.variable) delete env[name];
  env.LINEAR_API_KEY = credentials.trackerToken;
  // What `gh` reads. The stage conventions put every pull-request act through it.
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  // What `git push` reads, through the script above. Without these the session would have a
  // clone it cannot push, since the remote URL deliberately carries no credential.
  env.GIT_ASKPASS = askpass;
  env.GIT_TERMINAL_PROMPT = '0';
  // Prepended, so the shim wins over anything the inherit loop copied; and the whole of
  // `PATH` where the runner carried none, which is the closed-environment case.
  env.PATH = env.PATH ? binDir + delimiter + env.PATH : binDir;

  return { env, notes: [...unrecognized.map(unknownStage), ...unheld(byStage, base)] };
}

/**
 * A declaration naming a stage that does not exist.
 *
 * Fails open, and this is the one place in the scoping that does. Fail-closed reasoning says
 * the operator was restricting a secret and ignoring their misspelling sends it everywhere —
 * the outcome they were preventing. Against that: it sends it exactly where it goes today,
 * so no protection that was ever in force is lost, while withholding it instead manufactures
 * a variable missing at the moment a stage reaches for it, unattended, which is the failure
 * the inheritance exists to refuse. The note is what makes that defensible rather than merely
 * convenient — the operator is told, by name, that their declaration did nothing.
 */
function unknownStage(declaration: string): string {
  const valid = STAGES.map((stage) => VARIABLES.stageScope(stage.skill)).join(', ');
  return `${declaration} names no stage, so it scoped nothing and the variables it named reached every stage. The declarations jen reads are: ${valid}.`;
}

/** Declarations restricting a variable the runner does not hold, which withhold nothing. */
function unheld(byStage: Map<string, Set<string>>, base: Environment): string[] {
  const notes: string[] = [];
  for (const [declaration, names] of byStage) {
    for (const name of names) {
      if (base[name] === undefined) {
        notes.push(`${declaration} restricts ${name}, which the runner does not hold, so nothing was withheld by it.`);
      }
    }
  }
  return notes;
}

/** Anything a path can hold, from a value that arrived in a run request. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

class ExecError extends Error {}

/**
 * The executor.
 *
 * One instance per command invocation, holding the children it started so a termination can
 * reach them. Each run's directory is removed in its own `finally`, so cleanup happens once,
 * in one place, on every exit path — success, failure, and termination alike.
 */
export class Executor {
  readonly #options: ExecOptions;
  readonly #env: Environment;
  readonly #live = new Set<Child>();
  #terminating = false;

  constructor(options: ExecOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
  }

  /** Whether a termination has been signalled. Read by the command for its exit code. */
  get terminating(): boolean {
    return this.#terminating;
  }

  /**
   * Stop every session this executor started.
   *
   * SIGTERM is ordinary operation rather than a crash path: a stopping runner produces it,
   * and so does whatever supervises the process an adopter drives the tick from. Claude Code aborts the in-progress turn, kills
   * the Bash process tree, runs its `SessionEnd` hooks, and exits 143 — so the run waits for
   * that rather than killing harder, and each run's own `finally` removes its directory.
   *
   * Nothing is written to the tracker for a session that was stopped. The task keeps the
   * announcement its session wrote and no closing outcome, which every later tick reads as
   * in flight until a person moves it. Closing it on the session's behalf would restore the
   * loop ENG-163 removed, and would put a tracker write outside a stage session.
   */
  terminate(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.#terminating = true;
    for (const child of this.#live) child.kill(signal);
  }

  launch = async (request: RunRequest): Promise<RunOutcome> => {
    const role = request.role as Role;
    const base: RunOutcome = {
      task: request.task,
      skill: request.skill,
      role,
      transcript: '',
      ok: false,
      failures: [],
      notes: [],
      terminated: false,
      sessionStarted: false,
    };

    let directory: string | undefined;
    let sessionStarted = false;
    let outcome: RunOutcome;
    try {
      const credentials = credentialsFor(role, this.#env);
      const github = this.#options.github ?? new GitHub();
      const installation = await github.installation(credentials);

      directory = await mkdtemp(join(this.#options.root ?? tmpdir(), 'jen-run-'));
      // Resolved, and this matters rather than being tidiness. The trust entry below is
      // keyed by absolute path and the session looks itself up by the path it resolves to —
      // and on macOS the system temporary directory is a symlink, so `/var/folders/…` and
      // `/private/var/folders/…` are the same directory under two names. Writing the entry
      // under the unresolved one means the lookup misses, the workspace reads as untrusted,
      // and the permissions are silently inert: precisely the failure this module exists to
      // prevent, arrived at by a route that looks like it cannot happen.
      directory = await realpath(directory);
      const repo = join(directory, 'repo');
      const config = join(directory, 'config');
      await mkdir(config, { recursive: true });

      const { script, env: gitEnv } = await this.#askpass(config, installation.token);
      await this.#clone(repo, request.branch, credentials, gitEnv);
      await this.#configureIdentity(repo, installation.login, installation.email);
      await this.#trust(config, repo);

      const mcp = join(config, 'mcp.json');
      // Written to a file rather than passed inline, because a command line is readable by
      // every process on the host and this string carries the tracker credential. The file
      // goes with the directory when the run ends.
      await writeFile(mcp, mcpConfig(this.#options.trackerMcpUrl ?? TRACKER_MCP_URL, credentials.trackerToken), {
        mode: 0o600,
      });

      const bin = await this.#openspecShim(directory);
      const { child, notes } = this.#session(repo, config, mcp, request, credentials, installation.token, script, bin);
      sessionStarted = true;
      const exit = await child.exited;
      const report = readStream(exit.stdout);
      const failures = verdict(report, exit, exit.stderr);

      outcome = {
        ...base,
        ok: failures.length === 0,
        failures,
        notes,
        cost: report.cost,
        sessionId: report.sessionId,
        transcript: exit.stdout,
        sessionStarted,
        // A stop that arrived after the session had already finished cut nothing short. Read
        // straight off the flag, this line called a completed successful run `terminated`,
        // and `see()` then described a task as left mid-stage when it was not.
        //
        // A run that was failing anyway when the stop arrived is reported as stopped, which
        // is the direction to be imprecise in: it says the task may have been left partway,
        // and the failures beside it say what went wrong either way.
        terminated: this.#terminating && failures.length > 0,
      };
    } catch (error) {
      outcome = {
        ...base,
        failures: [error instanceof Error ? error.message : String(error)],
        sessionStarted,
        terminated: this.#terminating,
      };
    }

    // The transcript is written before the sweep and outside the run's directory, so it
    // outlives the credentials that directory held. A failure to keep one is added to the
    // run's failures and changes nothing else: the session's own result is what the report
    // exists to carry, and a run that succeeded did not stop succeeding because a file
    // could not be written beside it.
    const kept = await this.#keep(outcome);
    if (kept.path !== undefined) outcome = { ...outcome, transcriptPath: kept.path };
    if (kept.failure !== undefined) outcome = { ...outcome, failures: [...outcome.failures, kept.failure] };

    // Cleanup is the whole of how `stage-execution`'s "no credential remains on the host" is
    // satisfied — `config/mcp.json` holds the tracker's, live until someone rotates it — so
    // the one case that violates the requirement must not also be the one case nothing
    // reports. It is added to the failures rather than raised over them, so a cleanup that
    // failed never masks what the session itself did.
    const left = await this.#sweep(directory);
    return left ? { ...outcome, ok: false, failures: [...outcome.failures, left] } : outcome;
  };

  /**
   * Keep this session's transcript where the operator asked for one.
   *
   * Named for the task, the stage, and the moment, so a directory of them reads in order
   * and two runs of the same stage against the same task never land on one file. Every
   * component is reduced to characters a path can hold, because the task identifier and the
   * skill name both arrive from a run request rather than from this module.
   *
   * **Nothing means no file, not an empty one.** A session that started and then failed
   * before producing a line — a `claude` that isn't on `PATH` is the one an operator hits
   * first — reaches here with `sessionStarted` set and no stream, and writing that would
   * put a zero-byte path into the run record. The record says a transcript was kept and
   * reading it says nothing about why, which is strictly worse than the `null` the same
   * run carries otherwise. A session that never started has no transcript either, so
   * asking about the stream answers both questions.
   */
  async #keep(outcome: RunOutcome): Promise<{ path?: string; failure?: string }> {
    const directory = this.#options.transcripts;
    if (!directory || !outcome.transcript) return {};

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(directory, `${[outcome.task, outcome.skill, stamp].map(safeName).join('-')}.jsonl`);

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, outcome.transcript, { mode: 0o600 });
      return { path };
    } catch (error) {
      return {
        failure:
          `this session's transcript could not be written to ${path}, and was discarded with the run: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Remove the run's directory. Returns what to report where it could not be removed. */
  async #sweep(directory: string | undefined): Promise<string | undefined> {
    if (!directory || this.#options.keepDirectory) return undefined;
    try {
      await rm(directory, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      return (
        `the run directory could not be removed and is still on the host at ${directory}, ` +
        `holding this run's tracker credential: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Start a child, or refuse because the runner has been stopped.
   *
   * `terminate()` reaches only what is already running, so without this a signal landing
   * between two steps — most of all during the minting, where no child exists at all — left
   * the run to clone, configure, and start a full session after it had been told to stop. A
   * stage would then write to the tracker and push commits past its own cancellation, and
   * the outcome would report a session that ran to the end as one that was stopped.
   *
   * Refusing by throwing rather than by returning something empty puts this on the path the
   * `catch` above already handles, and leaves the sweep to run exactly as it does for a run
   * that ends any other way.
   */
  #spawn(spec: CommandSpec): Child {
    if (this.#terminating) {
      throw new ExecError('the runner was stopped before this run could start its session.');
    }
    const child = (this.#options.spawn ?? spawner)(spec);
    this.#live.add(child);
    child.exited.finally(() => this.#live.delete(child)).catch(() => {});
    return child;
  }

  async #run(spec: CommandSpec, what: string): Promise<Exit> {
    const exit = await this.#spawn(spec).exited;
    if (exit.code !== 0) {
      throw new ExecError(`${what} failed (${exit.signal ?? `exit ${exit.code}`}): ${exit.stderr.trim().slice(0, 500)}`);
    }
    return exit;
  }

  /**
   * Clone, then place the branch.
   *
   * `git clone --branch <branch>` cannot be used, and this is not a stylistic point:
   * `design-task` runs against a branch that does not exist yet. The request carries the
   * tracker's *suggested* branch name, and design is the stage that first creates and pushes
   * it — so a clone insisting on the branch would fail every design dispatch, which is the
   * pipeline's entry point, before the session could report anything useful.
   *
   * The branch is placed and nothing more. Pushing belongs to the stage; a branch pushed by
   * the executor is a branch with no commit explaining it.
   *
   * Full rather than shallow. Stages read history — the resume convention checks commits
   * against completion markers, and `openspec archive` and delivery both work over more than
   * one commit — so the cost on a large repository is accepted rather than solved.
   *
   * **Which of the two it is, is asked of the clone and not of an exit code.** This ran
   * `git fetch origin <branch>` and read a non-zero exit as "the remote carries no such
   * branch" until review caught it: a missing ref and an unreachable remote both exit 128,
   * so any transport or auth failure fell through to `--create` and handed the session a
   * branch cut from the default branch with none of the task's history on it. The resume
   * convention then amplifies it rather than catching it — a stage takes the commits on the
   * branch as evidence over any marker, so it reads the task as untouched, redoes the work,
   * writes to the tracker, and moves the status, and the only thing that fails is the push
   * at the end. A full clone already carries every head, so `origin/<branch>` settles it
   * against the clone, where a missing ref exits 1 and a repo-level failure exits 128 and
   * the two are separable.
   *
   * The explicit local branch off the remote-tracking ref also sets the upstream, which
   * `--force-create <branch> FETCH_HEAD` does not — without it every resumed branch made the
   * session's own `git push` fail with *has no upstream branch*. Both the start point and
   * `--track` are named because the operator's global `checkout.guess` and
   * `branch.autoSetupMerge` settings are allowed to differ from git's defaults.
   */
  async #clone(repo: string, branch: string, credentials: Credentials, git: NodeJS.ProcessEnv): Promise<void> {
    const url = (this.#options.remote ?? remoteUrl)(credentials.repo);
    await this.#run({ command: 'git', args: ['clone', url, repo], env: git }, 'cloning the repository');

    const known = await this.#spawn({
      command: 'git',
      args: ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      cwd: repo,
    }).exited;

    if (known.code === 0) {
      await this.#run(
        { command: 'git', args: ['switch', '--create', branch, '--track', `origin/${branch}`], cwd: repo },
        `switching to ${branch}`,
      );
      return;
    }

    // Only `1` means the ref is absent. Anything else is the repository itself failing to
    // answer, and inferring "the remote has no such branch" from that is the mistake above.
    if (known.code !== 1) {
      throw new ExecError(
        `looking for ${branch} failed (${known.signal ?? `exit ${known.code}`}): ${known.stderr.trim().slice(0, 500)}`,
      );
    }

    await this.#run({ command: 'git', args: ['switch', '--create', branch], cwd: repo }, `creating ${branch}`);
  }

  /**
   * Write the askpass script, and the environment the run's own `git` calls answer through.
   *
   * Layered over `process.env` rather than over the executor's injected environment, because
   * these are the runner's own git invocations: they need its `PATH`, its `HOME`, and
   * whatever else git reaches for. Only the two credential-bearing variables are added.
   */
  async #askpass(config: string, token: string): Promise<{ script: string; env: NodeJS.ProcessEnv }> {
    const script = join(config, 'askpass.sh');
    await writeFile(script, ASKPASS, { mode: 0o700 });
    return {
      script,
      env: { ...process.env, GH_TOKEN: token, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: '0' },
    };
  }

  /**
   * Write the `openspec` shim in both places the session reaches it from, and return the
   * directory to prepend to `PATH`.
   *
   * `bin/` is a sibling of `repo/` and `config/` — neither the clone's content nor Claude's
   * config store — and a directory of its own keeps `PATH` pointed at exactly the one
   * wrapper jen owns. `node_modules/.bin/` sits beside it, above the clone, so `npm exec`'s
   * walk-up from the session cwd finds the same wrapper for `npx openspec` — which never
   * looks at `PATH`. Mode `0755` — the shim is executed, not sourced — and it holds no
   * secret, only two of jen's own absolute paths. Both go with the run directory.
   */
  async #openspecShim(directory: string): Promise<string> {
    const shim = openspecShim(process.execPath, openspecBin());
    const bin = join(directory, 'bin');
    const nodeBin = join(directory, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    await mkdir(nodeBin, { recursive: true });
    await writeFile(join(bin, 'openspec'), shim, { mode: 0o755 });
    await writeFile(join(nodeBin, 'openspec'), shim, { mode: 0o755 });
    return bin;
  }

  /**
   * The identity the clone's commits carry.
   *
   * The token governs what the run may *do*; the git config governs what the history *says*
   * it was, and they have to be set together. Without this, commits carry whatever identity
   * the host has configured — a person's, on a runner started from their own machine — and
   * the attribution `pipeline-identity` builds its audit story on silently stops being true.
   */
  async #configureIdentity(repo: string, login: string, email: string): Promise<void> {
    await this.#run({ command: 'git', args: ['config', 'user.name', login], cwd: repo }, 'setting the commit name');
    await this.#run({ command: 'git', args: ['config', 'user.email', email], cwd: repo }, 'setting the commit email');
  }

  /**
   * Establish workspace trust for this clone, in a store the run throws away.
   *
   * The finding this task was opened for: `-p`'s own help says the trust dialog is skipped
   * in non-interactive mode, which reads like a dispatched run is exempt. It is not. An
   * untrusted clone runs as though `.claude/settings.json` were empty — and since every run
   * clones to a path nothing has ever trusted, that lands on every run rather than a first.
   *
   * `CLAUDE_CONFIG_DIR` rather than `HOME`, which was the other verified route: `HOME`
   * relocates git's config, ssh's known-hosts, npm's cache, and anything else a stage's own
   * build reaches for, where this moves exactly the one store that needs moving. And rather
   * than `--settings`, which would clear the gate but leave the project's own file inert —
   * so a project could never grant its runs a command jen does not ship, and jen cannot know
   * a project's typecheck, build, or test commands.
   */
  async #trust(config: string, repo: string): Promise<void> {
    const store = { projects: { [repo]: { hasTrustDialogAccepted: true } } };
    await writeFile(join(config, '.claude.json'), JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  /**
   * The session. The prompt goes last — a variadic flag placed before it consumes it.
   *
   * The running child is handed back rather than awaited here, so the caller can record that
   * the session started at the moment it did. `#spawn` can refuse, and a flag set before the
   * call would then claim a session that never existed.
   *
   * The environment's notes come back with it, because this is where the environment is
   * built and `launch` is where the outcome carrying them is assembled.
   */
  #session(
    repo: string,
    config: string,
    mcp: string,
    request: RunRequest,
    credentials: Credentials,
    token: string,
    askpass: string,
    binDir: string,
  ): { child: Child; notes: string[] } {
    const [command, ...leading] = this.#options.claude ?? ['claude'];
    const { env, notes } = childEnvironment(this.#env, request.skill, credentials, token, config, askpass, binDir);
    const child = this.#spawn({
      command: command!,
      args: [
        ...leading,
        '--permission-mode',
        'auto',
        '--permission-prompts',
        'none',
        '--output-format',
        'stream-json',
        '--verbose',
        '--mcp-config',
        mcp,
        '-p',
        prompt(request),
      ],
      cwd: repo,
      env,
    });
    return { child, notes };
  }
}

/** The launcher `cli.ts` hands the tick, and the executor it belongs to. */
export function executor(options: ExecOptions = {}): Executor {
  return new Executor(options);
}
