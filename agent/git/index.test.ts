/**
 * The repository backend, against real repositories in a temporary directory.
 *
 * Nothing is mocked. Every property here — that a compare-and-swap loses cleanly, that a
 * malformed object is refused, that a hostile config changes nothing — is a property of what
 * git actually did, and a stub of git would only restate what this module assumes about it.
 *
 * Where a test needs git to behave differently for one call — a branch that moves between
 * the merge's read and its update, or a record of whether git ran at all — it does so the way
 * a caller could: through `open`'s `git` option, pointed at a wrapper script around the real
 * one. The backend grows no seam for its tests.
 *
 * The insulation tests each carry a control: the same hostile setup, driven through plain git,
 * must trip the marker. Without it a test for "nothing ran" passes just as well when nothing
 * could have.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmptyBundleError, GitBackend, GitBackendError, StaleRefError } from './index.ts';

import type { Attribution } from './index.ts';

const run = promisify(execFile);

let scratch: string;
let root: string;
let backend: GitBackend;
let real: string;
let counter = 0;

/** The environment fixtures are built in: as insulated as the backend's, so the host cannot leak in. */
function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: scratch,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: fixtureEnv() });
  return stdout.trim();
}

/** A working repository standing in for an agent's workspace. */
async function workspace(): Promise<string> {
  const dir = join(scratch, `work-${++counter}`);
  await run('git', ['init', '--quiet', '--initial-branch=main', dir], { env: fixtureEnv() });
  return dir;
}

/** Commit `files` on the workspace's current branch. `null` deletes a file. */
async function commit(dir: string, files: Record<string, string | Buffer | null>, message = 'change'): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (content === null) {
      await rm(target);
    } else {
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    }
  }
  await git(dir, 'add', '--all');
  await git(dir, 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

function bundlePath(): string {
  return join(scratch, `transfer-${++counter}.bundle`);
}

/** What a push is: bundle out of the workspace, import, then compare-and-swap the branch. */
async function push(project: string, dir: string, branch: string): Promise<string> {
  const path = bundlePath();
  await git(dir, 'bundle', 'create', '--quiet', path, `refs/heads/${branch}`);
  const tips = await backend.importBundle(project, path);
  const sha = tips.find((tip) => tip.ref === `refs/heads/${branch}`)?.sha;
  if (sha === undefined) throw new Error(`the bundle carried no ${branch}`);
  const current = (await backend.listBranches(project)).find((b) => b.name === branch)?.sha;
  if (current === undefined) await backend.createBranch(project, branch, sha);
  else await backend.moveBranch(project, branch, sha, current);
  return sha;
}

function repoPath(project: string): string {
  return join(root, `${project}.git`);
}

async function script(name: string, body: string): Promise<string> {
  const path = join(scratch, `${name}-${++counter}.sh`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

const jen: Attribution = { name: 'jen', email: 'jen@reveer.ai', date: new Date('2026-09-28T12:00:00Z') };
const reviewer: Attribution = { name: 'A Reviewer', email: 'reviewer@example.com', date: new Date('2026-09-28T12:05:00Z') };

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'jen-git-'));
  real = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  root = join(scratch, `root-${++counter}`);
  backend = await GitBackend.open(root);
});

describe('construction', () => {
  it('opens against the host git and creates its root', async () => {
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a git older than 2.38, naming the requirement', async () => {
    const old = await script('old-git', 'echo "git version 2.37.0"');
    await expect(GitBackend.open(root, { git: old })).rejects.toThrow(/2\.38/);
    await expect(GitBackend.open(root, { git: old })).rejects.toBeInstanceOf(GitBackendError);
  });

  it('accepts a vendor-suffixed version string', async () => {
    const apple = await script('apple-git', `case "$1" in version) echo "git version 2.39.5 (Apple Git-154)";; *) exec ${real} "$@";; esac`);
    await expect(GitBackend.open(root, { git: apple })).resolves.toBeInstanceOf(GitBackend);
  });

  it('rejects, without crashing, when git cannot be spawned', async () => {
    await expect(GitBackend.open(root, { git: join(scratch, 'no-such-git') })).rejects.toBeInstanceOf(GitBackendError);
  });
});

