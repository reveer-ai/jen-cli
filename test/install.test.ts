import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { run, type Io } from '../cli/cli.js';
import { payloadFiles, SCAFFOLD, SKILLS } from '../cli/payload.js';
import { hasStamp } from '../cli/stamp.js';
import { changed, link, messyProject, neighbours, project, snapshot, stamped, touched, writeProject } from './fixture.js';
import { stageInto } from './helpers.js';

let staged: string;

beforeAll(() => {
  staged = stageInto('install');
});

interface Capture {
  io: Io;
  out: string[];
  err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function jen(argv: string[], projectRoot: string): Capture & { code: number } {
  const captured = capture();
  const code = run([...argv, projectRoot], captured.io, { templates: staged });
  return { ...captured, code };
}

function shipped(stagedPath: string): string {
  return readFileSync(join(staged, stagedPath), 'utf8');
}

describe('jen init on an empty project', () => {
  let root: string;
  let result: ReturnType<typeof jen>;

  beforeAll(() => {
    root = project({}, 'fresh');
    result = jen(['init'], root);
  });

  it('exits zero', () => {
    expect(result.code, result.err.join('\n')).toBe(0);
  });

  // Every managed file, with no exception for one carrying values resolved at write time:
  // jen writes what it staged, and a project's own values live in its registry rather than
  // in a file jen rendered.
  it('writes every managed file, byte-identical to what the package staged', () => {
    for (const { file } of payloadFiles()) {
      expect(readFileSync(join(root, file.target), 'utf8'), file.target).toBe(shipped(file.staged));
    }
  });

  it('writes each shipped skill stamped, into .claude/skills/', () => {
    for (const name of SKILLS) {
      const path = join(root, '.claude/skills', name, 'SKILL.md');
      expect(existsSync(path), path).toBe(true);
      expect(hasStamp(readFileSync(path, 'utf8')), `${name} must be recognisable as jen's`).toBe(true);
    }
  });

  it('creates the scaffold, and the registry stub reads as unfilled', () => {
    for (const file of SCAFFOLD) {
      expect(existsSync(join(root, file.target)), file.target).toBe(true);
    }
    expect(readFileSync(join(root, 'registry.yaml'), 'utf8')).toContain('resources: []');
    expect(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))).toHaveProperty('permissions');
  });

  it('initializes OpenSpec', () => {
    expect(existsSync(join(root, 'openspec/config.yaml'))).toBe(true);
    expect(result.out.join('\n')).toContain('OpenSpec initialized');
  });

  it('reports OpenSpec being unreachable from the project itself', () => {
    expect(result.err.join('\n')).toContain('npm i -D @reveer/jen');
  });

  it('writes no state file recording what it did', () => {
    const paths = [...snapshot(root).keys()];
    expect(paths.filter((path) => /manifest|\.jen/.test(path))).toEqual([]);
  });
});

describe('jen init on a project that already has content', () => {
  it('refuses, names the file, and leaves the tree byte-identical', () => {
    const root = messyProject(staged);
    const before = snapshot(root);

    const result = jen(['init'], root);

    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('AGENTS.md');
    expect(result.err.join('\n')).toMatch(/migration/i);
    expect(changed(before, snapshot(root))).toEqual([]);
  });

  it('writes no skill and no scaffold before detecting the conflict', () => {
    const root = messyProject(staged);
    jen(['init'], root);

    expect(existsSync(join(root, '.claude/skills/refine-epic/SKILL.md'))).toBe(false);
    expect(existsSync(join(root, '.claude/skills/legacy-stage/SKILL.md'))).toBe(true);
  });

  it('proceeds when the fixed path is already identical', () => {
    const root = project({ 'AGENTS.md': shipped('AGENTS.md'), 'openspec/config.yaml': 'schema: spec-driven\n' }, 'identical');
    const result = jen(['init'], root);

    expect(result.code, result.err.join('\n')).toBe(0);
    expect(existsSync(join(root, '.claude/skills/design-task/SKILL.md'))).toBe(true);
  });

  it('overwrites the fixed path under --force, and still leaves the scaffold alone', () => {
    const root = messyProject(staged);
    const registry = readFileSync(join(root, 'registry.yaml'), 'utf8');
    const settings = readFileSync(join(root, '.claude/settings.json'), 'utf8');

    const result = jen(['init', '--force'], root);

    expect(result.code, result.err.join('\n')).toBe(0);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(shipped('AGENTS.md'));
    expect(readFileSync(join(root, 'registry.yaml'), 'utf8')).toBe(registry);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
  });

  it('leaves an initialized project\'s OpenSpec configuration and package manifest untouched', () => {
    const root = messyProject(staged);
    const config = readFileSync(join(root, 'openspec/config.yaml'), 'utf8');
    const manifest = readFileSync(join(root, 'package.json'), 'utf8');

    const result = jen(['init', '--force'], root);

    expect(readFileSync(join(root, 'openspec/config.yaml'), 'utf8')).toBe(config);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
    expect(result.out.join('\n')).toContain('already initialized');
  });
});

