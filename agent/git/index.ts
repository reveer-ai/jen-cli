/**
 * The repository backend: where a managed project's repository lives, and every operation
 * jen performs on it.
 *
 * A bare repository per project, under one root, operated by running the host's `git` as a
 * subprocess. No server, no forge, no library — `AGENTS.md` beside this file carries the
 * decision and what it was weighed against. The supervisor is the only caller: an agent never
 * holds a repository's path, a URL to it, or a credential for it, and reaches it only through
 * the routed capabilities that call into here.
 *
 * **Everything a caller hands this module is data, and it is treated as though an agent wrote
 * it**, because one eventually did: a branch name comes from a record, a bundle comes out of a
 * workspace, and the repository's contents are whatever agents pushed. So every name is
 * validated before git sees it, every operand follows `--end-of-options`, and git runs with an
 * environment built here rather than inherited — no host config, no hooks, no prompt.
 *
 * Absence is never the same answer as failure. Where a signature can say "not there" it says
 * `null`, and it says so only when git said so in a form that cannot also mean git failed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** The oldest git with `merge-tree --write-tree`, which is what merges without a working tree. */
const MINIMUM = [2, 38] as const;

/** A project id: one path segment that can be neither hidden, relative, nor an option. */
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A full-length object id, SHA-1 or SHA-256. Abbreviations are refused: they can go ambiguous. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Where archived repositories go. A dot-name, so no project id can ever collide with it. */
const ARCHIVE = '.archive';

/**
 * How much output one git call may produce before it is an error.
 *
 * Output is returned whole or not at all. A diff cut short is a false review record, and a
 * blob cut short is a file that was never committed; both are worse than a refusal.
 */
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** How much of git's standard error a failure carries. The end is where git says why. */
const STDERR_TAIL = 4096;

/** Every failure this module reports. */
export class GitBackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitBackendError';
  }
}

/**
 * A compare-and-swap that lost: the branch was not at the value the caller required.
 *
 * Distinct from every other failure because it is the one a caller acts on differently — a
 * push that lost a race is re-read and retried or reported, and a push that failed is not.
 * `actual` is the branch's value as git found it, `null` when the branch does not exist.
 */
export class StaleRefError extends GitBackendError {
  readonly branch: string;
  readonly actual: string | null;

  constructor(branch: string, actual: string | null) {
    super(
      actual === null
        ? `the branch \`${branch}\` does not exist, and the update required it to.`
        : `the branch \`${branch}\` is at ${actual}, not at the value the update required.`,
    );
    this.name = 'StaleRefError';
    this.branch = branch;
    this.actual = actual;
  }
}

/** A bundle was asked for and there was nothing to put in it: everything is already in the basis. */
export class EmptyBundleError extends GitBackendError {
  constructor(branch: string) {
    super(`a bundle of \`${branch}\` would be empty: everything on it is reachable from the basis.`);
    this.name = 'EmptyBundleError';
  }
}

/** Who a commit is attributed to, and when. The date is explicit so that a commit is reproducible. */
export interface Attribution {
  name: string;
  email: string;
  date: Date;
}

export interface Branch {
  name: string;
  sha: string;
}

/** A ref a bundle carries, as the bundle names it. The name is the bundle's claim, not a branch. */
export interface BundleTip {
  ref: string;
  sha: string;
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  name: string;
}

/**
 * What a merge did. A conflict is an outcome rather than an exception: it is expected, and it
 * is reported back to whoever asked for the merge with the paths it concerns.
 */
export type MergeResult =
  | { kind: 'merged'; sha: string }
  | { kind: 'up-to-date' }
  | { kind: 'conflict'; paths: string[]; messages: string[] };

export interface MergeOptions {
  author: Attribution;
  committer: Attribution;
  message: string;
}

export interface OpenOptions {
  /** The git executable. Tests point this at a stub, a wrapper, or a path that does not exist. */
  git?: string;
  /** See {@link OUTPUT_LIMIT}. Tests lower it rather than producing 64 MiB of diff. */
  outputLimit?: number;
}