describe('validation happens before anything is touched', () => {
  it('refuses a project id that could escape the root or read as an option', async () => {
    for (const id of ['../other', '.archive', '-x', 'Upper', '', 'a/b', 'a'.repeat(64)]) {
      await expect(backend.create(id), id).rejects.toThrow(/not a valid project id/);
      await expect(backend.listBranches(id), id).rejects.toBeInstanceOf(GitBackendError);
      await expect(backend.blob(id, 'main', 'f'), id).rejects.toBeInstanceOf(GitBackendError);
    }
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(scratch)).not.toContain('other.git');
  });

  it('refuses option-shaped names and revisions without running git', async () => {
    await backend.create('demo');
    const log = join(scratch, `argv-${++counter}.log`);
    const logging = await script('logging-git', `echo "$*" >> ${log}\nexec ${real} "$@"`);
    const watched = await GitBackend.open(root, { git: logging });
    await rm(log);

    const sha = 'a'.repeat(40);
    await expect(watched.createBranch('demo', '--output=/tmp/x', sha)).rejects.toThrow(/not a valid branch name/);
    await expect(watched.diff('demo', '-p', 'main')).rejects.toThrow(/not a valid revision/);
    await expect(watched.blob('demo', '-p', 'f')).rejects.toThrow(/not a valid revision/);
    await expect(watched.moveBranch('demo', 'main', '--all', sha)).rejects.toThrow(/object id/);
    await expect(watched.bundle('demo', 'main', 'relative.bundle')).rejects.toThrow(/absolute/);
    await expect(watched.blob('demo', 'main', '../f')).rejects.toThrow(/valid path/);
    await expect(watched.tree('demo', 'main', './dir')).rejects.toThrow(/valid path/);
    expect(await exists(log)).toBe(false);
  });

  it('refuses a name git would read as something other than itself', async () => {
    await backend.create('demo');
    // `@{-1}` and `@` are expanded by `check-ref-format --branch` rather than refused by it.
    for (const name of ['@{-1}', '@', 'HEAD', 'a..b', 'a b', 'x.lock', 'trailing/']) {
      await expect(backend.createBranch('demo', name, 'a'.repeat(40)), name).rejects.toThrow(/not a valid branch name/);
    }
  });
});

