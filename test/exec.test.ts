/**
 * The executor: what it isolates, what it establishes before a session starts, and what it
 * concludes from what the session reported.
 *
 * The verdict and the stream reader are pure and are exercised directly, because every one
 * of their branches is a failure mode that would otherwise only appear in production — an
 * unreachable tracker, a session that never started, permissions silently inert.
 *
 * Everything else runs for real against a stub. `claude` is a node script emitting canned
 * `stream-json`, and the remote is a git repository on disk, so the clone, the branch
 * placement, the child's environment, the cleanup, and the signal are all exercised as
 * themselves rather than through a mock of them. No test spends money or reaches the
 * network, which is the only thing the stubs are there to avoid.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitHub } from '../cli/github.js';
import { openspecBin } from '../cli/openspec.js';
import {
  childEnvironment,
  Executor,
  prompt,
  readStream,
  spawner,
  verdict,
  type Exit,
  type ExecOptions,
  type RunOutcome,
  type SessionReport,
  type Spawner,
} from '../cli/exec.js';

import type { RunRequest } from '../cli/run.js';

const REQUEST: RunRequest = { task: 'ENG-1', skill: 'implement-task', role: 'dev', branch: 'eng-1-a-task' };

function exit(overrides: Partial<Exit> = {}): Exit {
  return { code: 0, signal: null, stdout: '', stderr: '', ...overrides };
}

function report(overrides: Partial<SessionReport> = {}): SessionReport {
  return { mcpFailures: [], started: true, isError: false, ...overrides };
}

describe('the prompt', () => {
  // Both halves are named and neither is inferred. The task especially: a session launched
  // with a bare skill name has no asking branch when run non-interactively under `-p`, so it
  // would refuse to act — spending a dispatch and presenting from outside as a stage failure.
  // `-p` is what makes an answer impossible; the invocation also withholds the asking tools,
  // so the session holds none to reach for on the way to discovering that.
  it('names the skill by name and the task beside it', () => {
    expect(prompt(REQUEST)).toBe('/implement-task ENG-1');
  });
});

describe('reading the session’s stream', () => {
  const init = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', mcp_servers: [], ...extra });
  const result = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42, ...extra });

  it('takes the cost and the session id off the result', () => {
    const read = readStream([init(), result()].join('\n'));

    expect(read.started).toBe(true);
    expect(read.cost).toBe(0.42);
    expect(read.sessionId).toBe('s-1');
    expect(read.mcpFailures).toEqual([]);
  });

  // The shape the task was written against.
  it('reads an explicit mcp_server_errors list', () => {
    const read = readStream([init({ mcp_server_errors: ['linear failed to validate'] }), result()].join('\n'));

    expect(read.mcpFailures).toEqual([{ server: undefined, detail: 'linear failed to validate' }]);
  });

  // And the shape the harness has been observed emitting. A check knowing only one of them
  // would pass a session that never reached the tracker — which cannot announce itself, so
  // the next tick dispatches the task again.
  it('reads a server that came up in any state but connected', () => {
    const failed = init({ mcp_servers: [{ name: 'linear', status: 'failed' }] });
    const read = readStream([failed, result()].join('\n'));

    expect(read.mcpFailures).toEqual([{ server: 'linear', detail: 'reported `failed`' }]);
  });

  // The clone is a full jen installation, so a project's own `.mcp.json` contributes servers
  // beside the tracker's. Each failure has to carry the name it belongs to; the verdict is
  // where that turns into a diagnosis.
  it('keeps each failing server’s own name rather than pooling them', () => {
    const failed = init({
      mcp_servers: [
        { name: 'linear', status: 'connected' },
        { name: 'some-other-server', status: 'failed' },
      ],
    });

    expect(readStream([failed, result()].join('\n')).mcpFailures).toEqual([
      { server: 'some-other-server', detail: 'reported `failed`' },
    ]);
  });

  it('says nothing failed when every server connected', () => {
    const read = readStream([init({ mcp_servers: [{ name: 'linear', status: 'connected' }] }), result()].join('\n'));

    expect(read.mcpFailures).toEqual([]);
  });

  it('reports a session that emitted no init event', () => {
    expect(readStream(result()).started).toBe(false);
  });

  // The stream carries whatever the session's tools printed. A run that raised on a stray
  // line would be reporting the wrong failure.
  it('skips lines that are not events rather than failing on them', () => {
    const read = readStream(['npm warn deprecated something', '', '{ not json', init(), result()].join('\n'));

    expect(read.started).toBe(true);
    expect(read.cost).toBe(0.42);
  });
});

describe('the verdict', () => {
  it('is success only when every signal agrees', () => {
    expect(verdict(report(), exit(), '')).toEqual([]);
  });

  // The task was opened saying an in-run failure prints as the result rather than raising the
  // exit code. Verified against 2.1.220, an authentication failure raised *both* — so neither
  // signal is reliably the whole story and reading only one is right by accident.
  it('fails on the session’s own result even where it exited 0', () => {
    const failures = verdict(report({ isError: true, resultText: 'Invalid API key' }), exit(), '');

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Invalid API key');
  });

  it('fails on a non-zero exit even where the result said nothing', () => {
    expect(verdict(report(), exit({ code: 1 }), '')).toEqual([expect.stringContaining('exited 1')]);
  });

  it('fails on a tracker connection that did not initialize', () => {
    const failures = verdict(report({ mcpFailures: [{ server: 'linear', detail: 'reported `failed`' }] }), exit(), '');

    expect(failures).toEqual([expect.stringContaining('tracker connection did not initialize')]);
  });

  // A second server failing is still a failed run — the session was given something it did
  // not get — but calling it the tracker sends whoever reads the report after the wrong
  // system entirely.
  it('names the server that failed rather than diagnosing every one of them as the tracker', () => {
    const failures = verdict(
      report({ mcpFailures: [{ server: 'some-other-server', detail: 'reported `failed`' }] }),
      exit(),
      '',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('some-other-server');
    expect(failures[0]).not.toContain('tracker');
  });

  it('fails on a session that never started', () => {
    expect(verdict(report({ started: false }), exit(), '')).toEqual([expect.stringContaining('never started')]);
  });

  // The mitigation that makes an undocumented `CLAUDE_CONFIG_DIR` an acceptable dependency:
  // it turns the silent loss of permissions into a named first-second failure. The check is
  // on the symptom, so it holds whatever the mechanism.
  it('fails on the untrusted-workspace warning, which the session prints and survives', () => {
    const stderr = 'Ignoring 8 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.';
    const failures = verdict(report(), exit(), stderr);

    expect(failures).toEqual([expect.stringContaining('never trusted')]);
  });

  it('reports every signal that failed rather than the first', () => {
    const failures = verdict(
      report({ isError: true, mcpFailures: [{ server: 'linear', detail: 'reported `failed`' }] }),
      exit({ code: 1 }),
      'Ignoring 8 permissions.allow entries',
    );

    expect(failures).toHaveLength(4);
  });

  it('names the signal when a session was killed rather than reporting an exit code', () => {
    expect(verdict(report(), exit({ code: null, signal: 'SIGTERM' }), '')).toEqual([
      expect.stringContaining('SIGTERM'),
    ]);
  });
});

// Everything below runs a real clone against a real repository and a real child process.
describe('a run', () => {
  let scratch: string;
  let origin: string;
  let stub: string;
  let record: string;

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeAll(() => {
    scratch = join(tmpdir(), `jen-exec-${process.pid}`);
    origin = join(scratch, 'origin');
    stub = join(scratch, 'claude.mjs');
    record = join(scratch, 'record.json');
    mkdirSync(origin, { recursive: true });

    git(['init', '-b', 'main'], origin);
    git(['config', 'user.name', 'Origin'], origin);
    git(['config', 'user.email', 'origin@example.com'], origin);
    writeFileSync(join(origin, 'README.md'), '# origin\n');
    git(['add', '-A'], origin);
    git(['commit', '-m', 'first'], origin);
    // A branch that already exists, so the fetch path and the create path are both real.
    git(['switch', '-c', 'eng-2-designed'], origin);
    writeFileSync(join(origin, 'design.md'), '# design\n');
    git(['add', '-A'], origin);
    git(['commit', '-m', 'design'], origin);
    git(['switch', 'main'], origin);

    // The stub assistant: records how it was invoked, emits canned events, exits as told.
    writeFileSync(
      stub,
      `import { chmodSync, writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(env.STUB_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  // Recorded whole rather than filtered to the names jen sets. What a session inherits is
  // itself under test now — a project's own variable arrives under the project's own name,
  // which no filter written in terms of jen's names could ever see. The executor hands this
  // stub a closed environment, so "whole" is the small set the test built.
  env,
}));
if (env.STUB_STDERR) process.stderr.write(env.STUB_STDERR + '\\n');
for (const line of JSON.parse(env.STUB_EVENTS ?? '[]')) process.stdout.write(JSON.stringify(line) + '\\n');
// Takes away the run root's write bit from inside the run, so the removal that follows
// fails for a reason nothing in the executor can arrange for itself.
if (env.STUB_LOCK) chmodSync(env.STUB_LOCK, 0o500);
if (env.STUB_SLEEP) { setTimeout(() => process.exit(0), Number(env.STUB_SLEEP)); }
else process.exit(Number(env.STUB_EXIT ?? '0'));
`,
    );
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const EVENTS = [
    { type: 'system', subtype: 'init', session_id: 's-1', mcp_servers: [{ name: 'linear', status: 'connected' }] },
    { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, session_id: 's-1' },
  ];

  function environment(extra: Record<string, string> = {}): Record<string, string> {
    return {
      JEN_REPO: 'reveer-ai/jen',
      JEN_GH_APP_ID_DEV: '4588651',
      JEN_GH_INSTALLATION_DEV: '153578694',
      JEN_GH_PRIVATE_KEY_DEV: 'unused — the host is stubbed',
      JEN_GH_PRIVATE_KEY_DESIGN: 'another role’s key, which the session must not receive',
      // The `deliver` trio, so a request naming that role can resolve its credentials. Three
      // stages act under it, which is what makes it the role the stage-keyed scoping is
      // tested against — a rule reading the role could not tell them apart.
      JEN_GH_APP_ID_DELIVER: '4588653',
      JEN_GH_INSTALLATION_DELIVER: '153578696',
      JEN_GH_PRIVATE_KEY_DELIVER: 'a third role’s key, equally not the session’s',
      LINEAR_API_KEY: 'lin_api_recorded',
      ANTHROPIC_API_KEY: 'sk-ant-recorded',
      STUB_RECORD: record,
      STUB_EVENTS: JSON.stringify(EVENTS),
      ...extra,
    };
  }

  /** A `GitHub` that mints without signing, so a run needs no key and no network. */
  function host(delay = 0): GitHub {
    const minted = new GitHub({
      transport: async (input) =>
        new Response(
          JSON.stringify(String(input).endsWith('/app') ? { slug: 'reveer-jen-dev' } : { token: 'ghs_recorded' }),
        ),
    });
    // The JWT is not what is under test here, and signing needs a real key.
    Object.defineProperty(minted, 'installation', {
      value: async () => {
        // A run's first step reaches the network before any child exists, which is where a
        // signal used to fall through the gap. Slowed on request so that window is real.
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          token: 'ghs_recorded',
          expiresAt: '2026-08-23T02:00:00Z',
          login: 'reveer-jen-dev[bot]',
          email: '316769915+reveer-jen-dev[bot]@users.noreply.github.com',
        };
      },
    });
    return minted;
  }

  function build(extra: Record<string, string> = {}, keepDirectory = false, options: Partial<ExecOptions> = {}): Executor {
    return new Executor({
      env: environment(extra),
      claude: [process.execPath, stub],
      remote: () => origin,
      root: scratch,
      github: host(),
      keepDirectory,
      ...options,
    });
  }

  async function launched(request = REQUEST, extra: Record<string, string> = {}, keep = false) {
    rmSync(record, { force: true });
    const outcome = await build(extra, keep).launch(request);
    const invoked = existsSync(record)
      ? (JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> })
      : undefined;
    return { outcome, invoked };
  }

  it('runs the session and reports what it cost', async () => {
    const { outcome, invoked } = await launched();

    expect(outcome.failures).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.cost).toBe(0.5);
    expect(outcome.sessionId).toBe('s-1');
    expect(invoked).toBeDefined();
  });

  it('invokes the skill by name with the task, and puts the prompt last', async () => {
    const { invoked } = await launched();

    expect(invoked!.argv.at(-1)).toBe('/implement-task ENG-1');
    expect(invoked!.argv.at(-2)).toBe('-p');
    expect(invoked!.argv).toContain('--permission-mode');
    expect(invoked!.argv[invoked!.argv.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(invoked!.argv).toContain('--permission-prompts');
    expect(invoked!.argv[invoked!.argv.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(invoked!.argv).toContain('--verbose');
    expect(invoked!.argv[invoked!.argv.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  // `--bare` skips discovery of skills, MCP servers, memory, and `CLAUDE.md` — which is the
  // entirety of what jen installs. A session missing them is not a stage.
  it('does not run bare', async () => {
    const { invoked } = await launched();

    expect(invoked!.argv).not.toContain('--bare');
  });

  it('works in a clone of the repository, at the task’s branch', async () => {
    const { invoked } = await launched({ ...REQUEST, branch: 'eng-2-designed' }, {}, true);

    expect(git(['branch', '--show-current'], invoked!.cwd)).toBe('eng-2-designed');
    expect(existsSync(join(invoked!.cwd, 'design.md'))).toBe(true);
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // A branch placed off `origin/<branch>` tracks it; one placed off `FETCH_HEAD` tracks
  // nothing, and the session's own `git push` fails with *has no upstream branch* — on every
  // stage after design, which is every stage that resumes a branch.
  it('leaves the resumed branch tracking its remote, so the session can push it', async () => {
    const { invoked } = await launched({ ...REQUEST, branch: 'eng-2-designed' }, {}, true);

    expect(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], invoked!.cwd)).toBe(
      'origin/eng-2-designed',
    );
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // Runner git calls inherit the operator's global configuration. Branch placement must
  // name both the start point and the tracking relationship instead of depending on DWIM:
  // `checkout.guess = false` rejects `git switch <branch>`, while
  // `branch.autoSetupMerge = false` silently leaves the branch without an upstream.
  it('places and tracks a resumed branch when the operator disables git’s branch defaults', async () => {
    const config = join(scratch, 'hostile-gitconfig');
    writeFileSync(config, '[checkout]\n\tguess = false\n[branch]\n\tautoSetupMerge = false\n');
    // Only the git spawns are arranged against; the session spawn goes through untouched.
    // Layering `process.env` under it would put the host's real environment back beneath the
    // closed one `childEnvironment` built — re-adding the very `JEN_*` keys the strip leaves
    // out rather than sets undefined, and, now that the stub records its environment whole,
    // writing the runner's secrets to `record.json`. That would be a spawner quietly
    // defeating the invariant this file exists to test.
    const hostile: Spawner = (spec) =>
      spec.command === 'git'
        ? spawner({ ...spec, env: { ...process.env, ...spec.env, GIT_CONFIG_GLOBAL: config } })
        : spawner(spec);

    rmSync(record, { force: true });
    const outcome = await build({}, true, { spawn: hostile }).launch({ ...REQUEST, branch: 'eng-2-designed' });
    expect(outcome.ok).toBe(true);
    const invoked = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string; env: Record<string, string> };
    expect(git(['branch', '--show-current'], invoked.cwd)).toBe('eng-2-designed');
    expect(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], invoked.cwd)).toBe(
      'origin/eng-2-designed',
    );
    // The session still received the closed environment, not the host's. This test's base env
    // carries no `PATH`, so the prepended shim dir stands in for the whole of it — in
    // production it would be `<binDir><delimiter><runner PATH>`. And no `JEN_*` the host may
    // hold — on a runner carrying the pipeline's own secrets, that is another role's private key.
    expect(invoked.env.PATH).toBe(join(invoked.cwd, '..', 'bin'));
    expect(Object.keys(invoked.env).filter((key) => key.startsWith('JEN_'))).toEqual([]);
    rmSync(join(invoked.cwd, '..'), { recursive: true, force: true });
  });

  // The defect this replaced: `git fetch origin <branch>` exits 128 both when the ref is
  // absent and when the fetch could not happen at all, so a transport or auth failure was
  // read as "the remote has no such branch" and the session was handed a branch cut from the
  // default one, carrying none of the task's history. The stage would then read the task as
  // untouched, redo it, write to the tracker, and fail only at the push.
  it('places a branch the remote has even when the remote goes unreachable after the clone', async () => {
    const moved = `${origin}-unreachable`;
    // The origin disappears the instant the clone finishes, so anything reaching for the
    // remote past that point fails exactly as an unreachable host or a dead credential does.
    const cutOff: Spawner = (spec) => {
      const child = spawner(spec);
      if (spec.args[0] === 'clone') void child.exited.then(() => renameSync(origin, moved)).catch(() => {});
      return child;
    };

    rmSync(record, { force: true });
    let outcome: RunOutcome;
    try {
      outcome = await build({}, true, { spawn: cutOff }).launch({ ...REQUEST, branch: 'eng-2-designed' });
    } finally {
      if (existsSync(moved)) renameSync(moved, origin);
    }
    const invoked = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };

    expect(outcome.ok).toBe(true);
    expect(git(['branch', '--show-current'], invoked.cwd)).toBe('eng-2-designed');
    // The history is the point: a branch off the default one would not carry this.
    expect(existsSync(join(invoked.cwd, 'design.md'))).toBe(true);
    rmSync(join(invoked.cwd, '..'), { recursive: true, force: true });
  });

  // The pipeline's entry point: `design-task` runs against a branch that does not exist yet,
  // so a clone insisting on the branch would fail every design dispatch.
  it('creates the branch locally where the remote has none, and does not push it', async () => {
    const { outcome, invoked } = await launched({ ...REQUEST, branch: 'eng-9-never-designed' }, {}, true);

    expect(outcome.ok).toBe(true);
    expect(git(['branch', '--show-current'], invoked!.cwd)).toBe('eng-9-never-designed');
    expect(git(['branch', '--list', 'eng-9-never-designed'], origin)).toBe('');
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // The token governs what a run may do; the git config governs what the history says it
  // was. Without this, commits carry whatever identity the host has — a person's, locally.
  it('commits under the role’s app identity rather than the host’s', async () => {
    const { invoked } = await launched(REQUEST, {}, true);

    expect(git(['config', 'user.name'], invoked!.cwd)).toBe('reveer-jen-dev[bot]');
    expect(git(['config', 'user.email'], invoked!.cwd)).toBe('316769915+reveer-jen-dev[bot]@users.noreply.github.com');
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  it('trusts the clone in a config store of its own', async () => {
    const { invoked } = await launched(REQUEST, {}, true);
    const store = JSON.parse(readFileSync(join(invoked!.env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };

    expect(store.projects[invoked!.cwd]!.hasTrustDialogAccepted).toBe(true);
    expect(invoked!.env.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // `pipeline-identity` requires that a session cannot obtain another role's credentials, and
  // a session inherits whatever the runner's environment held — which on a runner configured
  // for all three roles is all three private keys.
  it('hands the session its own token and none of another role’s credentials', async () => {
    const { invoked } = await launched();

    expect(invoked!.env.GH_TOKEN).toBe('ghs_recorded');
    expect(invoked!.env.LINEAR_API_KEY).toBe('lin_api_recorded');
    expect(Object.keys(invoked!.env).filter((key) => key.startsWith('JEN_GH_'))).toEqual([]);
    expect(JSON.stringify(invoked!.env)).not.toContain('another role’s key');
  });

  // `stage-execution` requires the session be given the credential the run holds, under that
  // credential's own name, and the name it does not hold be absent. Both directions are
  // asserted because the failure is asymmetric: the wrong name present is a session spending
  // a credential the adopter did not choose, and the right one absent is a session that
  // cannot reach a model at all.
  it('gives the session the model credential the run holds, and not the other name', async () => {
    const key = await launched();

    expect(key.invoked!.env.ANTHROPIC_API_KEY).toBe('sk-ant-recorded');
    expect(key.invoked!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    // What a hosted runner given only the token actually looks like: the other secret is
    // declared in the workflow and expands to an empty value rather than being absent.
    const token = await launched(REQUEST, { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-recorded' });

    expect(token.invoked!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-recorded');
    expect(token.invoked!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // The case a whole run cannot reach, because `credentialsFor` refuses a runner holding both
  // from the same environment `childEnvironment` is handed. Asserted here against a constructed
  // one so the unit's contract is true on its own terms rather than by its caller's grace — if
  // the upstream refusal were ever relaxed, this is what would still be holding the line.
  it('deletes the unheld model credential even when the base environment carries a value for it', () => {
    const { env } = childEnvironment(
      { ANTHROPIC_API_KEY: 'sk-ant-inherited', PATH: '/usr/bin' },
      'implement-task',
      {
        repo: 'reveer-ai/jen',
        role: 'dev',
        appId: '4588651',
        installation: '153578694',
        privateKey: 'unused',
        trackerToken: 'lin_api_recorded',
        model: { variable: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat-recorded' },
      },
      'ghs_recorded',
      '/tmp/config',
      '/tmp/askpass',
      '/tmp/bin',
    );

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-recorded');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // The project's own `PATH` is kept — the shim dir is prepended to it, not swapped for it.
    expect(env.PATH).toBe(`/tmp/bin${delimiter}/usr/bin`);
  });

  /**
   * What a session inherits, and the lever that narrows it.
   *
   * The passthrough is the mechanism `stage-execution` requires and the code has always had:
   * a project's checks read configuration jen cannot enumerate, so the runner's environment
   * arrives with the commands that read it. What is new is that a name can be spoken for.
   */
  describe('the environment a session inherits', () => {
    const DELIVER: RunRequest = { task: 'ENG-1', skill: 'deliver-task', role: 'deliver', branch: 'eng-1-a-task' };
    const TEST: RunRequest = { task: 'ENG-1', skill: 'test-task', role: 'deliver', branch: 'eng-1-a-task' };
    const project = { DATABASE_URL: 'postgres://localhost/test', SMOKE_TARGET: 'https://staging.example' };

    it('hands a session the variables the operator set on the runner, under their own names', async () => {
      const { invoked } = await launched(REQUEST, project);

      expect(invoked!.env.DATABASE_URL).toBe('postgres://localhost/test');
      expect(invoked!.env.SMOKE_TARGET).toBe('https://staging.example');
    });

    // Wider than the `JEN_GH_` strip the role requirement needs, and exhaustive for the same
    // reason it is safe: jen defines what is in its namespace, so a prefix test over it has
    // no unnamed member to miss. The runner's own configuration is in there and nothing
    // inside a session reads it.
    it('withholds every variable in jen’s namespace, not only the role credentials', async () => {
      const { invoked } = await launched(REQUEST, { JEN_TEAM: 'eng', JEN_PROJECT: 'jen' });

      expect(Object.keys(invoked!.env).filter((key) => key.startsWith('JEN_'))).toEqual([]);
      expect(invoked!.env.JEN_REPO).toBeUndefined();
    });

    it('gives a declared variable to the stage it is declared for', async () => {
      const { outcome, invoked } = await launched(TEST, { ...project, JEN_ENV_TEST_TASK: 'SMOKE_TARGET' });

      expect(invoked!.env.SMOKE_TARGET).toBe('https://staging.example');
      // Undeclared, so it is nobody's and reaches everyone.
      expect(invoked!.env.DATABASE_URL).toBe('postgres://localhost/test');
      expect(outcome.notes).toEqual([]);
    });

    /**
     * The case a role-keyed rule gets wrong, and the reason this keys on the stage.
     *
     * Reviewing, testing, and delivering all act as `deliver`, so an arrangement reading the
     * role would hand the stage that merges exactly what was meant for the stage that tests.
     * Both requests below name that same role deliberately.
     */
    it('keeps a declared variable from every other stage, including one sharing its role', async () => {
      const declared = { ...project, JEN_ENV_TEST_TASK: 'SMOKE_TARGET' };

      const delivering = await launched(DELIVER, declared);
      expect(delivering.invoked!.env.SMOKE_TARGET).toBeUndefined();
      expect(delivering.invoked!.env.DATABASE_URL).toBe('postgres://localhost/test');

      const implementing = await launched(REQUEST, declared);
      expect(implementing.invoked!.env.SMOKE_TARGET).toBeUndefined();
    });

    // Falls out of set membership rather than needing a rule: the name is in two `mine` sets.
    it('gives a name two stages declared to both of them', async () => {
      const both = { ...project, JEN_ENV_TEST_TASK: 'SMOKE_TARGET', JEN_ENV_DELIVER_TASK: 'SMOKE_TARGET' };

      expect((await launched(TEST, both)).invoked!.env.SMOKE_TARGET).toBe('https://staging.example');
      expect((await launched(DELIVER, both)).invoked!.env.SMOKE_TARGET).toBe('https://staging.example');
      expect((await launched(REQUEST, both)).invoked!.env.SMOKE_TARGET).toBeUndefined();
    });

    /**
     * The misspelling that would otherwise be the worst outcome in the change.
     *
     * `JEN_ENV_TEST` reads as a declaration for a stage no request runs. Parsed rather than
     * discarded, its names would be claimed by nobody and withheld from *everybody* — a
     * variable the operator meant to narrow would vanish everywhere, silently. So it fails
     * open, which is only defensible because the run says so by name.
     */
    it('reports a declaration naming no stage, and withholds nothing for it', async () => {
      const { outcome, invoked } = await launched(TEST, { ...project, JEN_ENV_TEST: 'SMOKE_TARGET' });

      expect(invoked!.env.SMOKE_TARGET).toBe('https://staging.example');
      expect((await launched(DELIVER, { ...project, JEN_ENV_TEST: 'SMOKE_TARGET' })).invoked!.env.SMOKE_TARGET).toBe(
        'https://staging.example',
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.failures).toEqual([]);
      expect(outcome.notes).toEqual([expect.stringContaining('JEN_ENV_TEST names no stage')]);
      // Named beside the valid ones, since the whole value of the note is telling the
      // operator what they should have written.
      expect(outcome.notes[0]).toContain('JEN_ENV_TEST_TASK');
    });

    // Nothing is at risk and no stage is short of anything it would have had, so stopping a
    // pipeline over it would be out of all proportion to a declaration that did nothing.
    //
    // The list is written `A, B` here rather than `A,B`, so the names reported back are also
    // what says the entries were trimmed: an untrimmed ` SMOKE_TARGET` is a name that could
    // never match a variable and would silently withhold nothing while claiming to.
    it('reports a declared variable the runner does not hold, without failing the run', async () => {
      const { outcome } = await launched(TEST, { JEN_ENV_TEST_TASK: 'STAGING_SSH_KEY, SMOKE_TARGET' });

      expect(outcome.ok).toBe(true);
      expect(outcome.failures).toEqual([]);
      expect(outcome.notes).toEqual([
        expect.stringContaining('JEN_ENV_TEST_TASK restricts STAGING_SSH_KEY, which the runner does not hold'),
        expect.stringContaining('JEN_ENV_TEST_TASK restricts SMOKE_TARGET, which the runner does not hold'),
      ]);
    });

    // The migration promise: an operator who declares nothing sees what they saw before,
    // less three variables nothing inside a session ever read.
    it('changes nothing for an operator who declares no restriction', async () => {
      const { outcome, invoked } = await launched(REQUEST, project);

      expect(outcome.notes).toEqual([]);
      expect(invoked!.env.DATABASE_URL).toBe('postgres://localhost/test');
      expect(invoked!.env.GH_TOKEN).toBe('ghs_recorded');
      expect(invoked!.env.CLAUDE_CONFIG_DIR).toBeDefined();
    });

    // Assigned after the copy, so a declaration cannot reach them. An operator who names one
    // has written something inert, which is why it earns no note.
    it('lets jen’s own variables win over a declaration naming them', async () => {
      const { invoked } = await launched(DELIVER, { JEN_ENV_TEST_TASK: 'GH_TOKEN,LINEAR_API_KEY' });

      expect(invoked!.env.GH_TOKEN).toBe('ghs_recorded');
      expect(invoked!.env.LINEAR_API_KEY).toBe('lin_api_recorded');
    });
  });

  // The same rule as the tracker payload below, on the same host: an installation token
  // spliced into the clone URL is an argv element of `git clone`, and `/proc/<pid>/cmdline`
  // is world-readable where `/proc/<pid>/environ` is owner-only.
  it('answers git’s prompt out of the environment rather than out of a command line', async () => {
    const { invoked } = await launched(REQUEST, {}, true);
    const askpass = invoked!.env.GIT_ASKPASS!;

    expect(askpass).toContain(invoked!.env.CLAUDE_CONFIG_DIR!);
    expect(existsSync(askpass)).toBe(true);
    expect(readFileSync(askpass, 'utf8')).not.toContain('ghs_recorded');
    // Set for the session too, so an unattended `git push` fails rather than waiting on a
    // prompt into a stdin nobody is attached to.
    expect(invoked!.env.GIT_TERMINAL_PROMPT).toBe('0');
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // The handshake itself, rather than the script's text. `git credential fill` is the same
  // path a `git push` from the session takes, with the configured helpers cleared so the
  // answer can only have come from the script.
  it('hands git the token when git asks for it', async () => {
    const { invoked } = await launched(REQUEST, {}, true);
    const filled = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\nusername=x-access-token\n\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        // Both config files taken out of the picture, so a helper configured on the machine
        // running the tests cannot answer in the script's place.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ASKPASS: invoked!.env.GIT_ASKPASS!,
        GH_TOKEN: 'ghs_recorded',
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    expect(filled).toContain('password=ghs_recorded');
    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // Every stage runs `openspec`, and the session's clone has no `node_modules` and no
  // `openspec` on the inherited `PATH`. The run writes the same wrapper into its own `bin/`
  // (prepended to `PATH`, for bare `openspec`) and a sibling `node_modules/.bin/` (found by
  // `npm exec`'s walk-up, for `npx openspec` — which never consults `PATH`).
  it('puts an openspec shim on the session PATH and in a node_modules/.bin above the clone', async () => {
    const { invoked } = await launched(REQUEST, {}, true);
    const bin = join(invoked!.cwd, '..', 'bin');

    expect(invoked!.env.PATH!.startsWith(bin + delimiter) || invoked!.env.PATH === bin).toBe(true);

    for (const shim of [join(bin, 'openspec'), join(invoked!.cwd, '..', 'node_modules', '.bin', 'openspec')]) {
      expect(existsSync(shim)).toBe(true);
      expect(statSync(shim).mode & 0o111).toBeTruthy();

      const text = readFileSync(shim, 'utf8');
      expect(text).toContain(process.execPath);
      expect(text).toContain(openspecBin());
    }

    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // What proves the resolution works rather than that a file was written: run the shim with
  // an empty `PATH` and confirm it reaches OpenSpec's own CLI. The version it prints is the
  // one jen depends on — `openspecBin()` resolves from jen's own tree.
  it('resolves OpenSpec through the shim with an empty PATH', async () => {
    const { invoked } = await launched(REQUEST, {}, true);
    const shim = join(invoked!.cwd, '..', 'bin', 'openspec');

    const printed = execFileSync(shim, ['--version'], {
      encoding: 'utf8',
      env: { PATH: '' },
    }).trim();

    const manifest = JSON.parse(
      readFileSync(join(dirname(openspecBin()), '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(printed).toContain(manifest.version);

    rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
  });

  // The other half of the same claim: `npm exec` walking up from the session cwd for
  // `node_modules/.bin/openspec` before it reaches the registry. Run `npx openspec` from the
  // clone with a `PATH` that carries `sh`/`node`/`npx` but no `openspec`, so the only way it
  // prints jen's pinned version is the walk-up finding the shim.
  it('resolves OpenSpec through `npx` via the node_modules/.bin shim', async () => {
    const { invoked } = await launched(REQUEST, {}, true);
    const home = mkdtempSync(join(tmpdir(), 'jen-npx-'));

    try {
      const printed = execFileSync('npx', ['openspec', '--version'], {
        cwd: invoked!.cwd,
        encoding: 'utf8',
        env: { HOME: home, PATH: ['/bin', '/usr/bin', dirname(process.execPath)].join(delimiter) },
      }).trim();

      const manifest = JSON.parse(
        readFileSync(join(dirname(openspecBin()), '..', 'package.json'), 'utf8'),
      ) as { version: string };
      expect(printed).toContain(manifest.version);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(join(invoked!.cwd, '..'), { recursive: true, force: true });
    }
  });

  // A command line is readable by every process on the host, and this string carries the
  // tracker credential.
  it('passes the tracker server as a file rather than on the command line', async () => {
    const { invoked } = await launched();
    const config = invoked!.argv[invoked!.argv.indexOf('--mcp-config') + 1]!;

    expect(invoked!.argv.join(' ')).not.toContain('lin_api_recorded');
    expect(config).toContain(invoked!.env.CLAUDE_CONFIG_DIR!);
  });

  it('removes everything it created when the run ends', async () => {
    const { invoked } = await launched();

    expect(existsSync(invoked!.cwd)).toBe(false);
    expect(existsSync(invoked!.env.CLAUDE_CONFIG_DIR!)).toBe(false);
  });

  it('removes everything it created when the session failed', async () => {
    const { outcome, invoked } = await launched(REQUEST, { STUB_EXIT: '1' });

    expect(outcome.ok).toBe(false);
    expect(existsSync(invoked!.cwd)).toBe(false);
  });

  it('reports the untrusted-workspace warning as a failure of the run', async () => {
    const { outcome } = await launched(REQUEST, {
      STUB_STDERR: 'Ignoring 8 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toEqual([expect.stringContaining('never trusted')]);
  });

  it('reports a tracker that did not connect', async () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 's-1', mcp_servers: [{ name: 'linear', status: 'failed' }] },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's-1' },
    ];
    const { outcome } = await launched(REQUEST, { STUB_EVENTS: JSON.stringify(events) });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toEqual([expect.stringContaining('tracker connection did not initialize')]);
  });

  // No session is started, and the missing credential is named.
  it('refuses before starting a session when a credential is missing', async () => {
    rmSync(record, { force: true });
    const env = environment();
    delete env.ANTHROPIC_API_KEY;
    const outcome = await new Executor({
      env,
      claude: [process.execPath, stub],
      remote: () => origin,
      root: scratch,
      github: host(),
    }).launch(REQUEST);

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toEqual([
      expect.stringContaining('ANTHROPIC_API_KEY'),
    ]);
    // Both accepted names, because pointing the operator at only the form they chose not to
    // use is worse than saying nothing.
    expect(outcome.failures[0]).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(existsSync(record), 'no session was started').toBe(false);
  });

  it('gives two concurrent runs working copies neither can reach', async () => {
    const first = join(scratch, 'record-1.json');
    const second = join(scratch, 'record-2.json');
    await Promise.all([
      build({ STUB_RECORD: first }).launch(REQUEST),
      build({ STUB_RECORD: second }).launch({ ...REQUEST, task: 'ENG-2' }),
    ]);

    const one = JSON.parse(readFileSync(first, 'utf8')) as { cwd: string };
    const two = JSON.parse(readFileSync(second, 'utf8')) as { cwd: string };
    expect(one.cwd).not.toBe(two.cwd);
  });

  // Termination is ordinary operation — a stopping runner and whatever supervises one both
  // produce it — so it is handled deterministically rather than as a crash path.
  it('stops its session on termination, cleans up, and leaves the outcome saying so', async () => {
    rmSync(record, { force: true });
    const sessions = build({ STUB_SLEEP: '30000' });
    const running = sessions.launch(REQUEST);

    // Wait for the session to actually be up before stopping it.
    for (let attempt = 0; attempt < 200 && !existsSync(record); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(record), 'the stub session started').toBe(true);
    sessions.terminate();

    const outcome: RunOutcome = await running;
    const invoked = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };

    expect(outcome.terminated).toBe(true);
    expect(outcome.sessionStarted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(existsSync(invoked.cwd), 'the working copy went with the run').toBe(false);
  });

  // `terminate()` reaches only what is already running, so a signal landing before the first
  // child — during the minting, where none exists at all — used to leave the run to clone,
  // configure, and start a full session after it had been told to stop. A stage would then
  // write to the tracker and push commits past its own cancellation.
  it('starts no session when it was stopped before one existed', async () => {
    rmSync(record, { force: true });
    const sessions = new Executor({
      env: environment(),
      claude: [process.execPath, stub],
      remote: () => origin,
      root: scratch,
      github: host(200),
    });
    const running = sessions.launch(REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 50));
    sessions.terminate();

    const outcome: RunOutcome = await running;

    expect(existsSync(record), 'no session was started').toBe(false);
    expect(outcome.sessionStarted).toBe(false);
    expect(outcome.terminated).toBe(true);
    expect(outcome.ok).toBe(false);
  });

  // The other half of the same fix, and the race it closes: a signal arriving in the instant
  // between the session finishing and the run reading the flag. Read straight off the flag,
  // a run that had already finished and succeeded reported as stopped, and `see()` then
  // described its task as left mid-stage when the stage had in fact completed.
  it('does not call a finished run stopped because a signal arrived as it ended', async () => {
    let sessions: Executor;
    const stopOnExit: Spawner = (spec) => {
      const child = spawner(spec);
      if (spec.command === process.execPath) void child.exited.then(() => sessions.terminate());
      return child;
    };
    sessions = build({}, false, { spawn: stopOnExit });

    const outcome = await sessions.launch(REQUEST);

    expect(sessions.terminating, 'the signal really did land').toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.terminated).toBe(false);
  });

  // Cleanup is the whole of how `stage-execution`'s "no credential remains on the host" is
  // satisfied — `config/mcp.json` holds the tracker's, live until someone rotates it — so
  // the one case that violates the requirement must not be the one case nothing reports.
  it('reports a run directory it could not remove, naming where it is', async () => {
    if (process.getuid?.() === 0) return; // root ignores the permission this test relies on.
    const locked = await realpath(await mkdtemp(join(tmpdir(), 'jen-locked-')));
    try {
      const outcome = await new Executor({
        env: environment({ STUB_LOCK: locked }),
        claude: [process.execPath, stub],
        remote: () => origin,
        root: locked,
        github: host(),
      }).launch(REQUEST);

      expect(outcome.ok).toBe(false);
      expect(outcome.failures.at(-1)).toContain(locked);
      expect(outcome.failures.at(-1)).toContain('tracker credential');
      // The session's own verdict is not displaced by the sweep's — it is added beside it.
      expect(outcome.sessionId).toBe('s-1');
      expect(outcome.cost).toBe(0.5);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it('makes its directories where it was told to', async () => {
    // Resolved for the comparison, because the run resolves its own — see the note in
    // `exec.ts`, where that is load-bearing rather than tidiness.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'jen-root-')));
    await new Executor({
      env: environment(),
      claude: [process.execPath, stub],
      remote: () => origin,
      root,
      github: host(),
    }).launch(REQUEST);

    const invoked = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };
    expect(invoked.cwd.startsWith(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
  /**
   * A durable copy of a session's stream is a disclosure — it holds the repository's
   * content, every tool result, and whatever the stage read — so it happens where the
   * operator asked for one and nowhere else.
   */
  describe('a session’s transcript', () => {
    it('is discarded with the run unless somewhere was named for it', async () => {
      const { outcome } = await launched();

      expect(outcome.transcriptPath, 'nothing was kept, and the record has to be able to say so').toBeUndefined();
      expect(outcome.transcript, 'the stream itself is still read — it is what the verdict rests on').toContain('result');
    });

    it('is written where it was asked for, and the outcome names the file', async () => {
      const kept = join(scratch, 'transcripts');
      const outcome = await build({}, false, { transcripts: kept }).launch(REQUEST);

      expect(outcome.transcriptPath, outcome.failures.join('\n')).toBeDefined();
      expect(outcome.transcriptPath!.startsWith(kept)).toBe(true);
      expect(outcome.transcriptPath).toContain('ENG-1');
      expect(readFileSync(outcome.transcriptPath!, 'utf8')).toBe(outcome.transcript);
      expect(outcome.ok).toBe(true);
    });

    // The run's own directory is removed on every exit path, holding the tracker credential
    // with it. A transcript kept inside it would be swept along with the thing it is for.
    it('outlives the run directory it was streamed from', async () => {
      const kept = join(scratch, 'outlives');
      const outcome = await build({}, false, { transcripts: kept }).launch(REQUEST);

      const invoked = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };
      expect(existsSync(invoked.cwd), 'the clone is gone').toBe(false);
      expect(existsSync(outcome.transcriptPath!), 'the transcript is not').toBe(true);
    });

    // Reported with the run's other failures rather than raised over them, and — unlike a
    // failed sweep — it does not make a successful session a failed one. Nothing about the
    // session changed; a file beside it could not be written.
    it('is reported when it cannot be written, without changing what the session did', async () => {
      const occupied = join(scratch, 'not-a-directory');
      writeFileSync(occupied, 'a file sitting where a directory was named\n');

      const outcome = await build({}, false, { transcripts: occupied }).launch(REQUEST);

      expect(outcome.ok, 'the session itself succeeded').toBe(true);
      expect(outcome.transcriptPath).toBeUndefined();
      expect(outcome.failures.at(-1)).toContain('transcript could not be written');
      expect(outcome.cost, 'the session’s own result is untouched').toBe(0.5);
    });

    // `sessionStarted` and "there is a transcript" are different questions, and this is
    // where they come apart: the flag is set the instant the child exists, before its exit
    // is awaited, so a `claude` that isn't on `PATH` reaches the catch with the flag true
    // and the stream still empty. A zero-byte file is worse than no file — the run record
    // names it as a transcript that was kept, and reading it says nothing about why.
    it('keeps nothing for a session that started and then produced no stream', async () => {
      const kept = join(scratch, 'no-stream');
      const failsToRun: Spawner = (spec) =>
        spec.command === process.execPath
          ? { exited: Promise.reject(new Error('spawn claude ENOENT')), kill: () => {} }
          : spawner(spec);

      const outcome = await build({}, false, { transcripts: kept, spawn: failsToRun }).launch(REQUEST);

      expect(outcome.sessionStarted, 'the child existed, so the run really did get this far').toBe(true);
      expect(outcome.ok).toBe(false);
      expect(outcome.transcript, 'and nothing came back from it').toBe('');
      expect(outcome.transcriptPath, 'so the record names no transcript').toBeUndefined();
      expect(existsSync(kept), 'and no directory is made to hold an empty one').toBe(false);
    });

    it('keeps nothing for a run whose session never started', async () => {
      const kept = join(scratch, 'never-started');
      const executor = build({}, false, { transcripts: kept });
      executor.terminate('SIGTERM');

      const outcome = await executor.launch(REQUEST);

      expect(outcome.sessionStarted).toBe(false);
      expect(outcome.transcriptPath).toBeUndefined();
      expect(existsSync(kept), 'no directory is made for a transcript that does not exist').toBe(false);
    });
  });
});
