/**
 * The interface, read rather than run.
 *
 * `agent-sandbox` requires the interface's independence to be *checkable by reading its
 * declarations* rather than inferred from a driver's behaviour, and with one driver that
 * reading is the only thing holding the seam open — nothing else exercises it, so nothing
 * else can reveal an assumption that leaked through. These tests are that reading, done by
 * something that does not get tired of doing it.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');

/**
 * The file with its prose removed.
 *
 * Two of the checks below are about what the interface *does not* declare, and the prose
 * has to be free to say what is absent and why — an interface that could not explain its
 * own omissions would lose the reasoning that keeps them from being re-added. So those two
 * read the declarations alone.
 */
const DECLARATIONS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Vocabulary belonging to one implementation.
 *
 * Checked against the whole file, comments included. Holding the comments to it as well is
 * what makes the claim checkable by a person: a file whose prose explains itself in one
 * driver's terms is one where "no declaration names a container" is true only on a
 * technicality.
 */
const FORBIDDEN = [
  'container',
  'image',
  'docker',
  'podman',
  'daemon',
  'socket',
  'pid',
  'host',
  'volume',
  'mount',
];

/** The field names a `export type X = Pick<…, '…'>` selects, in the order they are written. */
function picked(name: string): string[] {
  const block = new RegExp(`export type ${name} = Pick<\\w+, ([^>]*)>`).exec(SOURCE);
  expect(block, `${name} is declared as a projection of a record`).not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1] ?? '');
}

/** Every member named inside `export interface X { … }`. */
function members(name: string): string[] {
  const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(SOURCE);
  expect(block, `${name} is declared`).not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/^\s{2}(\w+)[?(:]/gm)].map((match) => match[1] ?? '');
}

describe('no driver concept leaks onto the interface', () => {
  for (const word of FORBIDDEN) {
    it(`never says "${word}"`, () => {
      expect(SOURCE).not.toMatch(new RegExp(`\\b${word}`, 'i'));
    });
  }

  it('names no process identifier', () => {
    expect(members('Exit')).toEqual(['code', 'signal']);
  });
});

describe('the interface exposes only what it needs', () => {
  it('gives a sandbox execution and destruction, and nothing else', () => {
    expect(members('Sandbox')).toEqual(['exec', 'destroy']);
  });

  it('gives a driver creation, workspace release and a run’s release, and nothing else', () => {
    expect(members('SandboxDriver')).toEqual(['create', 'releaseWorkspace', 'destroyAll']);
  });

  /**
   * The fifth operation is the one that could destroy a day of an agent's work by being
   * spelled slightly too widely, so what it takes is read as well as that it exists. A
   * parameter here would be a run id, and a driver already knows its own — a caller able to
   * name one is a caller able to name another run's.
   */
  it('gives the run’s release no argument to get wrong', () => {
    expect(DECLARATIONS).toMatch(/\bdestroyAll\(\): Promise<void>;/);
  });

  it('gives a process its output, its input and its ending, and nothing else', () => {
    expect(members('Process')).toEqual(['stdout', 'stderr', 'stdin', 'exit']);
  });

  it('gives sending a way to fail that is not an uncaught error', () => {
    expect(members('Input')).toEqual(['send', 'end']);
    expect(DECLARATIONS).toMatch(/send\(text: string\): Promise<void>;/);
  });

  it('declares no network configuration operation', () => {
    const operations = [...members('Sandbox'), ...members('SandboxDriver')];
    expect(operations.join(' ')).not.toMatch(/network|egress|allow|firewall|policy|filter/i);
    expect(DECLARATIONS).not.toMatch(/network|egress|firewall/i);
  });
});

describe('the primitive is unaware of hierarchy', () => {
  it('is given nothing about an agent’s place in one', () => {
    expect(picked('SandboxRequest')).toEqual(['id', 'environment', 'workspace', 'credentials']);
    expect(DECLARATIONS).not.toMatch(/parent|depth|ancestor|hierarch/i);
  });
});

/**
 * That the narrowed form cannot drift from the record is a *compile-time* property, so the
 * only thing that can test it is a compiler. Asserting it any other way — comparing two
 * lists of field names, say — would be asserting the coincidence this is meant to rule out.
 *
 * The fixture is a copy of the two real files with one field of the record renamed, put
 * where the substrate's own `node_modules` resolution still reaches `@types/node`, and
 * typechecked with the substrate's own configuration. It is deleted afterwards; nothing
 * about it is worth keeping or ignoring.
 */
describe('the narrowed form is derived rather than restated', () => {
  const fixtures: string[] = [];

  afterAll(() => {
    for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
  });

  it('fails to resolve when a field of the record is renamed', () => {
    const root = join(import.meta.dirname, '..', '..');
    const fixture = mkdtempSync(join(root, 'node_modules', '.jen-record-drift-'));
    fixtures.push(fixture);

    mkdirSync(join(fixture, 'sandbox'));
    cpSync(join(import.meta.dirname, '..', 'tsconfig.json'), join(fixture, 'tsconfig.json'));
    cpSync(join(import.meta.dirname, 'index.ts'), join(fixture, 'sandbox', 'index.ts'));

    const renamed = readFileSync(join(import.meta.dirname, '..', 'record.ts'), 'utf8')
      .replace(/^  workspace: string;$/m, '  workspaceRoot: string;')
      .replace("workspace: string(source, 'workspace', at),", "workspaceRoot: string(source, 'workspace', at),");
    expect(renamed, 'the fixture renamed nothing — has the record’s field list changed?').toContain('workspaceRoot');
    writeFileSync(join(fixture, 'record.ts'), renamed);

    let diagnostics: string | undefined;
    try {
      execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(fixture, 'tsconfig.json')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      diagnostics = String((error as { stdout?: string }).stdout ?? '');
    }

    expect(
      diagnostics,
      'renaming a field of the record typechecked, so the two shapes agree only by coincidence',
    ).toBeDefined();
    // The narrowed form is where it fails, naming the field that no longer exists — not
    // some downstream consumer, and not a runtime surprise.
    expect(diagnostics).toContain('sandbox/index.ts');
    expect(diagnostics).toContain('"workspace"');
  });
});
