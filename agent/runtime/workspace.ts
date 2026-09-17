/**
 * The two capabilities an agent *holds* rather than asks for: files under its own
 * workspace, and a program run as a child of its own runtime.
 *
 * **They are ordinary capabilities and that is the whole design.** `supervised.ts` turns a
 * declaration into something that writes a line to the supervisor and waits; this file
 * turns one into something that does the work here, in this process, inside this agent's
 * container. `dispatch` cannot tell the two apart, the loop has no branch for either, and
 * the transcript records both the same way — which is the property `capability.ts` was
 * written to hold, and the reason adding local work required no change to any of them.
 *
 * Routing this through the supervisor instead would add a request, a correlation and an
 * authority boundary to work already inside the agent's own container, and would make the
 * supervisor the bottleneck for every file an agent reads.
 *
 * **Nothing here knows what a coding assistant is**, and that is deliberate rather than
 * incidental. An assistant is a program in the image; `exec` runs programs. There is no
 * assistant field, no assistant branch, and no assistant name anywhere in the substrate —
 * what there is instead is guidance in the descriptions below, and a transcript that
 * records the `argv` an agent chose, so which assistant ran is recoverable afterwards.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants, lstat, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, resolve as resolvePath, sep } from 'node:path';

import type { AgentRecord } from '../record.ts';
import type { Capability, CapabilityResult } from './capability.ts';

/**
 * The most bytes any result from either capability may carry.
 *
 * **Sized against context rather than against memory.** `index.ts` projects the entire
 * event log into every request and nothing compacts it, so a tool result is not paid once:
 * it is re-sent on every later model call for the rest of that agent's life, persisted in
 * the log, and replayed on every resume. A cap set where a runaway process merely stops
 * short of exhausting memory — megabytes — would still let one verbose command occupy an
 * agent's context permanently.
 *
 * 16 KiB is roughly four thousand tokens. It sits well above everything routine: a
 * `git status`, a `git diff --stat`, a directory listing, a source file, and the single
 * object a headless assistant prints as its result all arrive whole and untouched. It sits
 * well below a test run, a verbose build, or a dependency install, which is exactly where
 * an agent should be narrowing its output before running rather than after.
 *
 * It is a constant because it is a property of the substrate's context handling, not a
 * judgment about one command. Neither a call nor a record can name it.
 */
export const OUTPUT_LIMIT = 16 * 1024;

/**
 * How long a command may run before it is ended.
 *
 * **This is a liveness guarantee and the only one there is.** The supervisor arms a
 * residency timer at `#turn` and `#awaiting` — both states an agent reaches by *finishing*
 * something. A body blocked inside `dispatch` is `working` and has no timer at all, and the
 * loop awaits each call in turn, so a command that never returns is an agent that never
 * returns. Nothing else in the substrate would ever end it.
 *
 * Thirty minutes, because the bound has to sit comfortably above the longest thing an agent
 * legitimately runs — a substantial headless assistant session on a real task, a full test
 * suite, a cold dependency install — and the cost of being generous is wall-clock on an
 * otherwise idle container. The cost of being tight is killing real work.
 *
 * It bounds *elapsed time* rather than silence, because only elapsed time is complete. A
 * silence bound catches a wedged process sooner and misses the case this exists for: a
 * command that trickles output forever and never finishes. {@link OUTPUT_LIMIT} already
 * ends one that floods, so what is left is exactly the quiet hang.
 *
 * **It is not the agent's to name**, which is where it parts from `await`'s `keep`.
 * Residency is a cost-against-latency trade only the agent can weigh; a deadline is a
 * guarantee the substrate owes whatever the agent believes, and an agent that can set it
 * can disable it.
 */
export const DEADLINE = 30 * 60 * 1000;

/** How long a terminated command has to exit before it is killed outright. */
export const GRACE = 2_000;

/**
 * The bounds, as the tests are allowed to see them.
 *
 * A test cannot wait thirty minutes to prove the deadline works, and a test that wrote
 * 16 KiB to prove the cap works would be slow for nothing. **This is the only way either
 * number can differ from the constants above**, it is a parameter of the factory rather
 * than of a call, and no record or model input reaches it — so the agent still cannot name
 * either one, which is the requirement.
 */
export interface Bounds {
  limit?: number;
  deadline?: number;
  grace?: number;
}

