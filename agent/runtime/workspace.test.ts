/**
 * The capabilities an agent holds: what they do, what they refuse, and the two bounds.
 *
 * Every test here runs against the real filesystem and real child processes, in a temporary
 * workspace torn down afterwards. Nothing is mocked, because everything under test *is* the
 * interaction with the operating system — a mocked `spawn` would prove that this file agrees
 * with itself about process groups, which is the one thing not in doubt.
 *
 * The cap and the deadline are handed small values through {@link local}'s second argument.
 * That parameter exists for these tests and for nothing else: it is not reachable from a
 * record or from a call, so what the agent cannot set stays unsettable while a test still
 * gets to prove the mechanism.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aCapability, aRecord } from '../fixture.ts';
import { CapabilityError, resolveCapabilities, type Capability } from './capability.ts';
import { DEADLINE, local, OUTPUT_LIMIT, WORKSPACE_CHARTER } from './workspace.ts';

const NEVER = new AbortController().signal;
const STUB = join(import.meta.dirname, 'assistant-stub.ts');

let workspace = '';

beforeEach(async () => {
  // Through `realpath`, because on macOS the system temporary directory is itself a symlink
  // and a workspace that does not match its own resolved form would make every containment
  // check in this file fail for a reason that has nothing to do with what is under test.
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'jen-workspace-')));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** The capabilities a record granting `tools` would actually be offered. */
function offered(tools: string[], bounds?: Parameters<typeof local>[1]): Map<string, Capability> {
  const record = aRecord({ workspace, tools });
  return resolveCapabilities(record.tools, local(record, bounds));
}

function tool(name: 'fs' | 'exec', bounds?: Parameters<typeof local>[1]): Capability {
  return offered([name], bounds).get(name)!;
}

describe('a record decides which of the two an agent holds', () => {
  it('offers `fs` alone to a record that names `fs` alone', () => {
    const registry = offered(['fs']);
    expect([...registry.keys()]).toEqual(['fs']);
  });

  it('offers `exec` alone to a record that names `exec` alone', () => {
    expect([...offered(['exec']).keys()]).toEqual(['exec']);
  });

  it('constructs an agent that names neither, and offers it neither', () => {
    expect(offered([]).size).toBe(0);
  });

  it('still fails construction on a name neither source can resolve', () => {
    const record = aRecord({ workspace, tools: ['fs', 'telepathy'] });
    expect(() => resolveCapabilities(record.tools, [...local(record), aCapability('spawn')])).toThrow(CapabilityError);
  });
});

