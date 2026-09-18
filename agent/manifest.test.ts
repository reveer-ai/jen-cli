/**
 * The substrate's manifest, and the boundary it exists to keep real.
 *
 * The substrate is excluded from the repository's published package, and that exclusion is
 * only worth anything if it extends to what the substrate *depends on*. A dependency of
 * the substrate's declared at the repository root would be installed by everyone who
 * installs the CLI, to support code the package does not contain.
 *
 * Nothing here needs a network or a container runtime. It reads two manifests and asks npm
 * what it would pack.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

interface Manifest {
  files?: string[];
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Manifest;
}

const substrate = manifest('agent/package.json');
const repository = manifest('package.json');

describe('the substrate declares its own dependencies', () => {
  it('declares at least one, which is what warrants a manifest at all', () => {
    expect(Object.keys(substrate.dependencies ?? {}).length).toBeGreaterThan(0);
  });

  // Nothing automated runs the substrate's tests, so a range would be widened by an
  // install nobody watched and caught by nobody either. An exact version is the only
  // pinning that does not depend on a check that is not running.
  it('pins every one of them exactly', () => {
    for (const [name, version] of Object.entries(substrate.dependencies ?? {})) {
      expect(version, `${name} is not pinned to an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  // The tooling is deliberately not redeclared: the repository already carries the compiler
  // and the test runner, and a second copy at a second version is two things to keep in
  // step for no gain. Only what the substrate's *code* imports belongs here.
  it('redeclares none of the tooling the repository already carries', () => {
    const declared = Object.keys({ ...substrate.dependencies, ...substrate.devDependencies });
    expect(declared).not.toContain('typescript');
    expect(declared).not.toContain('vitest');
    expect(declared).not.toContain('@types/node');
  });
});

describe('nothing the substrate needs reaches the repository', () => {
  it('leaves the repository’s dependency sets free of them', () => {
    const carried = Object.keys({ ...repository.dependencies, ...repository.devDependencies });
    for (const name of Object.keys(substrate.dependencies ?? {})) {
      expect(carried, `${name} reached the repository's manifest`).not.toContain(name);
    }
  });

  it('leaves the repository shipping dist and nothing else', () => {
    expect(repository.files).toEqual(['dist']);
  });
});

describe('the published package carries no path under the substrate', () => {
  // `--ignore-scripts` so this does not run the repository's `prepack`, which builds and
  // stages into `dist/`. What is under test is which paths npm *selects*, and that is
  // decided by `files` rather than by what happens to be built — the contents of `dist/`
  // are the repository's own suite's business.
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  ) as [{ files: { path: string }[] }];

  const paths = (packed[0]?.files ?? []).map((file) => file.path);

  it('selects something, so the absence below is not vacuous', () => {
    expect(paths).toContain('package.json');
  });

  it('selects nothing under agent/', () => {
    expect(paths.filter((path) => path === 'agent' || path.startsWith('agent/'))).toEqual([]);
  });

  it('selects no manifest but the repository’s own', () => {
    expect(paths.filter((path) => path.endsWith('package.json'))).toEqual(['package.json']);
  });
});

describe('the substrate declares its own entry points', () => {
  /**
   * Two, and each is an executable of the substrate's own.
   *
   * `jen-agent` is what a sandbox runs to become an agent. `jen-operator` is what a person
   * runs to start a tree and talk to its root, and it is declared here rather than added to
   * the repository's CLI for the same reason the first one is: `cli/` may not import
   * `agent/`, so a subcommand would have to reach across the boundary `agent-substrate`
   * draws, and the substrate is installed into an agent's image rather than delivered
   * through the CLI's published package.
   */
  it('names executables of its own', () => {
    expect(Object.keys(substrate.bin ?? {})).toEqual(['jen-agent', 'jen-operator']);
  });

  it('points each at a file that is there', () => {
    for (const [name, path] of Object.entries(substrate.bin ?? {})) {
      expect(existsSync(join(ROOT, 'agent', path)), `${name} points at ${path}, which is not there`).toBe(true);
    }
  });

  it('does not declare either as a subcommand of the repository’s CLI', () => {
    expect(Object.keys(repository.bin ?? {})).toEqual(['jen']);
  });
});

/**
 * The assistant belongs to the image, and the manifest is where that is checked.
 *
 * `agent-workspace-tools` requires that no part of the substrate name a particular
 * assistant — one is reached as an ordinary command, and nothing in the substrate
 * distinguishes it from any other program. A dependency entry here would be the substrate
 * naming one in the plainest possible way, and it would make replacing the assistant a
 * change to the substrate rather than a change to an environment.
 *
 * The image installs it instead, which is what keeps the choice reversible: replacing the
 * assistant, or providing none, is a change to `agent/Dockerfile` and to no source at all.
 * Read from the Dockerfile rather than assumed, so that this fails if the two ever swap.
 */
describe('a coding assistant is the image’s and never the manifest’s', () => {
  const dockerfile = readFileSync(join(ROOT, 'agent', 'Dockerfile'), 'utf8');

  it('names none among the substrate’s dependencies', () => {
    const declared = Object.keys({ ...substrate.dependencies, ...substrate.devDependencies });
    for (const name of declared) {
      expect(name, `${name} reads as a coding assistant declared by the substrate`).not.toMatch(
        /claude|codex|copilot|cursor|aider|gemini-cli|opencode/i,
      );
    }
  });

  it('installs one from the image definition, at an exact version', () => {
    // The image is allowed to name one, which is the whole of the arrangement — so this
    // asserts that it does, and that it pins it. An unpinned assistant would change what
    // every agent's environment carries with nothing in the repository changing.
    expect(dockerfile).toMatch(/npm install -g \S+@\d+\.\d+\.\d+/);
  });

  it('pins everything else it installs too', () => {
    const base = /^FROM\s+(\S+)/m.exec(dockerfile)?.[1] ?? '';
    expect(base, 'the image\u2019s base names no exact version').toMatch(/:\d+\.\d+\.\d+/);
    expect(base, 'the image\u2019s base resolves to whatever is newest at build time').not.toMatch(/:latest$/);
  });
});