/**
 * The local capabilities this record's agent may be offered.
 *
 * Offered, not granted: `resolveCapabilities` selects from this by the record's `tools`
 * exactly as it selects from the supervised declarations, so a record naming `fs` and not
 * `exec` gets `fs` alone, and one naming neither gets neither.
 *
 * It takes the record because `fs` needs the workspace and both need it to be *this*
 * agent's.
 */
export function local(record: AgentRecord, bounds: Bounds = {}): Capability[] {
  const limit = bounds.limit ?? OUTPUT_LIMIT;
  const deadline = bounds.deadline ?? DEADLINE;
  const grace = bounds.grace ?? GRACE;
  return [fs(record, limit), exec(record, limit, deadline, grace)];
}

/**
 * What an agent's constructor is expected to say about its image, and nowhere else to say it.
 *
 * **A template for the caller, not a hidden instruction.** Nothing here applies it: the
 * runtime reads `record.charter` and sends it as written, so whatever this says reaches an
 * agent only because a person or a parent chose to put it there. That is the line the
 * guidance has to stay on — a capability that silently prepended its own paragraph to every
 * charter would be a system prompt the record cannot see and a parent cannot narrow.
 *
 * It exists because two facts an agent cannot discover for itself belong in its charter and
 * would otherwise be discovered by failing: which assistant its image actually holds, and
 * which credentials its environment supplies. `exec`'s description tells it to check rather
 * than assume; this is where the answer goes.
 *
 * The `{...}` are the caller's to fill in or delete, and every one of them is a placeholder
 * rather than an example. Writing a real command or a real credential variable here — even
 * as an illustration — would put a particular assistant's name in the substrate, which is
 * the one thing this capability may not do; the caller knows which assistant its image
 * installs and this file must not. It is deliberately short — a charter is the first thing
 * in an agent's conversation and stays there for the whole of its life.
 */
export const WORKSPACE_CHARTER = `Your workspace is yours and it persists: what you write to it survives this container,
and it is the record of what you actually did.

Your image provides {the coding assistant command, or: no coding assistant}.
{Its credentials are already in your environment under {the variable it reads} — you
never supply one.} Check a command is there before you rely on it.

If a tool result ever says the call was interrupted, the command may already have done
its work. Look at the workspace before you run it again.`;

/**
 * A path a call named that the capability will not act on.
 *
 * Thrown internally and converted to a failed result at the boundary, so path handling can
 * read as a sequence of refusals rather than threading an outcome type through every step.
 * Nothing outside this file sees it.
 */
class Refused extends Error {}

/**
 * Where a call's path lands on disk, or a refusal.
 *
 * **Validated here rather than trusted from the schema.** The JSON Schema beside each
 * capability is a guide to the model — nothing checks a call's arguments against it before
 * `invoke` sees them, so a declared `type: string` does not stand between a model and a
 * number, and a description saying "relative to your workspace" does not stand between one
 * and `/etc/shadow`.
 *
 * Three refusals, and the third is the one that needs the filesystem: an absolute path, a
 * path with a `..` segment, and a path that resolves through a symbolic link to somewhere
 * outside the workspace. The first two are lexical and refuse even where they would have
 * landed back inside, because a rule with an exception is a rule nobody can check. The
 * third is why `realpath` is involved at all.
 *
 * `existing` says which part of the path has to be there already: the whole of it for a
 * read or a listing, its parent for a write.
 */
async function place(workspace: string, path: unknown, existing: 'self' | 'parent'): Promise<string> {
  if (typeof path !== 'string' || path === '') {
    throw new Refused('"path" is missing or is not a string');
  }
  if (isAbsolute(path)) {
    throw new Refused(`"${path}" is absolute; paths are relative to your workspace, and "." is its root`);
  }
  if (normalize(path).split(sep).includes('..')) {
    throw new Refused(`"${path}" leads above your workspace, which is the whole of what you can reach`);
  }

  const root = await resolved(workspace, `your workspace (${workspace})`);
  const target = resolvePath(root, path);
  const anchor = existing === 'self' ? target : resolvePath(target, '..');
  // Named for what is actually missing. A write to `src/new/file.ts` where `new/` is not
  // there is a missing *directory*, and saying the file does not exist would send the agent
  // looking for the wrong thing — a write is allowed to create the file and is not allowed
  // to create the path to it.
  const real = await resolved(anchor, existing === 'self' ? `"${path}"` : `the directory holding "${path}"`);

  if (!within(root, real)) {
    throw new Refused(`"${path}" resolves to ${real}, which is outside your workspace`);
  }
  return existing === 'self' ? real : join(real, basename(target));
}