describe('jen update on a project that has diverged', () => {
  let root: string;
  let result: ReturnType<typeof jen>;

  beforeAll(() => {
    root = messyProject(staged);
    result = jen(['update'], root);
  });

  it('exits zero', () => {
    expect(result.code, result.err.join('\n')).toBe(0);
  });

  it('restores a hand-edited managed file', () => {
    expect(readFileSync(join(root, '.claude/skills/design-task/SKILL.md'), 'utf8')).toBe(
      shipped('skills/design-task/SKILL.md'),
    );
  });

  it('removes a stamped skill this version no longer ships', () => {
    expect(existsSync(join(root, '.claude/skills/legacy-stage/SKILL.md'))).toBe(false);
    expect(result.out.join('\n')).toContain('.claude/skills/legacy-stage/SKILL.md');
  });

  it('leaves the project\'s own skill alone', () => {
    expect(readFileSync(join(root, '.claude/skills/deploy-service/SKILL.md'), 'utf8')).toContain('deploy-service');
    expect(hasStamp(readFileSync(join(root, '.claude/skills/deploy-service/SKILL.md'), 'utf8'))).toBe(false);
  });

  it('leaves a claimed copy alone — the stamp is gone, so the file is the project\'s', () => {
    const copy = readFileSync(join(root, '.claude/skills/design-task-copy/SKILL.md'), 'utf8');
    expect(existsSync(join(root, '.claude/skills/design-task-copy/SKILL.md'))).toBe(true);
    expect(hasStamp(copy)).toBe(false);
    expect(copy).not.toBe(shipped('skills/design-task/SKILL.md'));
  });

  it('leaves stamped files outside the set\'s reach alone', () => {
    expect(existsSync(join(root, 'docs/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/team/nested/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/notes/README.md'))).toBe(true);
  });

  it('owns AGENTS.md wholesale once the project has adopted', () => {
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(shipped('AGENTS.md'));
  });

  it('leaves the project\'s own files — sources, manifest, notes below src/, .gitignore', () => {
    expect(readFileSync(join(root, 'src/app.ts'), 'utf8')).toBe('export const app = 1;\n');
    expect(readFileSync(join(root, 'src/api/AGENTS.md'), 'utf8')).toContain('API notes');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('adopter');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('changes nothing beyond the managed and scaffold paths', () => {
    const fresh = messyProject(staged);
    const before = snapshot(fresh);
    jen(['update'], fresh);

    // Scaffold paths are deliberately absent: `update` may not write them either.
    const managed = new Set([
      ...payloadFiles().map(({ file }) => file.target),
      '.claude/skills/legacy-stage/SKILL.md',
    ]);
    for (const path of changed(before, snapshot(fresh))) {
      expect(managed, `${path} is outside the managed set`).toContain(path);
    }
  });
});

describe('jen update without a prior init', () => {
  it('writes the payload and exits zero, with no missing-installation error', () => {
    const root = project({}, 'never-init');
    const result = jen(['update'], root);

    expect(result.code, result.err.join('\n')).toBe(0);
    expect(existsSync(join(root, '.claude/skills/design-task/SKILL.md'))).toBe(true);
    expect(result.err.join('\n')).not.toMatch(/not initialized|missing installation|run .*init/i);
  });

  it('does not write the scaffold, or recreate one that was deleted', () => {
    const root = project({}, 'no-scaffold');
    jen(['init'], root);
    rmSync(join(root, 'registry.yaml'));

    jen(['update'], root);

    expect(existsSync(join(root, 'registry.yaml'))).toBe(false);
  });

  it('does not initialize OpenSpec', () => {
    const root = project({}, 'update-openspec');
    jen(['update'], root);

    expect(existsSync(join(root, 'openspec'))).toBe(false);
  });
});

describe('running twice', () => {
  it('leaves init with nothing to do, down to the modification times', () => {
    const root = project({ 'openspec/config.yaml': 'schema: spec-driven\n' }, 'twice-init');
    jen(['init'], root);

    const before = snapshot(root);
    const second = jen(['init'], root);

    expect(second.code, second.err.join('\n')).toBe(0);
    expect(second.out.join('\n')).toContain('nothing to do');
    expect(touched(before, snapshot(root))).toEqual([]);
  });

  it('leaves update with nothing to do, down to the modification times', () => {
    const root = messyProject(staged);
    jen(['update'], root);

    const before = snapshot(root);
    const second = jen(['update'], root);

    expect(second.code, second.err.join('\n')).toBe(0);
    expect(second.out.join('\n')).toContain('nothing to do');
    expect(touched(before, snapshot(root))).toEqual([]);
  });
});

describe('the project boundary', () => {
  it('replaces an AGENTS.md symlinked to the project\'s own CLAUDE.md, leaving that file alone', () => {
    // The convention adopters actually use, and jen's own repository carries the mirror
    // image of it. Following the link would replace the project's CLAUDE.md wholesale.
    const root = project({ 'CLAUDE.md': '# How we work here\n' }, 'claude-link');
    link(root, 'AGENTS.md', 'CLAUDE.md');

    const result = jen(['update'], root);

    expect(result.code, result.err.join('\n')).toBe(0);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# How we work here\n');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(shipped('AGENTS.md'));
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(result.out.join('\n')).toContain('AGENTS.md was a symlink');
  });

  it('does not write through a managed path symlinked outside the project', () => {
    const { root, outside } = neighbours('link-out', {}, { 'notes.md': 'Belongs to nobody here.\n' });
    link(root, 'AGENTS.md', join(outside, 'notes.md'));

    const result = jen(['update'], root);

    expect(result.code, result.err.join('\n')).toBe(0);
    expect(readFileSync(join(outside, 'notes.md'), 'utf8')).toBe('Belongs to nobody here.\n');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(shipped('AGENTS.md'));
  });

  it('does not create a file outside the project through a dangling symlink', () => {
    // `existsSync` follows the dead link and answers false, so an existence-based guard
    // never sees the conflict at all — the refusal has to be blind to nothing.
    const { root, outside } = neighbours('dangling-out');
    link(root, 'AGENTS.md', join(outside, 'never-created.md'));

    const result = jen(['init'], root);

    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('AGENTS.md');
    expect(existsSync(join(outside, 'never-created.md'))).toBe(false);
  });

  it('refuses when a symlinked directory stands between the root and a managed path', () => {
    const { root, outside } = neighbours(
      'link-dir',
      { 'openspec/config.yaml': 'schema: spec-driven\n' },
      { 'skills/legacy-stage/SKILL.md': stamped('legacy-stage') },
    );
    link(root, '.claude/skills', join(outside, 'skills'));

    const result = jen(['update'], root);

    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/symlink/i);
    expect(result.err.join('\n')).toContain('.claude/skills');

    // nothing written into the linked directory, and nothing deleted out of it
    expect(existsSync(join(outside, 'skills/design-task/SKILL.md'))).toBe(false);
    expect(existsSync(join(outside, 'skills/legacy-stage/SKILL.md'))).toBe(true);
    // and not a partial install of the paths it could have reached
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  it('will not let --force write through a symlinked directory either', () => {
    const { root, outside } = neighbours('link-dir-force');
    link(root, '.claude', join(outside, 'dotclaude'));

    const result = jen(['init', '--force'], root);

    expect(result.code).toBe(1);
    expect(existsSync(join(outside, 'dotclaude/skills'))).toBe(false);
  });
});

describe('the ignore check', () => {
  it('reports a managed path the project excludes, and writes it anyway', () => {
    const root = project({ '.gitignore': '.claude/\n' }, 'ignored');
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });

    const result = jen(['update'], root);

    expect(result.code).toBe(0);
    expect(result.err.join('\n')).toContain('.claude/skills/design-task/SKILL.md');
    expect(result.err.join('\n')).toMatch(/ignore/i);
    expect(existsSync(join(root, '.claude/skills/design-task/SKILL.md'))).toBe(true);
  });

  it('leaves the ignore file itself alone', () => {
    const root = project({ '.gitignore': 'node_modules/\n' }, 'gitignore');
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });

    jen(['update'], root);

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('says nothing when the project is not a repository', () => {
    const root = project({ '.gitignore': '.claude/\n' }, 'no-repo');
    const result = jen(['update'], root);

    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
  });
});

describe('argument handling', () => {
  it('defaults the project to the working directory', () => {
    const root = project({}, 'cwd');
    const captured = capture();

    expect(run(['update'], captured.io, { templates: staged, cwd: root })).toBe(0);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });

  it('rejects a second project path', () => {
    const captured = capture();
    expect(run(['update', 'one', 'two'], captured.io, { templates: staged })).toBe(1);
    expect(captured.err.join('\n')).toContain('one');
  });

  it('rejects --force on update, which has no adoption to force', () => {
    const captured = capture();
    expect(run(['update', '--force'], captured.io, { templates: staged })).toBe(1);
    expect(captured.err.join('\n')).toContain('--force');
  });

  it('rejects an unknown option', () => {
    const captured = capture();
    expect(run(['init', '--dry-run'], captured.io, { templates: staged })).toBe(1);
    expect(captured.err.join('\n')).toContain('--dry-run');
  });
});

describe('a failing write', () => {
  it('reports what it completed, then exits non-zero without rolling back', () => {
    // A directory where a managed file has to go: the write fails, and everything
    // written before it stays.
    const root = writeProject(project({}, 'blocked'), {
      '.claude/skills/review-task/SKILL.md/placeholder': 'in the way\n',
    });

    const result = jen(['update'], root);

    expect(result.code).toBe(1);
    expect(result.out.join('\n')).toContain('AGENTS.md');
    expect(result.err.join('\n')).toContain('.claude/skills/review-task/SKILL.md');
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });
});
