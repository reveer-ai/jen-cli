import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { SKILLS, stagedFiles } from '../cli/payload.js';
import { readRepoFile, run } from './helpers.js';

const manifest = JSON.parse(readRepoFile('package.json')) as {
  name: string;
  type: string;
  license: string;
  keywords: string[];
  bin: Record<string, string>;
  files: string[];
  publishConfig: { access: string };
  engines: { node: string };
  repository: { type: string; url: string };
  dependencies: Record<string, string>;
};

describe('package.json', () => {
  it('declares a publishable scoped package', () => {
    expect(manifest.name).toBe('@reveer/jen');
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig.access).toBe('public');
    expect(manifest.engines.node).toMatch(/^>=\d+\.\d+\.\d+$/);
  });

  it('maps the bare command jen to the built CLI entry', () => {
    expect(Object.keys(manifest.bin)).toEqual(['jen']);
    expect(manifest.bin.jen).toBe('dist/index.js');
  });

  it('ships dist and nothing else', () => {
    expect(manifest.files).toEqual(['dist']);
  });

  it('depends on OpenSpec rather than vendoring it', () => {
    expect(Object.keys(manifest.dependencies)).toContain('@fission-ai/openspec');
  });

  // Load-bearing rather than decorative: trusted publishing matches the registry's record
  // of the package against the repository publishing it, and npm's own `git+https://`
  // form does not match. A cleanup that "normalizes" this back breaks the release with a
  // 404 that reads as though the package does not exist.
  it('names its source repository in the form the OIDC exchange matches', () => {
    expect(manifest.repository.url).toBe('https://github.com/reveer-ai/jen-cli.git');
    expect(manifest.repository.url.startsWith('git+')).toBe(false);
  });

  // `UNLICENSED` is the value being guarded against specifically, not just any absent
  // one: it states that no rights are granted, of a package anyone can already download
  // without authenticating.
  it('declares a license granting rights to the package anyone can download', () => {
    expect(manifest.license).toBeTypeOf('string');
    expect(manifest.license).not.toBe('UNLICENSED');
    expect(manifest.license, 'license is not an SPDX identifier').toMatch(/^[A-Za-z0-9.+-]+$/);
  });

  it('is discoverable by search rather than only by its exact name', () => {
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.keywords.length).toBeGreaterThan(0);
  });

  it('carries the license file the manifest declares', () => {
    const license = readRepoFile('LICENSE');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0');
    expect(manifest.license).toBe('Apache-2.0');
  });
});

describe('the packed tarball', () => {
  let contents: string[];

  beforeAll(() => {
    const destination = mkdtempSync(join(tmpdir(), 'jen-pack-'));
    run('npm', ['pack', '--pack-destination', destination]);
    const tarball = readdirSync(destination).find((entry) => entry.endsWith('.tgz'));
    expect(tarball, 'npm pack produced no tarball').toBeDefined();

    contents = run('tar', ['-tzf', join(destination, tarball!)])
      .split('\n')
      .filter(Boolean)
      // npm prefixes every entry with `package/`
      .map((path) => path.replace(/^package\//, ''))
      .filter((path) => !path.endsWith('/'));
  });

  it('carries the compiled CLI entry and all of the staged payload', () => {
    expect(contents).toContain('dist/index.js');
    for (const { file } of stagedFiles()) {
      expect(contents).toContain(`dist/templates/${file.staged}`);
    }
  });

  // Both directions, because each catches a different mistake: a skill the payload gained
  // but `files`/staging never reached, and a skill dropped from the payload whose staged
  // directory survived in a stale `dist/` and shipped anyway.
  it('carries one skill directory per shipped skill and no others', () => {
    const shipped = contents.filter((path) => path.startsWith('dist/templates/skills/'));
    expect(new Set(shipped.map((path) => path.split('/')[3]))).toEqual(new Set(SKILLS));
    expect(shipped).toHaveLength(SKILLS.length);
  });

  // The registry adds these regardless of `files`, which is exactly why they are asserted
  // here: nothing in the manifest selects them, so nothing in the manifest can be read as
  // keeping them. The assertion is what stops a later `files` change from being trusted to
  // control what ships, and it is what makes the front page and the license grant reaching
  // the adopter a checked fact rather than a documented npm behaviour.
  it('carries the front page and the license, which `files` names neither of', () => {
    expect(contents).toContain('README.md');
    expect(contents).toContain('LICENSE');
  });

  it('names no assistant in the staged tree it ships', () => {
    const assistantDirs = ['.claude', '.github', '.codex', '.opencode', '.cursor', '.agents'];
    for (const path of contents.filter((entry) => entry.startsWith('dist/templates/'))) {
      for (const segment of path.split('/')) {
        expect(assistantDirs, `${path} names an assistant`).not.toContain(segment);
      }
    }
  });

  it('carries no TypeScript source and no test file', () => {
    for (const path of contents) {
      expect(path, `${path} is a TypeScript source`).not.toMatch(/\.tsx?$/);
      expect(path, `${path} is a test file`).not.toMatch(/(^|\/)test(s)?\//);
      expect(path, `${path} is a test file`).not.toMatch(/\.(test|spec)\./);
    }
  });

  it('carries nothing from the repository the package is built in', () => {
    for (const path of contents) {
      expect(path, `${path} leaks a repository path`).not.toMatch(/^(\.claude|openspec|src|scripts)\//);
    }
  });

  it('carries no OpenSpec-generated skill or command', () => {
    for (const path of contents) {
      expect(path, `${path} is a vendored OpenSpec artifact`).not.toMatch(/openspec-/);
      expect(basename(path), `${path} is an opsx command`).not.toMatch(/^opsx/);
      expect(path).not.toMatch(/(^|\/)opsx\//);
    }
  });
});
