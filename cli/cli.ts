/**
 * The commands themselves: argument parsing, the two wirings of plan-then-execute, and
 * the report each run leaves behind.
 *
 * `init` and `update` are one operation with three differences — `init` also writes the
 * once-only scaffold, refuses a fixed path it cannot claim, and initializes OpenSpec.
 * Expressing that as options rather than as two implementations is what keeps "never
 * delete an unstamped file" true in one place instead of two.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { apply, ApplyFailure, type Applied } from './apply.js';
import { ignoredPaths } from './ignore.js';
import * as openspec from './openspec.js';
import { isEmpty, planInstall, type Plan } from './plan.js';
import { payloadFiles, SCAFFOLD, SKILLS } from './payload.js';

const USAGE = `jen — the workflow layer for automated, agentic software development

Usage:
  jen <command> [project] [options]

Commands:
  init      install the workflow into a project and initialize OpenSpec
  update    refresh the managed files and remove the ones jen no longer ships

Options:
      --force          on init, overwrite a file jen owns wholesale that the project already has
  -h, --help           show this message
  -v, --version        show the installed version

\`project\` defaults to the working directory. jen writes the workflow document, the
${SKILLS.length} skills it ships, and a scaffold the project then owns; it touches nothing else. Neither
command prompts, and both are safe to re-run and safe in CI.`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface RunOptions {
  /** Where the staged payload lives. Defaults to the one inside this installation. */
  templates?: string;
  /** What a bare invocation targets. Defaults to the working directory. */
  cwd?: string;
}

type Command = 'init' | 'update';

interface Invocation {
  projectRoot: string;
  force: boolean;
}

class UsageError extends Error {}

function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