describe('`fs` writes what it was given, exactly', () => {
  /**
   * The test this capability exists for.
   *
   * Every character here is one that breaks or silently changes a file written through a
   * shell heredoc: the delimiter on a line of its own ends the document early, `$NAME` and
   * `$(…)` and a backtick are interpolated into something else. Through a tool taking the
   * content as a string, none of it is syntax.
   */
  it('round-trips content that no heredoc could carry', async () => {
    const hazardous = [
      'EOF',
      'const price = "$100" + `and ${more}`;',
      "single 'quotes' and \"double\" ones",
      'a literal $(rm -rf /) that must not run or change',
      'trailing backslash \\',
      '',
    ].join('\n');

    const fs = tool('fs');
    const written = await fs.invoke({ operation: 'write', path: 'hazard.txt', content: hazardous }, NEVER);
    expect(written.ok).toBe(true);

    // Against the disk, and then against what a read gives back — the first says the bytes
    // are right, the second says the round trip is.
    expect(await readFile(join(workspace, 'hazard.txt'), 'utf8')).toBe(hazardous);
    const read = await fs.invoke({ operation: 'read', path: 'hazard.txt' }, NEVER);
    expect(read.ok).toBe(true);
    expect(read.content).toBe(hazardous);
  });

  it('replaces a whole file rather than writing into the one that is there', async () => {
    await writeFile(join(workspace, 'notes.md'), 'the previous content, which was longer than the new one');
    const before = await stat(join(workspace, 'notes.md'));

    const fs = tool('fs');
    await fs.invoke({ operation: 'write', path: 'notes.md', content: 'new' }, NEVER);

    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('new');
    // A different inode is the evidence that the file arrived by a rename rather than by
    // truncating the one that was there — which is the whole of why an interrupted write
    // cannot leave a mixture of the two.
    expect((await stat(join(workspace, 'notes.md'))).ino).not.toBe(before.ino);
  });

  it('leaves the previous file whole when a write cannot complete, and no debris behind', async () => {
    if (process.getuid?.() === 0) return; // root writes to a read-only directory anyway.

    const directory = join(workspace, 'locked');
    await mkdir(directory);
    await writeFile(join(directory, 'kept.txt'), 'the previous content');
    await chmod(directory, 0o555);

    try {
      const result = await tool('fs').invoke(
        { operation: 'write', path: 'locked/kept.txt', content: 'the new content' },
        NEVER,
      );
      expect(result.ok).toBe(false);
      expect(await readFile(join(directory, 'kept.txt'), 'utf8')).toBe('the previous content');
      expect(await readdir(directory)).toEqual(['kept.txt']);
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('does not follow a symbolic link at the target of a write', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'jen-outside-'));
    try {
      await writeFile(join(outside, 'theirs.txt'), 'not yours');
      await symlink(join(outside, 'theirs.txt'), join(workspace, 'link.txt'));

      const result = await tool('fs').invoke({ operation: 'write', path: 'link.txt', content: 'mine' }, NEVER);
      expect(result.ok).toBe(false);
      expect(result.content).toMatch(/symbolic link/);
      expect(await readFile(join(outside, 'theirs.txt'), 'utf8')).toBe('not yours');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('`fs` will not leave the workspace', () => {
  it('refuses an absolute path', async () => {
    const result = await tool('fs').invoke({ operation: 'read', path: '/etc/hosts' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/absolute/);
  });

  it('refuses a path that climbs above the workspace, even one that would land back inside', async () => {
    const fs = tool('fs');
    expect((await fs.invoke({ operation: 'read', path: '../secrets' }, NEVER)).ok).toBe(false);
    const sideways = await fs.invoke({ operation: 'read', path: 'a/../../elsewhere' }, NEVER);
    expect(sideways.ok).toBe(false);
    expect(sideways.content).toMatch(/above your workspace/);
  });

  it('refuses a path that leaves through a symbolic link inside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'jen-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'not yours');
      await symlink(outside, join(workspace, 'escape'));

      const result = await tool('fs').invoke({ operation: 'read', path: 'escape/secret.txt' }, NEVER);
      expect(result.ok).toBe(false);
      expect(result.content).toMatch(/outside your workspace/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('`fs` answers rather than raising', () => {
  it('reports a missing file as a failed result', async () => {
    const result = await tool('fs').invoke({ operation: 'read', path: 'nothing-here.txt' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/does not exist/);
  });

  it('reports an operation it does not have, naming what it was given', async () => {
    const result = await tool('fs').invoke({ operation: 'patch', path: 'a.txt' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/"patch"/);
  });

  it('reports a write with no content, because a write replaces the whole file', async () => {
    const result = await tool('fs').invoke({ operation: 'write', path: 'a.txt' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/"content"/);
  });

  it('refuses a write into a directory that is not there, naming the directory', async () => {
    // A write creates the file and deliberately not the path to it: making directories is
    // an ordinary command, and a tool that quietly created three of them on a typo'd path
    // would be harder to notice than a refusal.
    const result = await tool('fs').invoke({ operation: 'write', path: 'nowhere/a.txt', content: 'x' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/directory holding "nowhere\/a\.txt" does not exist/);
  });

  it('lists a directory, marking which entries are directories', async () => {
    await mkdir(join(workspace, 'src'));
    await writeFile(join(workspace, 'README.md'), '# hello');

    const result = await tool('fs').invoke({ operation: 'list', path: '.' }, NEVER);
    expect(result.ok).toBe(true);
    expect(result.content.split('\n')).toEqual(['README.md', 'src/']);
  });
});

describe('`exec` runs a program and says what it did', () => {
  it('passes arguments to the program as written, with no shell between', async () => {
    const result = await tool('exec').invoke(
      { argv: ['node', '-e', 'process.stdout.write(process.argv[1] ?? "")', '$HOME | rm -rf * > /dev/null'] },
      NEVER,
    );
    expect(result.ok).toBe(true);
    // Reached the program whole: unexpanded, unsplit, and not interpreted as a pipeline.
    expect(result.content).toContain('$HOME | rm -rf * > /dev/null');
  });

  it('supplies the input and ends it, so a command reading to end of input finishes', async () => {
    const result = await tool('exec').invoke(
      { argv: ['node', '-e', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(s.toUpperCase()))'], stdin: 'quiet words' },
      NEVER,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('QUIET WORDS');
  });

  it('starts where `cwd` says, relative to the workspace', async () => {
    await mkdir(join(workspace, 'inner'));
    const result = await tool('exec').invoke({ argv: ['pwd'], cwd: 'inner' }, NEVER);
    expect(result.ok).toBe(true);
    expect(result.content).toContain(join(workspace, 'inner'));
  });

  it('refuses a `cwd` outside the workspace without running anything', async () => {
    const result = await tool('exec').invoke({ argv: ['pwd'], cwd: '../..' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/above your workspace/);
  });

  it('reports the two streams separately with a nonzero exit', async () => {
    const result = await tool('exec').invoke(
      {
        argv: [
          'node',
          '-e',
          'process.stdout.write("to out");process.stderr.write("to err");process.exit(3)',
        ],
      },
      NEVER,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('exit status 3');
    expect(result.content).toMatch(/stdout:\nto out/);
    expect(result.content).toMatch(/stderr:\nto err/);
  });

  it('reports a program that is not installed as an answer', async () => {
    const result = await tool('exec').invoke({ argv: ['definitely-not-a-program-here'], stdin: 'x' }, NEVER);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/could not be started/);
  });

  it('reports malformed arguments without starting anything', async () => {
    const exec = tool('exec');
    expect((await exec.invoke({ argv: [] }, NEVER)).ok).toBe(false);
    expect((await exec.invoke({ argv: 'ls -la' }, NEVER)).ok).toBe(false);
    expect((await exec.invoke({ argv: ['ls'], stdin: 7 }, NEVER)).content).toMatch(/"stdin"/);
  });

  it('hands the child the credentials this process was given, by inheritance alone', async () => {
    process.env.JEN_TEST_TOKEN = 'sk-inherited-secret';
    try {
      const call = { argv: ['node', '-e', 'process.stdout.write(process.env.JEN_TEST_TOKEN ?? "absent")'] };
      const result = await tool('exec').invoke(call, NEVER);

      expect(result.content).toContain('sk-inherited-secret');
      // The other half of the requirement, and the reason this assertion is here rather
      // than assumed: the value reached the child without appearing in the call at all, so
      // there is nothing for a record, an argument, or a file to have carried it in.
      expect(JSON.stringify(call)).not.toContain('sk-inherited-secret');
    } finally {
      delete process.env.JEN_TEST_TOKEN;
    }
  });
});

describe('an assistant is just a program `exec` runs', () => {
  it('runs one, gives it its prompt, and brings back its single-object result', async () => {
    const received = join(workspace, 'prompt.txt');
    const result = await tool('exec').invoke(
      { argv: [process.execPath, STUB, received], stdin: 'Refactor the loader and report what you changed.' },
      NEVER,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(received, 'utf8')).toBe('Refactor the loader and report what you changed.');
    const printed = JSON.parse(result.content.split('stdout:\n')[1]!.split('\n\nstderr:')[0]!) as {
      type: string;
      result: string;
    };
    expect(printed.type).toBe('result');
    expect(printed.result).toMatch(/changed the workspace/);
  });

  it('reports an assistant that failed the way it reports any other failed command', async () => {
    const result = await tool('exec').invoke(
      { argv: [process.execPath, STUB, join(workspace, 'p.txt'), '--fail'], stdin: 'Do the impossible.' },
      NEVER,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('exit status 2');
    expect(result.content).toContain('the assistant could not complete the task');
  });
});

describe('one bound on what a result may carry', () => {
  it('leaves output within the limit exactly as it was produced, claiming nothing', async () => {
    const exact = 'x'.repeat(64);
    const result = await tool('exec', { limit: 64 }).invoke(
      { argv: ['node', '-e', `process.stdout.write("${exact}")`] },
      NEVER,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain(exact);
    expect(result.content).not.toMatch(/cut off/);
  });

  it('cuts at the limit, says so, and terminates the command', async () => {
    const result = await tool('exec', { limit: 64, grace: 200 }).invoke(
      {
        argv: [
          'node',
          '-e',
          'process.stdout.write("A".repeat(200));setTimeout(()=>process.stdout.write("B"),60_000)',
        ],
      },
      NEVER,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('A'.repeat(64));
    expect(result.content).not.toContain('A'.repeat(65));
    expect(result.content).toMatch(/cut off at 64 bytes/);
    // It came back rather than waiting out the minute the command intended to sit there,
    // which is what "terminated" has to mean.
    expect(result.content).toMatch(/reached the 64-byte limit/);
  });

  it('ends a command that emits without stopping instead of taking all of it', async () => {
    const result = await tool('exec', { limit: 256, grace: 200 }).invoke(
      { argv: [process.execPath, STUB, join(workspace, 'p.txt'), '--flood'], stdin: '' },
      NEVER,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/cut off at 256 bytes/);
    expect(result.content.length).toBeLessThan(2_000);
  });

  it('cuts a file `fs` reads at the same limit, and says the same thing', async () => {
    await writeFile(join(workspace, 'big.txt'), 'y'.repeat(500));
    const result = await tool('fs', { limit: 100 }).invoke({ operation: 'read', path: 'big.txt' }, NEVER);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('y'.repeat(100));
    expect(result.content).not.toContain('y'.repeat(101));
    expect(result.content).toMatch(/cut off at 100 bytes/);
  });

  it('is the same constant for both, and neither a call nor a record can name it', () => {
    const fs = tool('fs');
    const exec = tool('exec');
    for (const capability of [fs, exec]) {
      const properties = Object.keys((capability.schema as { properties: object }).properties);
      expect(properties).not.toContain('limit');
      expect(properties).not.toContain('timeout');
      expect(properties).not.toContain('deadline');
    }
    // The number the agent is told is the number the implementation uses.
    expect(fs.description).toContain(String(OUTPUT_LIMIT));
    expect(exec.description).toContain(String(OUTPUT_LIMIT));
  });
});

describe('the deadline is the guarantee that an agent cannot be stuck', () => {
  it('ends a command that never finishes and says the deadline was reached', async () => {
    const started = Date.now();
    const result = await tool('exec', { deadline: 300, grace: 200 }).invoke(
      { argv: ['node', '-e', 'setTimeout(()=>{}, 60_000)'] },
      NEVER,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/still running after .* and was terminated/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('returns what the command had printed before its deadline', async () => {
    const result = await tool('exec', { deadline: 400, grace: 200 }).invoke(
      { argv: ['node', '-e', 'process.stdout.write("got this far");setTimeout(()=>{}, 60_000)'] },
      NEVER,
    );
    expect(result.content).toContain('got this far');
  });

  it('ends a command that ignores the polite signal anyway', async () => {
    const started = Date.now();
    const result = await tool('exec', { deadline: 300, grace: 300 }).invoke(
      { argv: ['sh', '-c', 'trap "" TERM; while :; do sleep 0.05; done'] },
      NEVER,
    );

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('leaves none of the command’s own children running', async () => {
    const result = await tool('exec', { deadline: 500, grace: 200 }).invoke(
      {
        // The grandchild announces itself, then both sit there. Signalling the process we
        // started would leave the grandchild behind; signalling the group does not.
        argv: ['sh', '-c', 'sleep 60 & echo $!; while :; do sleep 0.05; done'],
      },
      NEVER,
    );

    const pid = Number(result.content.match(/stdout:\n(\d+)/)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    await settle();
    expect(alive(pid)).toBe(false);
  });

  it('leaves none running even where the command closed before they did', async () => {
    // The case the previous test cannot reach. `close` says the process we started is gone
    // and says nothing about what it started: this grandchild holds none of its parent's
    // pipes, so `close` arrives while it is still there, and it ignores `SIGTERM`, so it is
    // still there. Ending the escalation at `close` — the obvious place — strands it.
    const child = `const { spawn } = require('node:child_process');
       const g = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { stdio: 'ignore' });
       process.stdout.write(String(g.pid));
       setTimeout(() => {}, 60_000);`;
    const result = await tool('exec', { deadline: 300, grace: 400 }).invoke(
      { argv: ['node', '-e', child] },
      NEVER,
    );

    const pid = Number(result.content.match(/stdout:\n(\d+)/)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    try {
      await settle();
      expect(alive(pid)).toBe(false);
    } finally {
      // If it did survive, it survives this whole test run and the machine after it, since
      // nothing else knows the pid. Clean up whatever the assertion found.
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone, which is the passing case */
      }
    }
  });

  it('is not reachable from a call, and is the number the agent was told', () => {
    const exec = tool('exec');
    expect(Object.keys((exec.schema as { properties: object }).properties)).toEqual(['argv', 'stdin', 'cwd']);
    expect(exec.description).toContain(`${Math.round(DEADLINE / 60_000)} minutes`);
  });

  it('terminates on an aborted invocation as well, without waiting for the deadline', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = tool('exec', { deadline: 60_000, grace: 200 }).invoke(
      { argv: ['node', '-e', 'setTimeout(()=>{}, 60_000)'] },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);

    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/cancelled/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('the guidance is where the agent will read it, and decides nothing', () => {
  it('tells the agent what a result costs it later and how to narrow output first', () => {
    const description = tool('exec').description;
    expect(description).toMatch(/sent again on every later step/);
    expect(description).toMatch(/grep/);
    expect(description).toMatch(/tail/);
    expect(description).toMatch(/redirect/);
    expect(description).toMatch(/run the whole thing again|running the whole thing again/);
  });

  it('describes an assistant without requiring one, naming none as the one to use', () => {
    const description = tool('exec').description;
    expect(description).toMatch(/Check that the command is there/);
    expect(description).toMatch(/git diff --stat/);
    // The substrate names no assistant anywhere, which is the property the whole pivot
    // away from an adapter rests on.
    expect(description).not.toMatch(/claude|codex|copilot/i);
  });

  it('offers a charter template and applies none of it on the agent’s behalf', () => {
    expect(WORKSPACE_CHARTER).toMatch(/Check a command is there/);
    expect(WORKSPACE_CHARTER).toMatch(/interrupted/);
    // The template is placeholders, not examples: the same property as the description
    // above, and the easier one to lose, since an illustrative command reads as helpful.
    expect(WORKSPACE_CHARTER).not.toMatch(/claude|codex|copilot|anthropic|openai/i);
    // Nothing reads it: an agent's charter is its record's, and a capability that prepended
    // its own paragraph would be an instruction no record could see and no parent narrow.
    const record = aRecord({ workspace, tools: ['fs', 'exec'] });
    expect(record.charter).not.toContain('Check a command is there');
    for (const capability of local(record)) {
      expect(capability.description).not.toContain(WORKSPACE_CHARTER);
    }
  });
});

/** Whether a process is still there. `signal 0` asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Long enough for a signal to have been delivered and reaped. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500));
}