/** `realpath`, with a refusal in place of an exception. Says which link it could not follow. */
async function resolved(path: string, called: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (code(error) === 'ENOENT') throw new Refused(`${called} does not exist`);
    throw new Refused(`${called} could not be resolved: ${message(error)}`);
  }
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * List, read, write — and the reason the set stops there.
 *
 * **`fs` exists for writing.** Reading through `exec` is perfectly good: `cat` and `sed -n`
 * do it. Writing through `exec` is not, because the content has to be embedded in a
 * heredoc, and a file containing the delimiter, a `$` or a backtick either breaks the
 * command or is silently interpolated into something other than what the agent meant. That
 * is the ordinary way shell-based file writing fails, not an exotic one, and it is why
 * every mature coding assistant carries a write tool beside its shell. A tool taking the
 * content as a JSON string has none of it.
 *
 * Reading and listing come along because they are nearly free once the path handling above
 * exists, and because they behave better than their shell equivalents in two small ways: a
 * missing file is a clean failure rather than a message on stderr, and the result is cut at
 * the same place every other result is cut rather than by whatever the model piped it into.
 *
 * Patching, searching and bulk edits are deliberately absent. `exec` and the tools in the
 * image are what those are for, and building them here would make this an editor.
 *
 * **`fs` is not a narrower `exec`.** For an agent holding both, `exec` is the wider
 * authority and this path confinement constrains nothing. What `fs` gives that agent is a
 * write it does not have to quote.
 */
function fs(record: AgentRecord, limit: number): Capability {
  return {
    name: 'fs',
    description:
      'Read, list and write files in your workspace. Paths are relative to your workspace ' +
      'root, which is "."; an absolute path, a path above the root, and a path leading out ' +
      'through a symbolic link are all refused. ' +
      '`list` returns a directory\'s entries, one per line, with a trailing "/" on each ' +
      'directory. `read` returns a file\'s text. `write` replaces a whole file with the ' +
      'content you supply, stored exactly as you give it — this is the way to write a file ' +
      'whose content contains quotes, `$`, backticks or a heredoc delimiter, all of which ' +
      'would be mangled or would break the command if you wrote the file through a shell. ' +
      'A write needs its parent directory to exist; make one with `exec` if it does not. ' +
      'There is no patch, no search and no rename here: those are ordinary commands, and ' +
      '`exec` runs them. ' +
      `Results are cut off at ${limit} bytes, and a result that was cut says so; that is the ` +
      'same limit `exec` uses. A file bigger than that is read in pieces with `exec` — ' +
      '`sed -n` for a line range — rather than whole. ' +
      'Nothing here raises: a missing file, a refused path and an operating-system error ' +
      'all come back as a failed result saying what happened, and you carry on.',
    schema: {
      type: 'object',
      properties: {
        operation: {
          enum: ['list', 'read', 'write'],
          description: 'What to do: list a directory, read a file, or replace a file.',
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'The file or directory, relative to your workspace root. "." is the root itself.',
        },
        content: {
          type: 'string',
          description: 'For `write`: the file\'s entire new content, stored exactly as given.',
        },
      },
      required: ['operation', 'path'],
      additionalProperties: false,
    },
    async invoke(input) {
      const call = input as { operation?: unknown; path?: unknown; content?: unknown };
      try {
        switch (call.operation) {
          case 'list':
            return await list(record.workspace, call.path, limit);
          case 'read':
            return await read(record.workspace, call.path, limit);
          case 'write':
            return await write(record.workspace, call.path, call.content);
          default:
            return failed(
              `"operation" is missing or is not one of "list", "read", "write" (got ${JSON.stringify(call.operation)})`,
            );
        }
      } catch (error) {
        // Every failure this capability can produce is something the model can act on —
        // a path it should not have named, a file that is not there, a disk that is full.
        // `dispatch` would convert a throw anyway; converting it here is what lets the
        // message name the operation rather than name an exception.
        return failed(error instanceof Refused ? error.message : message(error));
      }
    },
  };
}