function parse(command: Command, args: string[], cwd: string): Invocation {
  let path: string | undefined;
  let force = false;

  for (const arg of args) {
    if (arg === '--force') {
      if (command !== 'init') throw new UsageError('--force applies to `jen init` only');
      force = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else if (path === undefined) {
      path = arg;
    } else {
      throw new UsageError(`jen ${command} takes one project path, and was given two: ${path} and ${arg}`);
    }
  }

  return { projectRoot: resolve(cwd, path ?? '.'), force };
}

function line(label: string, detail: string): string {
  return `  ${label.padEnd(10)}${detail}`;
}

/** The plan, rendered as what the run did. */
function report(io: Io, command: Command, plan: Plan, applied: Applied, notes: string[]): void {
  io.out(`jen ${command} — ${plan.projectRoot}`);
  io.out('');

  const scaffolded = new Set(plan.scaffold.map((write) => write.target));
  const replaced = new Set(plan.writes.filter((write) => write.replaces).map((write) => write.target));

  for (const target of applied.written) {
    io.out(line(scaffolded.has(target) ? 'scaffold' : replaced.has(target) ? 'refreshed' : 'created', target));
  }
  for (const target of applied.removed) {
    io.out(line('removed', target));
  }

  if (isEmpty(plan)) {
    io.out(line('unchanged', `${plan.current.length} managed paths — nothing to do`));
  } else if (plan.current.length > 0) {
    io.out(line('unchanged', `${plan.current.length} managed paths`));
  }

  for (const note of notes) io.out(line('note', note));
}

/** Warnings that do not change the exit code: the run succeeded, and something needs saying. */
function warn(io: Io, projectRoot: string): void {
  const managed = [...payloadFiles().map(({ file }) => file.target), ...SCAFFOLD.map((file) => file.target)];

  for (const path of ignoredPaths(projectRoot, managed)) {
    io.err(`jen: ${path} is a managed path, and this project's ignore rules exclude it. It will be missing from a fresh clone.`);
  }
}

function refuse(io: Io, plan: Plan): number {
  const paths = plan.conflicts.join(', ');
  io.err(`jen init: ${plan.projectRoot} already has ${paths}, which jen owns wholesale and cannot tell from its own.`);
  io.err('Adopting a project that already holds content is a migration, and jen does not yet perform one.');
  io.err('Nothing was written. Re-run with --force to replace it, or move the file aside first.');
  return 1;
}

/**
 * A run that cannot reach its own paths without leaving the project.
 *
 * Not a conflict, so `--force` does not apply: forcing means "that file is mine to
 * replace", and nothing about a symlinked directory makes a write outside the project the
 * right answer. Both commands refuse it, and neither writes the paths it *could* reach —
 * a half-installed workflow is worse than an uninstalled one.
 */
function obstructed(io: Io, command: Command, plan: Plan): number {
  io.err(`jen ${command}: ${plan.projectRoot} reaches managed paths through a symlink, and jen will not write through one.`);
  for (const { target, ancestor } of plan.obstructions) {
    io.err(`  ${target} — ${ancestor} is a symlink`);
  }
  io.err('Everything below the link belongs to wherever it points, which may be outside the project entirely.');
  io.err('Nothing was written. Replace the link with a real directory and re-run.');
  return 1;
}

function reportFailure(io: Io, command: Command, failure: ApplyFailure): number {
  for (const target of failure.completed.written) io.out(line('written', target));
  for (const target of failure.completed.removed) io.out(line('removed', target));
  io.err(`jen ${command}: ${failure.message}`);
  io.err('The paths above were completed; nothing was rolled back. Re-running converges.');
  return 1;
}

function install(command: Command, invocation: Invocation, io: Io, options: RunOptions): number {
  const plan = planInstall(invocation.projectRoot, {
    scaffold: command === 'init',
    templates: options.templates,
  });

  if (plan.obstructions.length > 0) return obstructed(io, command, plan);
  if (command === 'init' && plan.conflicts.length > 0 && !invocation.force) return refuse(io, plan);

  let applied: Applied;
  try {
    applied = apply(plan);
  } catch (error) {
    if (error instanceof ApplyFailure) return reportFailure(io, command, error);
    throw error;
  }

  // Delegation is reported alongside the writes rather than instead of them: the payload
  // has already landed by this point, and a failure here must not hide that.
  const notes: string[] = [];
  // A symlink quietly becoming a regular file is the one write worth naming: the project
  // put it there on purpose, and the report is the only place it finds out.
  for (const write of plan.writes) {
    if (write.symlink) notes.push(`${write.target} was a symlink, and is now a regular file jen owns`);
  }
  let delegation: Error | undefined;
  if (command === 'init') {
    try {
      if (openspec.isInitialized(invocation.projectRoot)) {
        notes.push('OpenSpec is already initialized here — left alone');
      } else {
        openspec.initialize(invocation.projectRoot);
        notes.push('OpenSpec initialized');
      }
    } catch (error) {
      delegation = error instanceof Error ? error : new Error(String(error));
    }
  }

  report(io, command, plan, applied, notes);
  warn(io, invocation.projectRoot);

  if (delegation) {
    io.err(`jen ${command}: ${delegation.message}`);
    io.err('The payload above was written; OpenSpec was not initialized.');
    return 1;
  }

  if (command === 'init' && !openspec.resolvesFromProject(invocation.projectRoot)) {
    io.err('jen: OpenSpec will not resolve from this project, and every stage of the workflow runs it.');
    io.err('Install jen as a project devDependency so both versions are pinned in its lockfile: npm i -D @reveer/jen');
  }

  return 0;
}

/** Every command, dispatched. */
export function run(argv: string[], io: Io, options: RunOptions = {}): number {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return 0;

      case '--version':
      case '-v':
        io.out(version());
        return 0;

      case 'init':
      case 'update':
        if (rest.includes('--help') || rest.includes('-h')) {
          io.out(USAGE);
          return 0;
        }
        return install(command, parse(command, rest, options.cwd ?? process.cwd()), io, options);

      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`jen: ${error.message}\n`);
      io.err(USAGE);
      return 1;
    }
    io.err(`jen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