interface RunOptions {
  /** The repository to run against, as an absolute path. Absent for the few repo-less commands. */
  repo?: string;
  /** Written to standard input and then closed. */
  input?: string;
  /** Added to the environment this module builds. Never merged with the process's own. */
  env?: Record<string, string>;
  /** The exit codes that are outcomes rather than failures. `[0]` unless said otherwise. */
  ok?: readonly number[];
}

interface Ran {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export class GitBackend {
  readonly #root: string;
  readonly #git: string;
  readonly #limit: number;

  private constructor(root: string, git: string, limit: number) {
    this.#root = root;
    this.#git = git;
    this.#limit = limit;
  }

  /**
   * Open a backend over a root directory, creating the root if it is absent.
   *
   * The version check is here rather than at the first merge because a git too old to merge
   * should be a failure at startup, naming what it needs, and not one that waits for the first
   * task to reach the gate.
   */
  static async open(root: string, options: OpenOptions = {}): Promise<GitBackend> {
    const backend = new GitBackend(resolve(root), options.git ?? 'git', options.outputLimit ?? OUTPUT_LIMIT);
    await mkdir(backend.#root, { recursive: true });

    const { stdout } = await backend.#run(['version']);
    const text = stdout.toString('utf8').trim();
    const match = /^git version (\d+)\.(\d+)/.exec(text);
    if (match === null) {
      throw new GitBackendError(`could not read a version from \`${backend.#git} version\`: ${JSON.stringify(text)}.`);
    }
    const [major, minor] = [Number(match[1]), Number(match[2])];
    if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) {
      throw new GitBackendError(
        `git ${MINIMUM.join('.')} or later is required, for \`merge-tree --write-tree\`; found ${major}.${minor}.`,
      );
    }
    return backend;
  }

  // ---------------------------------------------------------------------------------------
  // Repositories