async function list(workspace: string, path: unknown, limit: number): Promise<CapabilityResult> {
  const target = await place(workspace, path, 'self');
  const entries = await readdir(target, { withFileTypes: true });
  const lines = entries
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort((a, b) => a.localeCompare(b));
  const { text, cut } = bound(Buffer.from(lines.length === 0 ? '(the directory is empty)' : lines.join('\n')), limit);
  return { ok: !cut, content: cut ? `${text}\n\n${cutOff(limit)}` : text };
}

/**
 * A file's text, up to the limit.
 *
 * Reads one byte past the limit rather than the whole file, so a result that is going to be
 * cut costs a buffer of the limit's size rather than a buffer of the file's — which matters
 * because "read the repository's lockfile" is a thing an agent will try.
 *
 * **`O_NONBLOCK` is on the open, because the open is the part that can hang.** Opening a
 * FIFO for reading waits for a writer to arrive, and a workspace is a directory its agent
 * can `mkfifo` into — so a plain `open` is a call that may never come back. Nothing in the
 * substrate would end it: {@link DEADLINE} is `exec`'s and bounds nothing here, and a body
 * inside `dispatch` is `working`, which is precisely the state the supervisor arms no timer
 * for. The turn would stop there and so would the agent. With the flag the open returns at
 * once whatever the path names, and on a regular file the flag does nothing whatsoever.
 *
 * Then the handle's own `stat` decides what was opened, rather than a `stat` of the path
 * taken before it: a check of the path establishes a fact about the path, while what gets
 * read is the open file description, so asking the thing that is already open leaves
 * nothing to be swapped in between. Anything that is not a regular file is refused — the
 * bound this capability owes is on its own elapsed time, and no other kind of file can
 * promise that.
 */
async function read(workspace: string, path: unknown, limit: number): Promise<CapabilityResult> {
  const target = await place(workspace, path, 'self');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Refused(`"${String(path)}" is ${unreadable(stats)}`);
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    const { text, cut } = bound(buffer.subarray(0, bytesRead), limit);
    return { ok: !cut, content: cut ? `${text}\n\n${cutOff(limit)}` : text };
  } finally {
    await handle.close();
  }
}

/**
 * What the path turned out to be, phrased so the refusal says where to go instead.
 *
 * A directory is the ordinary mistake and its answer is in this same capability. The rest
 * are refused because `read` cannot bound them: a pipe or a socket carries bytes when
 * something else decides to send them, which is a wait with no end of its own, and a device
 * is whatever its driver is. `exec` can read any of them, and says so here, because `exec`
 * is the one that holds a deadline.
 */
function unreadable(stats: Stats): string {
  if (stats.isDirectory()) return 'a directory; `list` is what reads one';
  if (stats.isFIFO()) {
    return 'a named pipe, and reading one waits for whoever writes it; read it with `exec`, which has a deadline';
  }
  if (stats.isSocket()) return 'a socket rather than a file; anything that talks to one belongs in `exec`';
  return 'not a regular file, and only a regular file can be read within a bound';
}

/**
 * Replace a file, whole, and leave no half-written one behind.
 *
 * Written to a temporary file in the same directory and renamed into place, because
 * `rename` within a filesystem is atomic: a write interrupted at any point leaves either
 * the previous file or the new one, never a truncated mixture of the two. The temporary
 * goes in the same directory rather than in a system temporary directory, since a rename
 * across filesystems is a copy and gives up the property this is for.
 *
 * An existing symbolic link at the target is refused rather than followed. Following one
 * would write wherever it points, which is a path check that validated one location and a
 * write that landed at another.
 */