describe('repositories', () => {
  it('creates an empty bare repository whose HEAD is main', async () => {
    await backend.create('demo');
    expect(await backend.listBranches('demo')).toEqual([]);
    expect(await readFile(join(repoPath('demo'), 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(await git(repoPath('demo'), 'rev-parse', '--is-bare-repository')).toBe('true');
    // Nothing left behind from the temporary directory it was made in.
    expect(await readdir(root)).toEqual(['demo.git']);
  });

  it('refuses a second create and leaves the first intact', async () => {
    await backend.create('demo');
    const work = await workspace();
    await commit(work, { f: 'one\n' });
    const sha = await push('demo', work, 'main');

    await expect(backend.create('demo')).rejects.toThrow(/already exists/);
    expect(await backend.listBranches('demo')).toEqual([{ name: 'main', sha }]);
    expect((await readdir(root)).sort()).toEqual(['demo.git']);
  });

  it('archives by moving, with every branch intact, and frees the id', async () => {
    await backend.create('demo');
    const work = await workspace();
    const main = await commit(work, { f: 'one\n' });
    await push('demo', work, 'main');
    await git(work, 'checkout', '--quiet', '-b', 'task/a');
    const task = await commit(work, { g: 'two\n' });
    await push('demo', work, 'task/a');

    const archived = await backend.archive('demo');
    expect(archived.startsWith(join(root, '.archive', 'demo-'))).toBe(true);
    expect(await exists(join(repoPath('demo'), 'HEAD'))).toBe(false);
    expect(await git(archived, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(
      `refs/heads/main ${main}\nrefs/heads/task/a ${task}`,
    );

    await expect(backend.listBranches('demo')).rejects.toThrow(/no repository/);
    await expect(backend.archive('demo')).rejects.toThrow(/no repository/);
    await backend.create('demo');
    expect(await backend.listBranches('demo')).toEqual([]);
  });

  it('keeps one project’s objects out of another’s reach', async () => {
    await backend.create('a');
    await backend.create('b');
    const work = await workspace();
    const sha = await commit(work, { secret: 'only in a\n' });
    await push('a', work, 'main');

    expect(await backend.tree('b', sha)).toBeNull();
    expect(await backend.blob('b', sha, 'secret')).toBeNull();
    await expect(backend.diff('b', sha, sha)).rejects.toThrow(/does not name a commit/);
    await expect(backend.createBranch('b', 'stolen', sha)).rejects.toBeInstanceOf(GitBackendError);
    await expect(run('git', ['--git-dir', repoPath('b'), 'cat-file', '-e', sha], { env: fixtureEnv() })).rejects.toThrow();
    // No alternates were ever configured.
    expect(await exists(join(repoPath('b'), 'objects', 'info', 'alternates'))).toBe(false);
  });
});

describe('branches are written by compare-and-swap', () => {
  let one: string;
  let two: string;
  let other: string;

  beforeEach(async () => {
    await backend.create('demo');
    const work = await workspace();
    one = await commit(work, { f: '1\n' });
    two = await commit(work, { f: '2\n' });
    await git(work, 'checkout', '--quiet', '--orphan', 'unrelated');
    other = await commit(work, { g: 'x\n' });
    const path = bundlePath();
    await git(work, 'bundle', 'create', '--quiet', path, '--all');
    await backend.importBundle('demo', path);
  });

  it('creates, moves and deletes', async () => {
    await backend.createBranch('demo', 'task/eng-42', one);
    expect(await backend.listBranches('demo')).toEqual([{ name: 'task/eng-42', sha: one }]);
    await backend.moveBranch('demo', 'task/eng-42', two, one);
    expect(await backend.listBranches('demo')).toEqual([{ name: 'task/eng-42', sha: two }]);
    await backend.deleteBranch('demo', 'task/eng-42', two);
    expect(await backend.listBranches('demo')).toEqual([]);
  });

  it('refuses a create over an existing branch, reporting its value', async () => {
    await backend.createBranch('demo', 'main', one);
    const error = await backend.createBranch('demo', 'main', two).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleRefError);
    expect(error).toMatchObject({ branch: 'main', actual: one });
    expect(await backend.listBranches('demo')).toEqual([{ name: 'main', sha: one }]);
  });

  it('refuses a move against a stale expectation, reporting the actual value', async () => {
    await backend.createBranch('demo', 'main', two);
    const error = await backend.moveBranch('demo', 'main', other, one).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleRefError);
    expect(error).toMatchObject({ actual: two });
    expect(await backend.listBranches('demo')).toEqual([{ name: 'main', sha: two }]);
  });

  it('refuses a delete against a stale expectation', async () => {
    await backend.createBranch('demo', 'main', two);
    await expect(backend.deleteBranch('demo', 'main', one)).rejects.toMatchObject({ name: 'StaleRefError', actual: two });
    expect(await backend.listBranches('demo')).toEqual([{ name: 'main', sha: two }]);
  });

  it('reports a missing branch as stale with no value', async () => {
    await expect(backend.moveBranch('demo', 'gone', two, one)).rejects.toMatchObject({ name: 'StaleRefError', actual: null });
    await expect(backend.deleteBranch('demo', 'gone', one)).rejects.toMatchObject({ name: 'StaleRefError', actual: null });
    expect(await backend.listBranches('demo')).toEqual([]);
  });

  it('moves to a non-descendant when the expectation holds', async () => {
    await backend.createBranch('demo', 'main', two);
    await backend.moveBranch('demo', 'main', other, two);
    expect(await backend.listBranches('demo')).toEqual([{ name: 'main', sha: other }]);
  });

  it('refuses a missing object or a non-commit, as an ordinary failure', async () => {
    await backend.createBranch('demo', 'main', one);
    const missing = await backend.moveBranch('demo', 'main', 'b'.repeat(40), one).catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(GitBackendError);
    expect(missing).not.toBeInstanceOf(StaleRefError);
    expect((missing as Error).message).toMatch(/nonexistent object/);

    const tree = await git(repoPath('demo'), 'rev-parse', `${one}^{tree}`);
    await expect(backend.moveBranch('demo', 'main', tree, one)).rejects.toThrow(/non-commit/);
    expect(await backend.listBranches('demo')).toEqual([{ name: 'main', sha: one }]);
  });

  it('resolves branch names exactly, never by prefix', async () => {
    // `for-each-ref refs/heads/task` would list `task/a`; a lookup of `task` must not find it.
    await backend.createBranch('demo', 'task/a', one);
    await expect(backend.diff('demo', 'task', 'task/a')).rejects.toThrow(/does not name a commit/);
    expect(await backend.tree('demo', 'task')).toBeNull();
    await expect(backend.moveBranch('demo', 'task', two, one)).rejects.toBeInstanceOf(GitBackendError);
    expect(await backend.listBranches('demo')).toEqual([{ name: 'task/a', sha: one }]);
  });
});

describe('transfer', () => {
  it('round-trips a full bundle into a fresh clone', async () => {
    await backend.create('demo');
    const work = await workspace();
    await commit(work, { f: '1\n' });
    const sha = await push('demo', work, 'main');

    const path = bundlePath();
    await backend.bundle('demo', 'main', path);
    const clone = join(scratch, `clone-${++counter}`);
    await run('git', ['clone', '--quiet', '--branch', 'main', path, clone], { env: fixtureEnv() });
    expect(await git(clone, 'rev-parse', 'main')).toBe(sha);
  });

  it('writes an incremental bundle that names its basis, and imports where the basis is present', async () => {
    await backend.create('demo');
    const work = await workspace();
    const parent = await commit(work, { f: '1\n' });
    await push('demo', work, 'main');
    const tip = await commit(work, { f: '2\n' });
    await push('demo', work, 'main');

    const path = bundlePath();
    await backend.bundle('demo', 'main', path, { basis: [parent] });
    const header = (await readFile(path)).toString('latin1').split('\n\n')[0] ?? '';
    expect(header).toMatch(new RegExp(`^-${parent}`, 'm'));

    await backend.create('mirror');
    const seed = bundlePath();
    await git(work, 'branch', 'seed', parent);
    await git(work, 'bundle', 'create', '--quiet', seed, 'refs/heads/seed');
    await backend.importBundle('mirror', seed);
    expect(await backend.importBundle('mirror', path)).toEqual([{ ref: 'refs/heads/main', sha: tip }]);
    await backend.createBranch('mirror', 'main', tip);
  });

  it('refuses an empty bundle distinguishably', async () => {
    await backend.create('demo');
    const work = await workspace();
    const sha = await commit(work, { f: '1\n' });
    await push('demo', work, 'main');
    await expect(backend.bundle('demo', 'main', bundlePath(), { basis: [sha] })).rejects.toBeInstanceOf(EmptyBundleError);
  });

  it('imports without touching any ref or writing FETCH_HEAD', async () => {
    await backend.create('demo');
    const work = await workspace();
    await commit(work, { f: '1\n' });
    await push('demo', work, 'main');
    await git(work, 'checkout', '--quiet', '-b', 'task/x');
    const sha = await commit(work, { g: 'new\n' });

    const before = await backend.listBranches('demo');
    const path = bundlePath();
    await git(work, 'bundle', 'create', '--quiet', path, 'refs/heads/task/x');
    expect(await backend.importBundle('demo', path)).toEqual([{ ref: 'refs/heads/task/x', sha }]);
    expect(await backend.listBranches('demo')).toEqual(before);
    expect(await exists(join(repoPath('demo'), 'FETCH_HEAD'))).toBe(false);

    await backend.createBranch('demo', 'task/x', sha);
    expect(await backend.blob('demo', 'task/x', 'g')).toEqual(Buffer.from('new\n'));
  });

  it('fetches by object id, so a hostile ref name in a bundle is never read as a refspec', async () => {
    await backend.create('demo');
    const work = await workspace();
    const sha = await commit(work, { f: '1\n' });
    // A ref git itself would never write, but a bundle is a file and its header is just text.
    const path = bundlePath();
    await git(work, 'bundle', 'create', '--quiet', path, 'refs/heads/main');
    const bytes = (await readFile(path)).toString('latin1').replace(`${sha} refs/heads/main`, `${sha} +refs/heads/main:refs/heads/owned`);
    await writeFile(path, Buffer.from(bytes, 'latin1'));

    expect(await backend.importBundle('demo', path)).toEqual([{ ref: '+refs/heads/main:refs/heads/owned', sha }]);
    expect(await backend.listBranches('demo')).toEqual([]);
  });

  it('refuses a bundle holding a malformed commit, and stores nothing of it', async () => {
    await backend.create('demo');
    const work = await workspace();
    // `mktree` reads its entries from standard input, which `execFile` leaves open.
    const { stdout } = await run(
      'sh',
      ['-c', `tree=$(git mktree </dev/null) && printf "tree $tree\\nauthor broken\\ncommitter a <a@x> 0 +0000\\n\\nbad\\n" | git hash-object -t commit -w --literally --stdin`],
      { cwd: work, env: fixtureEnv() },
    );
    const bad = stdout.trim();
    await git(work, 'update-ref', 'refs/heads/bad', bad);
    const path = bundlePath();
    await git(work, 'bundle', 'create', '--quiet', path, 'refs/heads/bad');

    await expect(backend.importBundle('demo', path)).rejects.toThrow(/fsck|index-pack/);
    expect(await backend.tree('demo', bad)).toBeNull();
    await expect(backend.createBranch('demo', 'bad', bad)).rejects.toBeInstanceOf(GitBackendError);
    expect(await backend.listBranches('demo')).toEqual([]);
  });

  it('refuses an incremental bundle whose basis the repository lacks', async () => {
    await backend.create('source');
    await backend.create('fresh');
    const work = await workspace();
    const parent = await commit(work, { f: '1\n' });
    await commit(work, { f: '2\n' });
    await push('source', work, 'main');
    const path = bundlePath();
    await backend.bundle('source', 'main', path, { basis: [parent] });

    await expect(backend.importBundle('fresh', path)).rejects.toBeInstanceOf(GitBackendError);
    expect(await backend.listBranches('fresh')).toEqual([]);
  });
});

describe('merge', () => {
  let work: string;
  let base: string;

  beforeEach(async () => {
    await backend.create('demo');
    work = await workspace();
    base = await commit(work, { f: 'one\ntwo\nthree\n' }, 'base');
    await push('demo', work, 'main');
  });

  async function branchFrom(name: string, start: string, files: Record<string, string | null>): Promise<string> {
    await git(work, 'checkout', '--quiet', '-B', name, start);
    const sha = await commit(work, files, name);
    await push('demo', work, name);
    return sha;
  }

  async function parents(sha: string): Promise<string[]> {
    return (await git(repoPath('demo'), 'rev-list', '--parents', '-n', '1', sha)).split(' ').slice(1);
  }

  it('makes a merge commit with exact parents and attribution', async () => {
    const main = await branchFrom('main', base, { f: 'ONE\ntwo\nthree\n' });
    const task = await branchFrom('task/a', base, { g: 'new\n' });

    const result = await backend.merge('demo', 'task/a', 'main', { author: reviewer, committer: jen, message: 'Land ENG-1' });
    expect(result.kind).toBe('merged');
    const sha = (result as { sha: string }).sha;
    expect(await backend.listBranches('demo')).toContainEqual({ name: 'main', sha });
    expect(await parents(sha)).toEqual([main, task]);
    expect(await git(repoPath('demo'), 'log', '-1', '--format=%an|%ae|%at|%cn|%ce|%ct|%s', sha)).toBe(
      `A Reviewer|reviewer@example.com|${reviewer.date.getTime() / 1000}|jen|jen@reveer.ai|${jen.date.getTime() / 1000}|Land ENG-1`,
    );
    expect(await backend.blob('demo', 'main', 'f')).toEqual(Buffer.from('ONE\ntwo\nthree\n'));
    expect(await backend.blob('demo', 'main', 'g')).toEqual(Buffer.from('new\n'));
  });

  it('never fast-forwards', async () => {
    const task = await branchFrom('task/a', base, { g: 'new\n' });
    const result = await backend.merge('demo', 'task/a', 'main', { author: jen, committer: jen, message: 'm' });
    expect(result.kind).toBe('merged');
    const sha = (result as { sha: string }).sha;
    expect(sha).not.toBe(task);
    expect(await parents(sha)).toEqual([base, task]);
  });

  it('reports a conflict with its paths and moves nothing', async () => {
    const main = await branchFrom('main', base, { f: 'one\nMAIN\nthree\n' });
    await branchFrom('task/b', base, { f: 'one\nTASK\nthree\n' });

    const result = await backend.merge('demo', 'task/b', 'main', { author: jen, committer: jen, message: 'm' });
    expect(result).toMatchObject({ kind: 'conflict', paths: ['f'] });
    expect((result as { messages: string[] }).messages.join('\n')).toMatch(/CONFLICT \(content\)/);
    expect((await backend.listBranches('demo')).find((b) => b.name === 'main')?.sha).toBe(main);
  });

  it('is up to date on a repeat merge, and changes nothing', async () => {
    await branchFrom('task/a', base, { g: 'new\n' });
    await backend.merge('demo', 'task/a', 'main', { author: jen, committer: jen, message: 'm' });
    const before = await backend.listBranches('demo');
    expect(await backend.merge('demo', 'task/a', 'main', { author: jen, committer: jen, message: 'm' })).toEqual({ kind: 'up-to-date' });
    expect(await backend.listBranches('demo')).toEqual(before);
  });

  it('does not clobber a target that moved between the read and the update', async () => {
    await branchFrom('task/a', base, { g: 'new\n' });
    const racing = await branchFrom('racer', base, { h: 'raced\n' });
    // Moves main the moment the merge commit is being made — after merge read main's tip.
    const flag = join(scratch, `raced-${++counter}`);
    const wrapper = await script(
      'racing-git',
      `for a in "$@"; do
  if [ "$a" = commit-tree ] && [ ! -e ${flag} ]; then
    touch ${flag}
    ${real} --git-dir=${repoPath('demo')} update-ref refs/heads/main ${racing}
  fi
done
exec ${real} "$@"`,
    );
    const raced = await GitBackend.open(root, { git: wrapper });

    const error = await raced.merge('demo', 'task/a', 'main', { author: jen, committer: jen, message: 'm' }).catch((caught: unknown) => caught);
    expect(await exists(flag)).toBe(true);
    expect(error).toBeInstanceOf(StaleRefError);
    expect(error).toMatchObject({ branch: 'main', actual: racing });
    expect((await backend.listBranches('demo')).find((b) => b.name === 'main')?.sha).toBe(racing);
  });

  it('refuses an attribution that would corrupt the commit header', async () => {
    await branchFrom('task/a', base, { g: 'new\n' });
    for (const bad of [{ ...jen, name: 'a <b>' }, { ...jen, email: 'x\ny' }, { ...jen, name: ' ' }, { ...jen, date: new Date('nope') }]) {
      await expect(backend.merge('demo', 'task/a', 'main', { author: bad, committer: jen, message: 'm' })).rejects.toBeInstanceOf(GitBackendError);
    }
    expect((await backend.listBranches('demo')).find((b) => b.name === 'main')?.sha).toBe(base);
  });
});

describe('reads', () => {
  let one: string;
  let two: string;

  beforeEach(async () => {
    await backend.create('demo');
    const work = await workspace();
    one = await commit(work, { f: 'alpha\n', 'dir/g': 'inner\n', 'dir/deep/h': 'deeper\n' });
    await push('demo', work, 'main');
    await git(work, 'checkout', '--quiet', '-b', 'task/a');
    two = await commit(work, { f: 'alpha\nbeta\n', bin: Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]) });
    await push('demo', work, 'task/a');
  });

  it('diffs two revisions with a/ and b/ prefixes', async () => {
    const diff = await backend.diff('demo', 'main', 'task/a');
    expect(diff).toContain('diff --git a/f b/f');
    expect(diff).toContain('--- a/f\n+++ b/f\n');
    expect(diff).toContain('+beta\n');
    expect(await backend.diff('demo', one, two)).toBe(diff);
    expect(await backend.diff('demo', 'main', 'main')).toBe('');
  });

  it('refuses a diff whose revision is absent', async () => {
    await expect(backend.diff('demo', 'main', 'nope')).rejects.toThrow(/does not name a commit/);
    await expect(backend.diff('demo', 'c'.repeat(40), 'main')).rejects.toThrow(/does not name a commit/);
  });

  it('fails a diff too large to hold rather than truncating it', async () => {
    const small = await GitBackend.open(root, { outputLimit: 64 });
    await expect(small.diff('demo', 'main', 'task/a')).rejects.toThrow(/never truncated/);
  });

  it('lists one level of a tree', async () => {
    const top = await backend.tree('demo', 'main');
    expect(top?.map(({ name, type, mode }) => ({ name, type, mode }))).toEqual([
      { name: 'dir', type: 'tree', mode: '040000' },
      { name: 'f', type: 'blob', mode: '100644' },
    ]);
    expect((await backend.tree('demo', 'main', 'dir'))?.map((entry) => entry.name)).toEqual(['deep', 'g']);
    expect((await backend.tree('demo', one, 'dir/deep'))?.map((entry) => entry.name)).toEqual(['h']);
  });

  it('returns a blob’s exact bytes', async () => {
    expect(await backend.blob('demo', 'task/a', 'bin')).toEqual(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]));
    expect(await backend.blob('demo', one, 'dir/deep/h')).toEqual(Buffer.from('deeper\n'));
  });

  it('answers null for anything absent, and never for a failure', async () => {
    expect(await backend.blob('demo', 'main', 'missing')).toBeNull();
    expect(await backend.blob('demo', 'main', 'dir')).toBeNull();
    expect(await backend.blob('demo', 'nope', 'f')).toBeNull();
    expect(await backend.blob('demo', 'd'.repeat(40), 'f')).toBeNull();
    expect(await backend.blob('absent', 'main', 'f')).toBeNull();
    expect(await backend.tree('demo', 'main', 'missing')).toBeNull();
    expect(await backend.tree('demo', 'main', 'f')).toBeNull();
    expect(await backend.tree('demo', 'nope')).toBeNull();

    // A repository git cannot read is a failure, not an absence.
    await rm(join(repoPath('demo'), 'HEAD'));
    await expect(backend.blob('demo', one, 'f')).rejects.toBeInstanceOf(GitBackendError);
  });

  it('carries git’s stderr in a failure', async () => {
    await rm(join(repoPath('demo'), 'objects'), { recursive: true });
    const error = await backend.listBranches('demo').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitBackendError);
    expect((error as Error).message).toMatch(/not a git repository|fatal/);
  });
});

