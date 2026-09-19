/**
 * The supervisor's source, read rather than run.
 *
 * Two prohibitions here are behavioural in a way no behavioural test can hold. A default
 * residency added to this file would make every test in this directory pass — the tests
 * name their own numbers, so a supplied one would only ever apply where a test did not
 * look. And a sweep that released workspaces would pass every assertion about ending
 * bodies. Both fail by destroying something, and both are exactly the "just add a small
 * rule" that will keep looking reasonable. So they are read, the way `docker.test.ts` reads
 * for `node:fs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');

/**
 * The file with its prose removed.
 *
 * The prose has to stay free to say what is absent and why — a file that could not explain
 * its own omissions loses the reasoning that keeps them from being re-added, which is the
 * lesson `model.ts` learned about its unused loop helpers.
 */
const DECLARATIONS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the supervisor holds no period of its own', () => {
  /**
   * `weights decide, code constrains`. Only the agent can know whether it is about to be
   * woken in seconds or in a day, because it has just decided what it dispatched — and a
   * constant here deciding it would be policy in code, where no charter can reach it.
   */
  it('names no binding that could be a duration', () => {
    // Bindings rather than every identifier: `ms` on a capability result is the event's own
    // field, recording how long an invocation took, and it is neither a period this file
    // chose nor one it applies to anything.
    const bound = [
      ...[...DECLARATIONS.matchAll(/\b(?:const|let|var|readonly)\s+(#?[A-Za-z_][A-Za-z0-9_]*)/g)],
      ...[...DECLARATIONS.matchAll(/^\s*(#[A-Za-z_][A-Za-z0-9_]*)\s*[:=(]/gm)],
    ].map((match) => match[1] ?? '');

    expect(bound.length, 'the reading found no bindings at all').toBeGreaterThan(5);
    for (const name of bound) {
      expect(name, `\`${name}\` reads as a period the supervisor holds`).not.toMatch(
        /(ms|millis|seconds|timeout|interval|delay|grace|idle|backoff|linger|keepalive)$/i,
      );
    }
  });

  it('writes no number that could be one either', () => {
    // Anything with a digit separator and anything multiplied out, wherever it appears:
    // both are how a count of milliseconds is spelled when someone wants it to read as
    // arithmetic rather than as a number.
    expect(DECLARATIONS).not.toMatch(/\b\d+_\d+/);
    expect(DECLARATIONS).not.toMatch(/\b\d+\s*\*\s*\d+/);

    // And a number long enough to *be* a count of milliseconds may appear in exactly one
    // position: alone, as the whole of a named binding. `ms: 0` and a bound of `0` survive,
    // which is the point — zero is the absence of a request rather than a period.
    //
    // **The position is the whole of what this allows, and the name is still tested.** The
    // test above reads every binding in this file and fails any whose name could be a
    // period, so a `const KEEP_ALIVE_MS = 30000` is refused there and a byte bound on a
    // buffer is not. What stays refused here is the shape a period actually takes when it
    // is smuggled in: a literal passed to a timer, compared against a clock, or added to
    // one. Widening this to "long numbers are fine" would give all of that away; it admits
    // one position and one position only.
    const bound = new RegExp(`^\\s*(?:const|let|var|readonly)\\s+#?[A-Za-z_][A-Za-z0-9_]*(?::[^=]+)?\\s*=\\s*\\d{3,};\\s*$`);
    for (const line of DECLARATIONS.split('\n')) {
      if (!/\b\d{3,}\b/.test(line)) continue;
      expect(line, 'a number this long belongs alone in a named binding, or nowhere').toMatch(bound);
    }
  });

  it('arms exactly one timer, and never on a number of its own', () => {
    const armed = DECLARATIONS.split('\n').filter((line) => line.includes('setTimeout('));
    expect(armed, 'the supervisor arms one timer, from the residency on the frame').toHaveLength(1);
    // The delay is the last argument, and it has to be the name the frame arrived under
    // rather than anything this file decided.
    expect(armed[0]?.trim()).toMatch(/setTimeout\(.*,\s*keep\);?$/);
    expect(DECLARATIONS).not.toMatch(/setInterval/);
  });

  it('takes the period from the frame and applies nothing to it', () => {
    // No clamp, no floor, no ceiling, no scaling. `keep <= 0` is a question about whether
    // the agent asked for anything at all, which is the one reading of the number allowed.
    const uses = DECLARATIONS.split('\n').filter((line) => /\bkeep\b/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use, `\`${use.trim()}\` adjusts what the agent asked for`).not.toMatch(
        /Math\.(min|max|round|floor|ceil)|keep\s*[*+\-/]|[*+\-/]\s*keep/,
      );
    }
  });
});

describe('nothing in the supervisor releases a workspace', () => {
  /**
   * The sweep runs after a failure, which is precisely when every agent's work is sitting in
   * a workspace waiting to be resumed from. `releaseWorkspace` is on the interface the
   * supervisor already holds, one line away from the sweep that ends bodies — and taking it
   * would destroy a day of every agent's work through a call that reads as tidying up.
   *
   * Dismissal is the one place releasing could ever be right, and it is deliberately not
   * done there either: keeping the workspace is reversible and releasing it is not.
   */
  it('never calls it', () => {
    expect(DECLARATIONS).not.toMatch(/releaseWorkspace/);
  });

  it('says why, so the absence is not mistaken for an oversight', () => {
    expect(SOURCE).toMatch(/workspace is kept/i);
  });
});

/**
 * The two structural claims `agent-supervisor` opens with, read where they are made.
 *
 * Both are about what does *not* exist, and a behavioural test can only ever fail to find
 * something. A runtime that grew a branch on an agent's place in the tree would pass every
 * test in this repository, because every one of them runs a single agent's runtime at a
 * time and never compares two.
 */
describe('the supervisor is outside every agent, and no agent is inside it', () => {
  const RUNTIME = [
    'index.ts',
    'main.ts',
    'loop.ts',
    'boot.ts',
    'capability.ts',
    'supervised.ts',
    'transcript.ts',
    'projection.ts',
  ]
    .map((name) => join(import.meta.dirname, '..', 'runtime', name))
    .filter((path) => existsSync(path));

  it('reads the runtime it is claiming this about', () => {
    expect(RUNTIME.length).toBeGreaterThan(4);
  });

  /**
   * An agent's place in the tree is on its record and the runtime never looks at it. That is
   * what "the runtime of the agent nobody spawned is the same as the runtime of an agent at
   * any depth" means concretely — not that they are configured alike, but that there is no
   * construction path, argument or branch by which one could differ.
   */
  it('never branches on where an agent sits', () => {
    for (const path of RUNTIME) {
      const declarations = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(declarations, `${path} reads an agent's place in the tree`).not.toMatch(
        /\.parent\b|\bisRoot\b|\bdepth\b|\bancestor/i,
      );
    }
  });

  /**
   * Neither runtime contains the means to provision a sandbox, route a message, or read
   * another agent's transcript — which is the other half of the same claim, and the half a
   * `spawn` capability implemented locally would quietly undo.
   */
  it('holds none of what the supervisor holds', () => {
    for (const path of RUNTIME) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} reaches the sandbox`).not.toMatch(/from '(\.\.\/)?sandbox\//);
      expect(source, `${path} reaches the store`).not.toMatch(/from '(\.\.\/)?supervisor\//);
    }
  });
});

describe('there is no network path between agents', () => {
  /**
   * The channel is each agent's own standard streams and there is no second one. A broker, a
   * port, a daemon or a bus would be machinery whose operational cost exceeds what it
   * coordinates for a project holding tens of agents rather than thousands — and it would be
   * a path between agents that does not go through the one component that may hold one.
   */
  it('opens nothing, listens on nothing, and speaks to nothing over a socket', () => {
    for (const path of [join(import.meta.dirname, 'index.ts'), join(import.meta.dirname, '..', 'protocol.ts')]) {
      const declarations = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(declarations, `${path} reaches the network`).not.toMatch(
        /node:(net|http|https|dgram|tls)|WebSocket|\.listen\(|createServer|fetch\(/,
      );
    }
  });
});