  /**
   * Create a project's repository: bare, empty, `HEAD` naming `main`.
   *
   * Initialised in a temporary directory and renamed into place, so a crash leaves a stray
   * dot-directory under the root and never a half-made repository at a project's path. The
   * existence check is what refuses a second create; the rename would refuse it as well, since
   * a rename onto a non-empty directory fails, and that is what closes the gap between the two.
   */
  async create(project: string): Promise<void> {
    const target = this.#path(project);
    if (await exists(target)) {
      throw new GitBackendError(`a repository for \`${project}\` already exists.`);
    }
    const scratch = await mkdtemp(join(this.#root, `.create-${project}-`));
    try {
      // `--template=` so that nothing is copied from the host's template directory: no sample
      // hooks, no description. None would run, but none need to exist either.
      await this.#run(['init', '--quiet', '--bare', '--template=', '--initial-branch=main', '--end-of-options', scratch]);
      await rename(scratch, target);
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      if (error instanceof GitBackendError) throw error;
      throw new GitBackendError(`could not create the repository for \`${project}\`: ${message(error)}`, { cause: error });
    }
  }

  /**
   * Move a project's repository aside, under `.archive/`. Returns where it went.
   *
   * There is no delete. Removing a project's history is a decision for a person with a shell,
   * and an archive is undone by renaming it back.
   */
  async archive(project: string): Promise<string> {
    const source = await this.#repo(project);
    const archive = join(this.#root, ARCHIVE);
    await mkdir(archive, { recursive: true });
    // Milliseconds, so that archiving, re-creating and archiving again within one second does
    // not collide. A collision would fail the rename rather than overwrite, but it would fail.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
    const target = join(archive, `${project}-${stamp}.git`);
    try {
      await rename(source, target);
    } catch (error) {
      throw new GitBackendError(`could not archive \`${project}\`: ${message(error)}`, { cause: error });
    }
    return target;
  }

  // ---------------------------------------------------------------------------------------
  // Branches

  async listBranches(project: string): Promise<Branch[]> {
    const repo = await this.#repo(project);
    return this.#branches(repo);
  }

  /** Create a branch at `sha`. Fails with {@link StaleRefError} if it already exists. */
  async createBranch(project: string, name: string, sha: string): Promise<void> {
    this.#path(project);
    objectId(sha);
    await this.#branch(name);
    const repo = await this.#repo(project);
    await this.#update(repo, name, ['--end-of-options', `refs/heads/${name}`, sha, '']);
  }

  /**
   * Move a branch to `sha`, provided it is at `expected`. Whether the move is a fast-forward is
   * not checked: that is the caller's policy, and a rewrite is sometimes exactly what it wants.
   */
  async moveBranch(project: string, name: string, sha: string, expected: string): Promise<void> {
    this.#path(project);
    objectId(sha);
    objectId(expected);
    await this.#branch(name);
    const repo = await this.#repo(project);
    await this.#update(repo, name, ['--end-of-options', `refs/heads/${name}`, sha, expected]);
  }

  /** Delete a branch, provided it is at `expected`. */
  async deleteBranch(project: string, name: string, expected: string): Promise<void> {
    this.#path(project);
    objectId(expected);
    await this.#branch(name);
    const repo = await this.#repo(project);
    await this.#update(repo, name, ['-d', '--end-of-options', `refs/heads/${name}`, expected]);
  }

  // ---------------------------------------------------------------------------------------
  // Transfer

  /**
   * Write a bundle of `branch` to `path`, leaving out everything reachable from `basis`.
   *
   * `path` is the supervisor's own file and must be absolute, which is also what keeps it out
   * of the option position it sits in. Git refuses to write an empty bundle, and that surfaces
   * as {@link EmptyBundleError} — to a caller refilling a workspace, "already up to date".
   */
  async bundle(project: string, branch: string, path: string, options: { basis?: string[] } = {}): Promise<void> {
    this.#path(project);
    file(path);
    const exclusions = (options.basis ?? []).map((sha) => `^${objectId(sha)}`);
    await this.#branch(branch);
    const repo = await this.#repo(project);
    const ran = await this.#run(
      ['bundle', 'create', '--quiet', path, '--end-of-options', `refs/heads/${branch}`, ...exclusions],
      { repo, ok: [0, 128] },
    );
    if (ran.code === 0) return;
    if (/Refusing to create empty bundle/.test(ran.stderr)) throw new EmptyBundleError(branch);
    throw failure(['bundle', 'create', path, branch], ran);
  }

  /**
   * Bring a bundle's objects into the repository and report the tips it carries. No ref moves.
   *
   * **Through `fetch`, never `bundle unbundle`**: `unbundle` ignores `transfer.fsckObjects` and
   * will store a malformed commit that `fetch` refuses. Fetching with no destination and no
   * `FETCH_HEAD` writes no ref at all, and a bundle whose prerequisites are missing fails whole.
   *
   * The tips are fetched **by object id rather than by the names the bundle gives them**. Those
   * names are text an agent's workspace wrote, and a refspec is a syntax — so the one thing a
   * bundle says about itself that could be read as an instruction never reaches git as one.
   * Which tip becomes which branch is the caller's to decide, by a {@link moveBranch} after.
   */
  async importBundle(project: string, path: string): Promise<BundleTip[]> {
    this.#path(project);
    file(path);
    const repo = await this.#repo(project);
    const { stdout } = await this.#run(['bundle', 'list-heads', '--end-of-options', path], { repo });
    const tips: BundleTip[] = [];
    for (const line of stdout.toString('utf8').split('\n')) {
      if (line === '') continue;
      const space = line.indexOf(' ');
      const sha = line.slice(0, space);
      if (space === -1 || !OBJECT_ID.test(sha)) {
        throw new GitBackendError(`the bundle at ${path} lists a head git did not report as an object id: ${JSON.stringify(line)}.`);
      }
      tips.push({ ref: line.slice(space + 1), sha });
    }
    if (tips.length === 0) throw new GitBackendError(`the bundle at ${path} carries no refs.`);

    const shas = [...new Set(tips.map((tip) => tip.sha))];
    await this.#run(
      ['-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--end-of-options', path, ...shas],
      { repo },
    );
    return tips;
  }

  // ---------------------------------------------------------------------------------------
  // Merge

  /**
   * Merge `source` into `target` as a merge commit attributed exactly as given, without a
   * working tree, and move `target` to it by compare-and-swap.
   *
   * Always a merge commit, even where a fast-forward was possible: this is the one commit jen
   * makes, and it is the record that the gate was passed and by whom. A conflict is returned,
   * never resolved, and leaves every ref where it was.
   */
  async merge(project: string, source: string, target: string, options: MergeOptions): Promise<MergeResult> {
    this.#path(project);
    const env = { ...identity('AUTHOR', options.author), ...identity('COMMITTER', options.committer) };
    await this.#branch(source);
    await this.#branch(target);
    const repo = await this.#repo(project);

    const theirs = await this.#tipOrFail(repo, source);
    const ours = await this.#tipOrFail(repo, target);

    const ancestry = await this.#run(['merge-base', '--is-ancestor', '--end-of-options', theirs, ours], { repo, ok: [0, 1] });
    if (ancestry.code === 0) return { kind: 'up-to-date' };

    const merged = await this.#run(['merge-tree', '--write-tree', '-z', '--name-only', '--end-of-options', ours, theirs], {
      repo,
      ok: [0, 1],
    });
    const fields = merged.stdout.toString('utf8').split('\0');
    const tree = fields[0] ?? '';
    if (!OBJECT_ID.test(tree)) {
      throw new GitBackendError(`merge-tree did not report a tree for ${target} ← ${source}: ${JSON.stringify(tree)}.`);
    }
    if (merged.code === 1) return { kind: 'conflict', ...conflicts(fields) };

