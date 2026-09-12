/**
 * The interface, read rather than run.
 *
 * `agent-sandbox` requires the interface's independence to be *checkable by reading its
 * declarations* rather than inferred from a driver's behaviour, and with one driver that
 * reading is the only thing holding the seam open — nothing else exercises it, so nothing
 * else can reveal an assumption that leaked through. These tests are that reading, done by
 * something that does not get tired of doing it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('gives a driver creation and workspace release, and nothing else', () => {
    expect(members('SandboxDriver')).toEqual(['create', 'releaseWorkspace']);
  });

  it('declares no network configuration operation', () => {
    const operations = [...members('Sandbox'), ...members('SandboxDriver')];
    expect(operations.join(' ')).not.toMatch(/network|egress|allow|firewall|policy|filter/i);
    expect(DECLARATIONS).not.toMatch(/network|egress|firewall/i);
  });
});

describe('the primitive is unaware of hierarchy', () => {
  it('records nothing about an agent’s place in one', () => {
    expect(members('AgentRecord')).toEqual(['id', 'environment', 'workspace', 'credentials']);
    expect(DECLARATIONS).not.toMatch(/parent|depth|ancestor|hierarch/i);
  });
});
