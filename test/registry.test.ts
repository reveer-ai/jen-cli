import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { readRepoFile, trackedFiles } from './helpers.js';

type Resource = Record<string, unknown> & { name?: string; kind?: string };

const stub = readRepoFile('scaffold/registry.yaml');
const registry = readRepoFile('registry.yaml');
const resources = (parse(registry) as { resources: Resource[] }).resources;

describe('the registry stub', () => {
  it('documents the entry shape', () => {
    // Filled in by hand, so the shape has to be legible from the file itself.
    expect(stub).toContain('kind: repository');
    expect(stub).toContain('kind: project-management');
  });

  it('still reads as unfilled', () => {
    // Documenting the shape must not accidentally declare an entry. `jen init` writes this
    // file once and never returns to it, so a stray entry here is permanent in every
    // project installed afterward.
    expect(stub).toContain('resources: []');
    expect((parse(stub) as { resources: unknown[] }).resources).toEqual([]);
  });

  it('says where credentials do not go', () => {
    expect(stub).toMatch(/never authenticates|no private key/i);
  });
});

describe("jen's own registry", () => {
  it('keeps the stub\'s documenting comments', () => {
    // Recorded by editing the `resources:` entry in place. A YAML round-trip would strip
    // every comment here and reformat what it kept, which is most of the file's value.
    expect(registry).toContain('# Every resource this project\'s workflow acts on');
    expect(registry).toContain('kind: project-management');
  });

  it('names every resource and says what kind it is', () => {
    for (const entry of resources) {
      expect(entry.name, `an entry has no name: ${JSON.stringify(entry)}`).toBeTruthy();
      expect(entry.kind, `${entry.name} has no kind`).toBeTruthy();
    }
  });

  it('carries no field that could hold a credential', () => {
    for (const entry of resources) {
      for (const key of Object.keys(entry)) {
        expect(key, `${entry.name} carries a ${key}`).not.toMatch(/key|secret|token|password|credential/i);
      }
    }
  });
});

describe('the repository', () => {
  // The registry names resources and never authenticates them. This is the net under that
  // rule: a tracked credential is published to everyone who clones, and survives in history
  // after it is deleted.
  const secrets: [string, RegExp][] = [
    ['a PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ['a Linear token', /\blin_(api|oauth)_[A-Za-z0-9]{16,}\b/],
  ];

  it('tracks no credential in any file', () => {
    for (const path of trackedFiles()) {
      const contents = readRepoFile(path);
      for (const [what, pattern] of secrets) {
        expect(pattern.test(contents), `${path} contains ${what}`).toBe(false);
      }
    }
  });
});