    const text = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    const commit = await this.#run(['commit-tree', '-p', ours, '-p', theirs, '--end-of-options', tree], { repo, input: text, env });
    const sha = commit.stdout.toString('utf8').trim();
    await this.#update(repo, target, ['--end-of-options', `refs/heads/${target}`, sha, ours]);
    return { kind: 'merged', sha };
  }

  // ---------------------------------------------------------------------------------------
  // Reads

  /**
   * The unified diff from `from` to `to`, two-point, whole. A revision is a branch name or a
   * full object id; one that does not resolve to a commit is an error, since a string has no
   * way to say "absent" that could not also be read as "no changes".
   */
  async diff(project: string, from: string, to: string): Promise<string> {
    this.#path(project);
    await this.#revisionName(from);
    await this.#revisionName(to);
    const repo = await this.#repo(project);
    const a = await this.#revisionOrFail(repo, from);
    const b = await this.#revisionOrFail(repo, to);
    const { stdout } = await this.#run(
      ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', a, b],
      { repo },
    );
    return stdout.toString('utf8');
  }

  /**
   * One level of the tree at `rev`, under `dir` or at the root. `null` when the repository, the
   * revision, or the directory is absent — including when `dir` names a file.
   */
  async tree(project: string, rev: string, dir?: string): Promise<TreeEntry[] | null> {
    this.#path(project);
    if (dir !== undefined && dir !== '') treePath(dir);
    await this.#revisionName(rev);
    const repo = await this.#existing(project);
    if (repo === null) return null;
    const commit = await this.#revision(repo, rev);
    if (commit === null) return null;
    const found = await this.#lookup(repo, dir === undefined || dir === '' ? `${commit}^{tree}` : `${commit}:${dir}`);
    if (found?.type !== 'tree') return null;

    const { stdout } = await this.#run(['ls-tree', '-z', '--end-of-options', found.sha], { repo });
    const entries: TreeEntry[] = [];
    for (const record of stdout.toString('utf8').split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      const [mode, type, sha] = record.slice(0, tab).split(' ');
      entries.push({ mode: mode ?? '', type: type as TreeEntry['type'], sha: sha ?? '', name: record.slice(tab + 1) });
    }
    return entries;
  }

  /** The exact bytes of the file at `path` in `rev`. `null` when anything along the way is absent. */
  async blob(project: string, rev: string, path: string): Promise<Buffer | null> {
    this.#path(project);
    treePath(path);
    await this.#revisionName(rev);
    const repo = await this.#existing(project);
    if (repo === null) return null;
    const commit = await this.#revision(repo, rev);
    if (commit === null) return null;
    const found = await this.#lookup(repo, `${commit}:${path}`);
    if (found?.type !== 'blob') return null;
    const { stdout } = await this.#run(['cat-file', 'blob', '--end-of-options', found.sha], { repo });
    return stdout;
  }

  // ---------------------------------------------------------------------------------------
  // Internals

  #path(project: string): string {
    if (typeof project !== 'string' || !PROJECT.test(project)) {
      throw new GitBackendError(`\`${String(project)}\` is not a valid project id: it must match ${PROJECT}.`);
    }
    return join(this.#root, `${project}.git`);
  }

  /** The repository's path, or `null` if there is none. Validates the id either way. */
  async #existing(project: string): Promise<string | null> {
    const path = this.#path(project);
    return (await exists(path)) ? path : null;
  }

  /** The repository's path, or an error naming the project. */
  async #repo(project: string): Promise<string> {
    const path = await this.#existing(project);
    if (path === null) throw new GitBackendError(`there is no repository for \`${project}\`.`);
    return path;
  }

  /**
   * Refuse a branch name git would not accept as one — or would read as something else.
   *
   * `check-ref-format --branch` is git's own rule, and it also *expands* what it can: `@{-1}`
   * becomes the previously checked-out branch, `@` becomes `HEAD`'s. So the name is accepted
   * only if git prints it back unchanged — the name git would act on is the name given.
   * That round trip does not catch a bare `@`, which `--branch` passes through untouched and
   * every other git command reads as `HEAD`, so it is refused by name.
   */
  async #branch(name: string): Promise<void> {
    if (typeof name !== 'string' || name === '' || name === '@' || name.startsWith('-') || /[\0\n]/.test(name)) {
      throw new GitBackendError(`${JSON.stringify(name)} is not a valid branch name.`);
    }
    const ran = await this.#run(['check-ref-format', '--branch', name], { ok: [0, 1, 128] });
    if (ran.code !== 0 || ran.stdout.toString('utf8').replace(/\n$/, '') !== name) {
      throw new GitBackendError(`${JSON.stringify(name)} is not a valid branch name.`);
    }
  }

  /** Refuse a revision that is neither a full object id nor a valid branch name. */
  async #revisionName(rev: string): Promise<void> {
    if (typeof rev === 'string' && OBJECT_ID.test(rev)) return;
    try {
      await this.#branch(rev);
    } catch {
      throw new GitBackendError(`${JSON.stringify(rev)} is not a valid revision: it must be a branch name or a full object id.`);
    }
  }

  async #branches(repo: string): Promise<Branch[]> {
    const { stdout } = await this.#run(
      ['for-each-ref', '--format=%(objectname) %(refname)', '--end-of-options', 'refs/heads/'],
      { repo },
    );
    return stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const space = line.indexOf(' ');
        return { name: line.slice(space + 1).replace(/^refs\/heads\//, ''), sha: line.slice(0, space) };
      });
  }

  /**
   * A branch's tip, or `null`. Read by listing rather than by `rev-parse`, because rev-parse
   * guesses — `refs/heads/x` is also tried as `refs/tags/refs/heads/x` — and a listing matched
   * exactly cannot, and exits zero whether the branch is there or not.
   */
  async #tip(repo: string, name: string): Promise<string | null> {
    return (await this.#branches(repo)).find((branch) => branch.name === name)?.sha ?? null;
  }

  async #tipOrFail(repo: string, name: string): Promise<string> {
    const sha = await this.#tip(repo, name);
    if (sha === null) throw new GitBackendError(`there is no branch \`${name}\`.`);
    return sha;
  }

  /** A revision resolved to a commit's object id, or `null` if it resolves to none. */
  async #revision(repo: string, rev: string): Promise<string | null> {
    if (!OBJECT_ID.test(rev)) return this.#tip(repo, rev);
    const found = await this.#lookup(repo, `${rev}^{commit}`);
    return found?.type === 'commit' ? found.sha : null;
  }

  async #revisionOrFail(repo: string, rev: string): Promise<string> {
    const sha = await this.#revision(repo, rev);
    if (sha === null) throw new GitBackendError(`\`${rev}\` does not name a commit in this repository.`);
    return sha;
  }

  /**
   * Look an object expression up, answering `null` for "not there".
   *
   * `cat-file --batch-check` exits zero whether or not the object exists and says `missing`
   * when it does not, so a non-zero exit means only that git failed. The obvious call —
   * `cat-file -e rev:path` — exits 128 on a missing *path*, which is the same code as a
   * corrupt repository, and cannot be told apart from one.
   */
  async #lookup(repo: string, expression: string): Promise<{ sha: string; type: string } | null> {
    const { stdout } = await this.#run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      repo,
      input: `${expression}\n`,
    });
    const line = stdout.toString('utf8').replace(/\n$/, '');
    if (line === `${expression} missing` || line === `${expression} ambiguous`) return null;
    const [sha, type] = line.split(' ');
    if (sha === undefined || type === undefined || !OBJECT_ID.test(sha)) {
      throw new GitBackendError(`cat-file answered ${JSON.stringify(line)} for ${JSON.stringify(expression)}.`);
    }
    return { sha, type };
  }

  /**
   * One `update-ref` with its old value, mapping a lost compare-and-swap to {@link StaleRefError}.
   *
   * Git takes the ref's lock and compares under it, and says which way it lost in its message:
   * the value it found, that the ref already exists (a create), or that it does not (a move or
   * delete of a missing branch). Anything else — a missing object, a non-commit on a branch —
   * is an ordinary failure.
   */
  async #update(repo: string, name: string, args: string[]): Promise<void> {
    const ran = await this.#run(['update-ref', ...args], { repo, ok: [0, 1, 128] });
    if (ran.code === 0) return;
    const at = /cannot lock ref '[^']*': is at ([0-9a-f]+) but expected/.exec(ran.stderr);
    if (at?.[1] !== undefined) throw new StaleRefError(name, at[1]);
    if (/cannot lock ref '[^']*': reference already exists/.test(ran.stderr)) {
      throw new StaleRefError(name, await this.#tip(repo, name));
    }
    if (/cannot lock ref '[^']*': unable to resolve reference/.test(ran.stderr)) throw new StaleRefError(name, null);
    throw failure(['update-ref', ...args], ran);
  }

  /**
   * Run git, insulated from the host, and collect everything it writes.
   *
   * The environment is built here and not inherited. Inheriting would carry `GIT_DIR`,
   * `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF` and whatever else the supervisor was started with
   * into every call; and a user's global config — `diff.noprefix`, an alias, `attr.tree` plus
   * a merge driver — would change what an operation does. `HOME` is the root so that nothing
   * finds a real home either.
   *
   * Every pipe has an `error` listener. An unlistened stream `error` is raised as an uncaught
   * exception, and the process it would take down is the supervisor.
   */
  #run(args: string[], options: RunOptions = {}): Promise<Ran> {
    const argv = [
      '-c', 'core.hooksPath=/dev/null',
      // A fetch would otherwise start a background gc or maintenance run: a process nobody
      // waits for, pruning under a repository an operation is still using.
      '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false',
      ...(options.repo === undefined ? [] : [`--git-dir=${options.repo}`]),
      ...args,
    ];
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: this.#root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      ...options.env,
    };
    const ok = options.ok ?? [0];
    const limit = this.#limit;

    return new Promise<Ran>((resolvePromise, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.#git, argv, {
          cwd: this.#root,
          env,
          stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new GitBackendError(`could not run \`${this.#git}\`: ${message(error)}`, { cause: error }));
        return;
      }

      const out: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let stderr = '';
      let broken: Error | undefined;

      for (const pipe of [child.stdin, child.stdout, child.stderr]) {
        pipe?.on('error', (error: Error) => {
          broken ??= error;
        });
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (overflow) return;
        size += chunk.length;
        if (size > limit) {
          overflow = true;
          out.length = 0;
          child.kill('SIGKILL');
          return;
        }
        out.push(chunk);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });

      child.on('error', (error) => {
        reject(new GitBackendError(`could not run \`${this.#git}\`: ${error.message}`, { cause: error }));
      });
      child.on('close', (code, signal) => {
        if (overflow) {
          reject(new GitBackendError(`\`git ${args.join(' ')}\` produced more than ${limit} bytes of output, and output is never truncated.`));
          return;
        }
        const ran = { code: code ?? -1, stdout: Buffer.concat(out), stderr };
        if (code === null) {
          reject(new GitBackendError(`\`git ${args.join(' ')}\` was ended by ${signal}.${tail(stderr)}`));
        } else if (!ok.includes(code)) {
          reject(failure(args, ran));
        } else if (broken !== undefined && code === 0) {
          // A zero exit with a broken pipe means something did not arrive — the input it was
          // sent, or the output it wrote — and a success that silently lost either is not one.
          reject(new GitBackendError(`a pipe to \`git ${args.join(' ')}\` broke: ${broken.message}`, { cause: broken }));
        } else {
          resolvePromise(ran);
        }
      });

      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }
}