async function write(workspace: string, path: unknown, content: unknown): Promise<CapabilityResult> {
  if (typeof content !== 'string') {
    throw new Refused('"content" is missing or is not a string; a write replaces the whole file');
  }
  const target = await place(workspace, path, 'parent');

  const existing = await lstat(target).catch((error) => {
    if (code(error) === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Refused(`"${String(path)}" is a symbolic link; writing through one would write somewhere else`);
  }
  if (existing?.isDirectory()) {
    throw new Refused(`"${String(path)}" is a directory`);
  }

  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true, content: `Wrote ${Buffer.byteLength(content)} bytes to ${String(path)}.` };
}

/**
 * Run a program, and come back with what it did.
 *
 * **No shell is interposed.** The argument vector names a program and its arguments, and
 * they reach it as written — an agent that wants shell interpretation passes `sh`, `-lc`
 * and its command, and says so in the transcript by doing it. That is the difference
 * between a metacharacter being data and a metacharacter being syntax, and it is decided by
 * the agent rather than by this file.
 *
 * **Credentials reach the child by inheritance and by nothing else.** The sandbox delivers
 * them on each process's standard input, where a prologue exports them before `exec`ing the
 * runtime — so they are already in this process's environment and an ordinary spawn carries
 * them down. Nothing is written to a file, placed in an argument, or stored in a record to
 * get them there. Supplying a prompt on `stdin` is part of the contract for the same
 * reason: it keeps a large or sensitive prompt out of `argv`, which every process on the
 * host can read.
 *
 * **`cwd` is a convenience, not a boundary.** It selects where the command starts; it does
 * not confine it. An agent granted `exec` can run anything its container can run, and the
 * container is the boundary — which is what a grant of `exec` has to be read as.
 */
function exec(record: AgentRecord, limit: number, deadline: number, grace: number): Capability {
  return {
    name: 'exec',
    description:
      'Run a program in your workspace and get back what it printed, how it ended, and ' +
      'nothing else. `argv` is the program and its arguments as a list — no shell is ' +
      'involved, so quotes, `*`, `|` and `>` in an argument reach the program as written ' +
      'rather than being interpreted. When you want a shell, ask for one: ' +
      '["sh", "-lc", "a | b > c"]. `stdin` is text handed to the command, after which its ' +
      'input ends. `cwd` is relative to your workspace and defaults to its root. ' +
      'The result carries standard output and standard error separately with the exit ' +
      'status, and a nonzero exit, a program that is not installed, or malformed arguments ' +
      'all come back as a failed result you can read and act on rather than stopping you. ' +
      // The part that has to carry real weight, because the capability deliberately
      // decides nothing about which output matters and a conservative cap makes that a
      // live choice on ordinary commands rather than a rare edge.
      'Mind what you ask for. Everything a result carries stays in your conversation and is ' +
      'sent again on every later step you take, so output is not a cost you pay once. ' +
      `Output is cut off at ${limit} bytes: you get the beginning, the result says it was ` +
      'cut, and the command is terminated there. The only way to see the rest is to run the ' +
      'whole thing again — which for a test suite or a build costs the entire run, and for ' +
      'anything that changes state may not be safe to repeat. So narrow it before you run ' +
      'it, not after: pipe through `grep` for the lines that matter, `tail` for a failure at ' +
      'the end, `head` for a cause at the start, or redirect to a file and read it back in ' +
      'pieces. Which end matters is yours to decide, because you chose the command — this ' +
      'returns the beginning and makes no guess. ' +
      `A command is given ${duration(deadline)}; past that it is ` +
      'terminated along with anything it started, and you get back whatever it had printed. ' +
      // Assistants, without a rule about when to use one. The transcript records the argv,
      // so the choice stays auditable without the code having an opinion.
      'Your image may have a headless coding assistant installed, which can be worth running ' +
      'for substantial work rather than doing it step by step yourself. Check that the ' +
      'command is there before relying on it — which assistant, if any, is the image\'s ' +
      'choice, not something you can assume — and prefer an invocation whose output is ' +
      'already small: an assistant\'s single-object result form carries its closing summary ' +
      'and its usage and fits easily, while its event stream does not. It authenticates from ' +
      'the environment you already have; you never see or supply a credential. Afterwards, ' +
      'find out what actually changed from the workspace itself — `git diff --stat` — rather ' +
      'than from anything the assistant said about its own work. ' +
      'If a result ever comes back saying the call was interrupted, look at the workspace ' +
      'before running it again: the command may have already done what it was going to do.',
    schema: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'The program and its arguments. The first entry is the program; no shell parses any of it.',
        },
        stdin: {
          type: 'string',
          description: 'Text to hand the command on its standard input. Its input ends after this.',
        },
        cwd: {
          type: 'string',
          description: 'Where to start, relative to your workspace root. Defaults to the root.',
        },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    async invoke(input, signal) {
      const call = input as { argv?: unknown; stdin?: unknown; cwd?: unknown };
      const argv = call.argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((entry) => typeof entry !== 'string')) {
        return failed('"argv" is missing or is not a non-empty array of strings');
      }
      if (call.stdin !== undefined && typeof call.stdin !== 'string') {
        return failed('"stdin" is not a string');
      }

      let cwd: string;
      try {
        cwd =
          call.cwd === undefined
            ? await resolved(record.workspace, `your workspace (${record.workspace})`)
            : await place(record.workspace, call.cwd, 'self');
      } catch (error) {
        return failed(error instanceof Refused ? error.message : message(error));
      }

      return run(argv as string[], call.stdin as string | undefined, cwd, signal, { limit, deadline, grace });
    },
  };
}