describe('insulation from the host and from the repository', () => {
  let hostile: string;
  let markers: string;

  beforeEach(async () => {
    markers = join(scratch, `markers-${++counter}`);
    const hooks = join(markers, 'hooks');
    await mkdir(hooks, { recursive: true });
    for (const hook of ['reference-transaction', 'pre-receive', 'post-update']) {
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch ${join(markers, `hook-${hook}`)}\n`);
      await chmod(join(hooks, hook), 0o755);
    }
    const driver = await script('merge-driver', `touch ${join(markers, 'merge-driver')}\ncp "$2" "$1"`);
    const textconv = await script('textconv', `touch ${join(markers, 'textconv')}\ncat "$1"`);
    hostile = join(markers, 'hostile.gitconfig');
    await writeFile(
      hostile,
      [
        '[diff]',
        '\tnoprefix = true',
        '[core]',
        `\thooksPath = ${hooks}`,
        '[attr]',
        // A bare repository reads no in-tree attributes unless this is set, so without it the
        // driver and textconv below could never fire and the tests about them would be empty.
        '\ttree = refs/heads/main',
        '[merge "evil"]',
        `\tdriver = ${driver} %A %B`,
        '[diff "evil"]',
        `\ttextconv = ${textconv}`,
        '',
      ].join('\n'),
    );

    await backend.create('demo');
    const work = await workspace();
    const base = await commit(work, { '.gitattributes': '* merge=evil diff=evil\n', f: 'base\n' });
    await push('demo', work, 'main');
    await git(work, 'checkout', '--quiet', '-b', 'side');
    await commit(work, { f: 'side\n' });
    await push('demo', work, 'side');
    await git(work, 'checkout', '--quiet', 'main');
    await git(work, 'reset', '--quiet', '--hard', base);
    await commit(work, { f: 'main\n' });
    await push('demo', work, 'main');
    await rm(markers + '/hook-reference-transaction', { force: true });
  });

  async function fired(): Promise<string[]> {
    return (await readdir(markers)).filter((name) => name !== 'hooks' && !name.endsWith('.gitconfig'));
  }

  it('control: the hostile config really does fire through plain git', async () => {
    const env = { ...fixtureEnv(), GIT_CONFIG_GLOBAL: hostile };
    const repo = repoPath('demo');
    const diff = await run('git', ['--git-dir', repo, 'diff', '--textconv', 'main', 'side'], { env });
    expect(diff.stdout).toContain('diff --git f f');
    await run('git', ['--git-dir', repo, 'merge-tree', '--write-tree', 'main', 'side'], { env });
    await run('git', ['--git-dir', repo, 'update-ref', 'refs/heads/scratch', 'main'], { env });
    expect((await fired()).sort()).toEqual(['hook-reference-transaction', 'merge-driver', 'textconv']);
  });

  it('ignores a hostile global config and an inherited GIT_DIR', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostile);
    vi.stubEnv('GIT_DIR', join(scratch, 'elsewhere.git'));
    vi.stubEnv('GIT_EXTERNAL_DIFF', join(markers, 'nonexistent-external-diff'));
    try {
      const insulated = await GitBackend.open(root);
      const diff = await insulated.diff('demo', 'main', 'side');
      expect(diff).toContain('diff --git a/f b/f');
      expect(diff).toContain('-main\n+side\n');

      const result = await insulated.merge('demo', 'side', 'main', { author: jen, committer: jen, message: 'm' });
      // With the driver it would have merged clean, taking `side`'s side. Without it, git's own
      // three-way merge sees both sides change one line.
      expect(result).toMatchObject({ kind: 'conflict', paths: ['f'] });

      const [main] = await insulated.listBranches('demo');
      await insulated.createBranch('demo', 'hooked', main!.sha);
      await insulated.moveBranch('demo', 'hooked', main!.sha, main!.sha);
      await insulated.deleteBranch('demo', 'hooked', main!.sha);
      await insulated.bundle('demo', 'side', join(markers, 'out.bundle'));
      await insulated.importBundle('demo', join(markers, 'out.bundle'));

      expect(await fired()).toEqual(['out.bundle']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('hooks inside a repository', () => {
  it('never runs one, even where git would look for it by default', async () => {
    // Global config is already out of the picture, so this is the one thing `core.hooksPath`
    // is for: a hook that lands in the repository's own directory.
    await backend.create('demo');
    const marker = join(scratch, `repo-hook-${++counter}`);
    const hook = join(repoPath('demo'), 'hooks', 'reference-transaction');
    await mkdir(join(hook, '..'), { recursive: true });
    await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(hook, 0o755);

    // Control: plain git runs it.
    await run('git', ['--git-dir', repoPath('demo'), 'update-ref', 'refs/heads/probe', await emptyCommit('demo')], { env: fixtureEnv() });
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    const [probe] = await backend.listBranches('demo');
    await backend.moveBranch('demo', 'probe', probe!.sha, probe!.sha);
    await backend.deleteBranch('demo', 'probe', probe!.sha);
    expect(await exists(marker)).toBe(false);
  });

  async function emptyCommit(project: string): Promise<string> {
    const { stdout } = await run(
      'sh',
      ['-c', `git --git-dir=${repoPath(project)} commit-tree -m probe $(git --git-dir=${repoPath(project)} mktree </dev/null)`],
      { env: fixtureEnv() },
    );
    return stdout.trim();
  }
});

describe('the backend stays on the supervisor’s side', () => {
  it('depends on nothing but node built-ins, and on none that open a socket', async () => {
    // There is no server here, and this is what keeps there from quietly being one.
    const source = await readFile(join(import.meta.dirname, 'index.ts'), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^node:/);
      expect(specifier).not.toMatch(/^node:(net|http|https|http2|tls|dgram)$/);
    }
  });
});