/** The environment a commit's attribution is given in. Refuses what would corrupt the header. */
function identity(role: 'AUTHOR' | 'COMMITTER', who: Attribution): Record<string, string> {
  for (const [field, value] of [['name', who.name], ['email', who.email]] as const) {
    if (typeof value !== 'string' || value.trim() === '' || /[<>\n\0]/.test(value)) {
      throw new GitBackendError(`the ${role.toLowerCase()}'s ${field} ${JSON.stringify(value)} cannot be written into a commit.`);
    }
  }
  if (!(who.date instanceof Date) || Number.isNaN(who.date.getTime())) {
    throw new GitBackendError(`the ${role.toLowerCase()}'s date is not a valid date.`);
  }
  return {
    [`GIT_${role}_NAME`]: who.name,
    [`GIT_${role}_EMAIL`]: who.email,
    // Git's raw format: seconds since the epoch and an offset. UTC, since a Date carries no zone.
    [`GIT_${role}_DATE`]: `${Math.floor(who.date.getTime() / 1000)} +0000`,
  };
}

/**
 * The paths and messages of a conflicted `merge-tree -z --name-only`.
 *
 * After the tree: the conflicted paths, an empty field, then each message as a count, that many
 * paths, a type, and the text.
 */
function conflicts(fields: string[]): { paths: string[]; messages: string[] } {
  let at = 1;
  const paths: string[] = [];
  while (at < fields.length && fields[at] !== '') paths.push(fields[at++] ?? '');
  at++;
  const messages: string[] = [];
  while (at < fields.length) {
    const count = Number(fields[at]);
    if (fields[at] === '' || !Number.isInteger(count)) break;
    at += 1 + count + 1;
    const text = fields[at++];
    if (text !== undefined) messages.push(text.replace(/\n$/, ''));
  }
  return { paths, messages };
}

function objectId(sha: string): string {
  if (typeof sha !== 'string' || !OBJECT_ID.test(sha)) {
    throw new GitBackendError(`${JSON.stringify(sha)} is not a full-length object id.`);
  }
  return sha;
}

/**
 * A path inside a tree, as a caller names one: relative, normalised, no empty, `.` or `..`
 * segments. Git reads `rev:./x` relative to the working directory, so an unnormalised path is
 * not just untidy — it is a different lookup. A newline is refused because lookups are sent as
 * lines.
 */
function treePath(path: string): void {
  if (
    typeof path !== 'string' ||
    path === '' ||
    /[\0\n]/.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new GitBackendError(`${JSON.stringify(path)} is not a valid path within a tree.`);
  }
}

/** A bundle's path: the supervisor's own file, absolute — which also keeps it off the option position. */
function file(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new GitBackendError(`${JSON.stringify(path)} is not an absolute path.`);
  }
}

function failure(args: string[], ran: Ran): GitBackendError {
  return new GitBackendError(`\`git ${args.join(' ')}\` exited ${ran.code}.${tail(ran.stderr)}`);
}

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : ` ${trimmed}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new GitBackendError(`could not check ${path}: ${message(error)}`, { cause: error });
  }
}