/** What ended a command, in the order that decides which the result leads with. */
type Ending =
  | { kind: 'exit'; status: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'start'; reason: string }
  | { kind: 'limit' }
  | { kind: 'deadline' }
  | { kind: 'aborted' };

async function run(
  argv: string[],
  stdin: string | undefined,
  cwd: string,
  signal: AbortSignal,
  bounds: { limit: number; deadline: number; grace: number },
): Promise<CapabilityResult> {
  const collected: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  let bytes = 0;
  let cut = false;

  // `detached` is what puts the child in a process group of its own, and the whole reason
  // it is here: an assistant — or a build, or a test runner — starts children, and
  // signalling the process we started leaves every one of them running. The group is what
  // can be signalled as a unit. Nothing else about being detached is wanted, and the child
  // is never unref'd, so this process still waits for it.
  const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let killing: NodeJS.Timeout | undefined;
  let terminated = 0;
  /**
   * End the command, and then end it for real.
   *
   * One path, reached by the cap, the deadline and an abort alike — those are three reasons
   * to stop a command, not three ways of stopping one. `SIGTERM` first so a program that
   * cleans up gets to, `SIGKILL` after the grace for one that ignores it, and the negated
   * pid both times so the signal reaches the group rather than the leader alone.
   */
  const terminate = (): void => {
    if (killing !== undefined || child.pid === undefined) return;
    terminated = Date.now();
    group('SIGTERM');
    killing = setTimeout(() => group('SIGKILL'), bounds.grace);
    killing.unref();
  };
  const group = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // The group is gone, or this platform would not take a negated pid. Either way the
      // direct child is the fallback, and a failure to signal something already dead is
      // not a failure of the call.
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  /**
   * Whether anything is still in the group. `signal 0` asks without sending anything.
   *
   * `EPERM` is a yes: something is there and is not ours to signal. Every other failure —
   * `ESRCH` for an empty group, or a platform that will not take a negated pid at all — is
   * taken as a no, because the alternative is waiting out the grace on every terminated
   * call for a group that cannot be probed.
   */
  const remaining = (): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return code(error) === 'EPERM';
    }
  };
  /**
   * Finish the escalation the child's own exit does not finish.
   *
   * **`close` is not the end of the group.** It says the process we spawned is gone and
   * says nothing about the children it started: a grandchild holding none of the child's
   * pipes lets `close` fire while it is still running, and one ignoring `SIGTERM` is still
   * running. Cancelling the pending `SIGKILL` there — the obvious thing to do once the
   * thing you were waiting on has closed — cancels the only signal that would ever have
   * reached it, and the result then claims a termination that did not happen.
   *
   * So the escalation outlives the child, and the call waits for it rather than leaving it
   * to a timer this process may exit before firing. An empty group costs nothing, which is
   * every command that ended on its own; only a group with something still in it pays what
   * is left of the grace.
   */
  const sweep = async (): Promise<void> => {
    if (killing === undefined) return;
    clearTimeout(killing);
    if (!remaining()) return;
    const left = bounds.grace - (Date.now() - terminated);
    if (left > 0) await new Promise<void>((done) => setTimeout(done, left));
    if (remaining()) group('SIGKILL');
  };

  const take = (stream: NodeJS.ReadableStream, into: 'stdout' | 'stderr'): void => {
    // A stream's own failure arrives as `error`, and an `error` with nothing listening is
    // an uncaught exception that ends this process — which here is the whole agent. The
    // command's exit is the authority on whether it worked; a broken pipe on the way is not
    // a second opinion.
    stream.on('error', () => {});
    stream.on('data', (chunk: Buffer) => {
      if (cut) return;
      const room = bounds.limit - bytes;
      if (chunk.length > room) {
        collected[into].push(chunk.subarray(0, room));
        bytes = bounds.limit;
        cut = true;
        terminate();
        return;
      }
      collected[into].push(chunk);
      bytes += chunk.length;
    });
  };
  take(child.stdout!, 'stdout');
  take(child.stderr!, 'stderr');

  // EPIPE here is ordinary: a command that exits without reading its input breaks this pipe
  // and that says nothing about whether the command worked. Swallowed for that reason and
  // for the one above — an unlistened `error` would end the agent.
  child.stdin!.on('error', () => {});
  child.stdin!.end(stdin ?? '');

  let ending: Ending | undefined;
  const settle = (what: Ending): void => {
    ending ??= what;
  };

  const timer = setTimeout(() => {
    settle({ kind: 'deadline' });
    terminate();
  }, bounds.deadline);
  timer.unref();

  const abort = (): void => {
    settle({ kind: 'aborted' });
    terminate();
  };
  signal.addEventListener('abort', abort);

  try {
    const closed = await new Promise<Ending>((resolve) => {
      // A program that is not installed fails here rather than exiting, and `close` may
      // never arrive after it — so this resolves on its own rather than waiting for one.
      child.on('error', (error) => resolve({ kind: 'start', reason: error.message }));
      child.on('close', (status, sig) =>
        resolve(sig !== null ? { kind: 'signal', signal: sig } : { kind: 'exit', status: status ?? 0 }),
      );
    });
    // Whichever bound fired first wins the account, because "terminated by SIGTERM" is true
    // of the close and is not what happened: the deadline happened, or the cap did.
    if (cut) settle({ kind: 'limit' });
    settle(closed);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await sweep();
  }

  return report(ending!, collected, cut, bounds);
}

