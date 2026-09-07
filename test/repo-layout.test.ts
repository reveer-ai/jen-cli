import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { payloadFiles, stagedFiles, SKILLS } from '../cli/payload.js';
import { frontmatterKeys, frontmatterOf, readRepoFile, repoRoot, run, trackedFiles } from './helpers.js';

const tracked = trackedFiles();

function isIgnored(path: string): boolean {
  try {
    run('git', ['check-ignore', '-q', '--no-index', path]);
    return true;
  } catch {
    return false;
  }
}

describe('the repository layout', () => {
  it('keeps jen\'s own source at cli/, never under src/', () => {
    expect(tracked.some((path) => path.startsWith('cli/'))).toBe(true);
    expect(tracked.filter((path) => path.startsWith('src/'))).toEqual([]);
  });

  it('tracks no build output', () => {
    expect(tracked.filter((path) => path.startsWith('dist/'))).toEqual([]);
    expect(tracked.filter((path) => path.startsWith('node_modules/'))).toEqual([]);
  });

  it('has no vendored OpenSpec artifacts', () => {
    expect(tracked.filter((path) => path.startsWith('.claude/skills/openspec-'))).toEqual([]);
    expect(tracked.filter((path) => path.startsWith('.claude/commands/opsx/'))).toEqual([]);
  });

  it('keeps a local `openspec init` from re-vendoring them', () => {
    expect(isIgnored('.claude/skills/openspec-explore/SKILL.md')).toBe(true);
    expect(isIgnored('.claude/commands/opsx/apply.md')).toBe(true);
  });

  it('tracks the OpenSpec config that `openspec init` writes', () => {
    // `prepare` rewrites this on every install, so asserting it is merely un-ignored
    // passes while the file sits outside git — which leaves every clone permanently dirty.
    expect(tracked).toContain('openspec/config.yaml');
  });

  // `openspec/AGENTS.md` is OpenSpec's own path and `openspec init` deletes it. That runs as
  // `prepare`, which npm fires on the `npm pack` in `package.test.ts` — so `npm test` removes
  // an untracked note there, before the commit that would have saved it. ENG-190 lost this
  // exact note that way: the suite passed, `git status` was clean, and the session reported a
  // file that no longer existed. Nothing about it is visible after the fact, which is why the
  // guard is here rather than left to whoever repeats it.
  it('keeps the change-authoring notes where `openspec init` will not delete them', () => {
    expect(tracked).toContain('openspec/changes/AGENTS.md');
    expect(tracked).not.toContain('openspec/AGENTS.md');
  });

  // jen is its own project, so a stage session reads this file the way an adopted repository's
  // session reads its own. An entry here resolves at step 1, before the classifier — so a grant
  // is a bypass jen's pipeline has and no adopter does, which is why ENG-190 had a human empty
  // it. Nothing else would notice one going back in: the file is not in the payload, no other
  // test reads it, and the calls it exempts succeed either way — they just stop being judged.
  // `cli/AGENTS.md` sends a contributor to `.claude/settings.local.json` instead; this is the
  // half of that a note cannot enforce.
  it('grants nothing in jen\'s own assistant settings', () => {
    expect(tracked, 'the file is tracked, for the reason the repo-scaffold spec gives').toContain('.claude/settings.json');

    const permissions = JSON.parse(readRepoFile('.claude/settings.json')).permissions;
    expect(permissions, 'the permissions object stays as the seat, as it does in the scaffold').toBeDefined();
    expect(permissions.allow, 'a contributor\'s own grants belong in .claude/settings.local.json').toEqual([]);
  });
});

describe('.gitignore', () => {
  const rules = readRepoFile('.gitignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  it('is a conventional ignore file, not a default-deny allowlist', () => {
    expect(rules).not.toContain('*');
    expect(rules.filter((rule) => rule.startsWith('!'))).toEqual([]);
  });

  it('admits a new source file with no allowlist edit', () => {
    expect(isIgnored('cli/whatever.ts')).toBe(false);
    expect(isIgnored('openspec/changes/some-change/proposal.md')).toBe(false);
  });

  it('ignores build output, dependencies, and local agent scratch', () => {
    expect(isIgnored('dist/index.js')).toBe(true);
    expect(isIgnored('node_modules/anything/index.js')).toBe(true);
    expect(isIgnored('src/anything.ts')).toBe(true);
    expect(isIgnored('.claude/worktrees/some-tree/.git/config')).toBe(true);
    expect(isIgnored('.claude/settings.local.json')).toBe(true);
  });

  it('keeps every shipped path trackable', () => {
    for (const { file } of stagedFiles()) {
      expect(isIgnored(file.source), `${file.source} ships to projects and must be trackable`).toBe(false);
    }
  });
});

describe('a fresh clone', () => {
  it('has every shipped skill present, tracked, and valid', () => {
    for (const name of SKILLS) {
      const path = `.claude/skills/${name}/SKILL.md`;
      expect(existsSync(join(repoRoot, path)), `${path} is missing`).toBe(true);
      expect(tracked, `${path} is untracked`).toContain(path);

      const frontmatter = frontmatterOf(readRepoFile(path));
      expect(frontmatter, `${path} has no frontmatter`).not.toBeNull();

      const keys = frontmatterKeys(frontmatter!);
      expect(keys.name).toBe(name);
      expect(keys.description).toBeTruthy();
    }
  });

  it('holds unstamped working copies — jen is not a managed install', () => {
    for (const { file } of payloadFiles()) {
      expect(readRepoFile(file.source), `${file.source} must not carry the stamp`).not.toContain('jen: true');
    }
    expect(existsSync(join(repoRoot, '.jen'))).toBe(false);
  });

  it('ships an AGENTS.md with no marker syntax', () => {
    expect(readRepoFile('AGENTS.md')).not.toMatch(/JEN:(START|END)/);
  });
});