/** The result the model reads: how it ended, then each stream, then what was left out. */
function report(
  ending: Ending,
  collected: Record<'stdout' | 'stderr', Buffer[]>,
  cut: boolean,
  bounds: { limit: number; deadline: number },
): CapabilityResult {
  const stdout = Buffer.concat(collected.stdout).toString('utf8');
  const stderr = Buffer.concat(collected.stderr).toString('utf8');

  const headline = ((): string => {
    switch (ending.kind) {
      case 'exit':
        return ending.status === 0
          ? 'The command succeeded (exit status 0).'
          : `The command failed with exit status ${ending.status}.`;
      case 'signal':
        return `The command was ended by ${ending.signal}.`;
      case 'start':
        return `The command could not be started: ${ending.reason}`;
      case 'limit':
        return `The command was terminated because its output reached the ${bounds.limit}-byte limit.`;
      case 'deadline':
        return (
          `The command was still running after ${duration(bounds.deadline)} and was terminated, ` +
          'along with anything it had started.'
        );
      case 'aborted':
        return 'The command was terminated because this invocation was cancelled.';
    }
  })();

  const body = [
    headline,
    '',
    'stdout:',
    stdout === '' ? '(nothing)' : stdout,
    '',
    'stderr:',
    stderr === '' ? '(nothing)' : stderr,
    ...(cut ? ['', cutOff(bounds.limit)] : []),
  ].join('\n');

  return { ok: ending.kind === 'exit' && ending.status === 0 && !cut, content: body };
}

/**
 * The same sentence wherever a result was cut, so it reads the same from `fs` and `exec`.
 *
 * It says the beginning is what survived and that the rest is gone, rather than leaving the
 * model to read a fragment as the whole — which is the failure a silent cut would cause.
 */
function cutOff(limit: number): string {
  return (
    `[cut off at ${limit} bytes — this is only the beginning of the output, and the rest is not ` +
    'recoverable except by running the command again. Narrow it first: `grep` for what matters, ' +
    '`tail` for the end, or redirect to a file and read it back in pieces.]'
  );
}

/** The deadline in the units it reads best in — the same words in the description and the result. */
function duration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} seconds`;
  return `${ms}ms`;
}

/**
 * Text from the start of a buffer, and whether anything was left behind.
 *
 * The limit is in bytes and the cut is made in bytes, so a cut landing inside a multi-byte
 * character decodes as one replacement character at the very end. That is accepted rather
 * than fixed: cutting at a character boundary instead would make the bound something other
 * than the stated number of bytes, and the alternative — a result whose length depends on
 * what the content happened to contain — is worse to reason about than one stray glyph on a
 * line that already says it was cut off.
 */
function bound(buffer: Buffer, limit: number): { text: string; cut: boolean } {
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), cut: false };
  return { text: buffer.subarray(0, limit).toString('utf8'), cut: true };
}

function failed(reason: string): CapabilityResult {
  return { ok: false, content: reason };
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
