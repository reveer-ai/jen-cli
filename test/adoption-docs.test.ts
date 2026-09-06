/**
 * The adopter's front page, held to the few claims that are load-bearing rather than to its
 * prose.
 *
 * Every one of these is a thing an adopter finds out the hard way when the documentation
 * does not say it: an edit lost to the next update, a pipeline they cannot work out how to
 * stop, a runner they started believing it took the git host out of the picture, or a
 * session that hangs the loop with no timeout behind it. Nothing at runtime reports any of
 * them.
 */
import { describe, expect, it } from 'vitest';

import { NAMESPACE, VARIABLES } from '../cli/github.js';
import { PAUSED_STATUS_NAME } from '../cli/linear.js';
import { STAGES } from '../cli/stages.js';
import { readRepoFile } from './helpers.js';

const readme = readRepoFile('README.md');

/** Where a heading or a phrase sits in the file, for the claims whose *order* is the point. */
function at(text: string): number {
  const index = readme.indexOf(text);
  expect(index, `README.md does not contain ${text}`).toBeGreaterThan(-1);
  return index;
}

describe('the ownership boundary', () => {
  it('is stated before the installation command', () => {
    expect(at('## What jen owns, and what you own')).toBeLessThan(at('npx jen init'));
  });

  // Where the pipeline's tracker project is set. It used to be resolved into a managed file
  // as jen wrote it, so the boundary had to warn against editing that file; now the runner
  // reads the registry directly, and what the boundary owes an adopter is where to change it.
  it('names the registry as where the pipeline\'s project is set, and says who reads it', () => {
    const boundary = readme.slice(0, at('## Adopting jen'));

    expect(boundary).toMatch(/Change which project the pipeline polls in `registry\.yaml`/);
    expect(boundary).toMatch(/The runner reads it from the checkout/);
  });

  // The table says who reads the registry before the paragraph below it does, and it used to
  // credit "the workflow below" — the workflow row this change deletes. Both halves of that
  // were wrong once jen shipped no workflow: the reference dangled, and it attributed the read
  // to something that no longer exists. The row has to name the same reader the paragraph does.
  it('credits the runner, not a workflow, with reading the registry', () => {
    const boundary = readme.slice(0, at('## Adopting jen'));
    const row = boundary.split('\n').find((line) => line.startsWith('| `registry.yaml`'));

    expect(row).toMatch(/where the runner gets your tracker project from/);
    expect(row).not.toMatch(/workflow/);
  });

  // jen claimed exactly one path outside `.claude/` and the root — the scheduled workflow —
  // and claims none now. An adopter reading the table must not be told otherwise.
  it('claims no managed path outside .claude/ and the repository root', () => {
    const boundary = readme.slice(0, at('## Adopting jen'));

    expect(boundary).not.toContain('.github/workflows/jen.yml');
    expect(boundary).not.toMatch(/only managed file jen writes outside/);
  });

  it('does not present unstamping as a way to keep an edit to a shipped skill', () => {
    expect(readme).toContain('Deleting the stamp does not claim it');
    expect(readme).toMatch(/no supported way to keep an edit to a skill jen currently ships/);
  });
});

/**
 * The permissions chapter, which reversed: it used to be a list an adopter had to write.
 *
 * Both directions of that reversal are load-bearing and neither is visible at runtime. Telling
 * an adopter to enumerate their check commands sends them to write a list nothing reads; going
 * quiet about the file altogether would lose the seat their own rules take, and an adopter who
 * believes jen owns it will not put a rule there.
 */
describe('the permissions chapter', () => {
  const chapter = readme.slice(at('### 4. Permissions'), at('### 5. Give the stages'));

  it('says an action is judged on what it is, and that ordinary work needs no entry', () => {
    expect(chapter).toMatch(/judges each action on what the action is/);
    expect(chapter).toMatch(/needs no entry anywhere/);
  });

  /**
   * The starting shape jen used to ship — `npm run build`, `npm run lint`, `npm run typecheck`,
   * `npm test` — and the `pytest`/`ruff`/`mypy` example that told an adopter outside that
   * ecosystem to replace it. An adopter is not required to name any of them now, and a chapter
   * that still asks reads as a condition of unattended runs that no longer exists.
   */
  it('does not ask the adopter to grant their own check commands', () => {
    expect(chapter, 'jen ships no starting shape for anyone\u2019s conventional names').not.toMatch(/npm run (build|lint|typecheck)/);
    expect(chapter).not.toMatch(/Bash\((pytest|ruff|mypy|cargo|make)/);
    expect(chapter).not.toMatch(/[Aa]dd yours to the `allow` list/);
  });

  // The file survives the emptying, and an adopter who reads it as jen's will never put a rule
  // in it. The example beside it is the thing most likely to be pasted over a file that already
  // has contents, which is why it is shown as entries rather than as a document.
  it('says the file is the project\u2019s, in force in a dispatched run, and shows entries not a file', () => {
    expect(chapter).toMatch(/`\.claude\/settings\.json` is still yours/);
    expect(chapter).toMatch(/in force in a dispatched run/);
    expect(chapter).toMatch(/[Ee]ntries you add, not a file to paste over/);
    expect(chapter, 'a whole-file example is what gets pasted over a file that already has one').not.toContain('"permissions"');
  });

  /**
   * The chapter offers the file as the seat for a rule to permit *or* to deny, but the scaffold
   * ships `permissions.allow` and nothing else. An adopter who takes up the deny half has one
   * array in front of them, and a deny rule written into `allow` is a grant — the exact inversion
   * of what they were reaching for. Whichever array the text names, it has to name the right one.
   */
  it('sends a deny rule to a deny list rather than to the allow list jen ships', () => {
    if (!/to deny that it would otherwise let through/.test(chapter)) return;
    expect(chapter, 'the chapter offers a deny rule, so it must say where one goes').toMatch(/`deny`/);
    expect(chapter).toMatch(/a rule to deny goes in a `deny` list/);
  });

  // `jen update` never rewrites the file, so an install made before the emptying still carries
  // the entries jen wrote. Nothing removes them and nothing reports them; the documentation is
  // the only thing that reaches that install. It is also the only thing that can say the entries
  // are worth removing rather than merely permitted to stay — nothing else will ever tell them.
  it('tells an existing install the entries jen once wrote are theirs to keep or remove', () => {
    expect(chapter).toMatch(/installed before this changed/);
    expect(chapter).toMatch(/to keep or to remove/);
    expect(chapter).toMatch(/no version you take will empty it for you/);
    expect(chapter, 'a live bypass should not be described as costing nothing').not.toMatch(/costs you nothing/);
  });
});

/**
 * What a session receives, which the adopter is the only one who can supply.
 *
 * The failure this documentation prevents is quiet in both directions: a suite that cannot
 * reach its database because nobody said the runner's environment was where it comes from,
 * and a secret written into a declaration that was only ever meant to hold names.
 */
describe('the environment chapter', () => {
  const chapter = readme.slice(at('### 5. Give the stages'), at('### 6. Take a later version'));

  // Beside the permissions section deliberately: the two answer neighbouring halves of one
  // question. That one says a project's own commands run without being named in advance, and
  // this says how those same commands are given what they read.
  it('sits with the permissions guidance, and says what reaches a session', () => {
    expect(at('### 4. Permissions')).toBeLessThan(at('### 5. Give the stages'));
    expect(chapter).toMatch(/set on the runner reaches every stage|reaches every stage's session/);
  });

  /**
   * The passthrough is available on the runner jen ships, which is the only one it ships, so
   * the section carries no caveat naming a runner it is unavailable on. It used to: the
   * scheduled workflow was handed a closed list of names from a managed file and could not be
   * given another. A caveat that survived that runner would describe nothing, and an adopter
   * reading it would go looking for a restriction that no longer exists.
   */
  it('states the passthrough without qualifying which runner it is available on', () => {
    expect(chapter).not.toMatch(/the local runner's today/);
    expect(chapter).not.toMatch(/cannot carry your variables/);
    expect(chapter).not.toContain('.github/workflows/jen.yml');
  });

  // An adopter who reads the passthrough as unconditional has been told the runner's role
  // keys are handed to every session, which is the opposite of what happens.
  it('names the namespace withheld from sessions, and that the credentials are in it', () => {
    expect(chapter).toContain(NAMESPACE);
    expect(chapter).toMatch(/never reaches a session/);
    expect(chapter).toMatch(/role credentials are inside it|credentials.{0,60}inside it/is);
  });

  it('gives the declaration that narrows a variable, under the name jen reads', () => {
    expect(chapter).toContain(VARIABLES.stageScope('test-task'));
    for (const stage of STAGES) expect(chapter, `${stage.skill} is never named`).toContain(VARIABLES.stageScope(stage.skill));
  });

  /**
   * The trap this assertion exists for, and the reason it counts.
   *
   * `JEN_ENV_TEST_TASK=STAGING_SSH_KEY` is indistinguishable at a glance from a variable
   * holding a key, so an example with one name in it teaches an adopter to paste their secret
   * into the declaration. Two names is what makes a list read as a list.
   */
  it('says the declaration holds names, and shows more than one of them', () => {
    expect(chapter).toMatch(/list of variable \*names\*, not values|names, not values/);

    const example = /JEN_ENV_TEST_TASK=(\S+)/.exec(chapter);
    expect(example, 'the chapter shows no declaration').not.toBeNull();
    expect(example![1]!.split(',').length, 'the example names one variable, which reads as a value').toBeGreaterThan(1);
  });

  // An adopter reasoning from the roles expects testing's variable to be kept from delivery
  // because of the identities. It is not — they are one identity — and only the declaration
  // arranges it.
  it('says the narrowing keys on the stage, and that three stages share one role', () => {
    expect(chapter).toMatch(/by stage, not by role|keys on the stage/);
    expect(chapter).toMatch(/Reviewing, testing, and delivering all act under the one `deliver` role/);
  });

  it('says a declaration that scoped nothing is reported rather than fatal', () => {
    expect(chapter).toMatch(/reported in the run's output and does not fail it/);
  });
});

describe('the runner chapter', () => {
  const chapter = readme.slice(at('## Running the pipeline'), at('## Which assistants this reaches'));

  it('presents one runner jen ships, and names it without the local qualifier', () => {
    expect(chapter).toContain('jen watch');
    expect(chapter).toMatch(/jen ships one runner/);
    expect(chapter, 'in this documentation *local* meant "not the git host"').not.toMatch(/local runner/i);
  });

  // An adopter running the pipeline from their own machine will assume the git host went
  // with it, and nothing about starting a process on their own hardware tells them otherwise.
  it('says the runner does not remove the git host', () => {
    expect(chapter).toMatch(/does not remove the git host from it/);
    expect(chapter).toMatch(/merge gate/);
  });

  /**
   * A runner jen does not ship is the answer for anyone who wants their git host's scheduler,
   * and the reason jen stopped shipping one is the part that cannot be left out: a paste-ready
   * workflow carries jen's apparent endorsement back into the cost this removal exists to end.
   * So the chapter must say a scheduled git-host job is a valid runner, say why jen ships none,
   * and supply no file — which is what the last assertion holds, since a fenced YAML block with
   * a cron in it is what "supplying one" would look like.
   */
  it('says a runner jen does not ship is valid, why jen ships none, and supplies no example', () => {
    expect(chapter).toMatch(/scheduled job on your git host/);
    expect(chapter).toMatch(/holds a paid runner for the entire life of every stage session/);

    expect(chapter, 'a workflow file would be a recipe jen decided not to publish').not.toMatch(/on:\s*\n\s*schedule:/);
    expect(chapter).not.toMatch(/cron:/);
    expect(chapter).not.toMatch(/runs-on:/);
  });

  // The runner has no liveness bound, and the two ways that reaches an adopter are a session
  // that dies with the process and one that never finishes at all. Neither is visible from
  // starting it, and the second has nothing at runtime that would ever report it.
  it('names the conditions the runner carries', () => {
    expect(chapter).toMatch(/dies with the process that launched it/i);
    expect(chapter).toMatch(/a session is still working this/);
    expect(chapter).toMatch(/hung session hangs the loop/i);
  });

  /**
   * The one prerequisite whose failure does not present as itself.
   *
   * `--permission-prompts` is rejected as an unknown option below 2.1.259, and an unknown
   * option is refused before the session starts — no session, no transcript, and a run that
   * reports a stage which was dispatched and did nothing. An adopter reading that has no
   * reason to look at their CLI version, so the documentation has to have said it first.
   */
  it('states the assistant CLI version the pipeline requires, and what being below it looks like', () => {
    expect(chapter).toMatch(/Claude Code 2\.1\.259 or later/);
    expect(chapter).toMatch(/refused before the session starts/);
    expect(chapter).toMatch(/dispatched and did nothing/);
  });

  it('names every credential a runner needs, under the name the runner reads', () => {
    const roles = [...new Set(STAGES.map((stage) => stage.role))];
    const needed = [
      VARIABLES.tracker,
      ...VARIABLES.model,
      ...roles.flatMap((role) => [VARIABLES.appId(role), VARIABLES.installation(role), VARIABLES.privateKey(role)]),
    ];

    for (const name of needed) expect(chapter, `${name} is never named`).toContain(name);
    expect(chapter).toContain('Eleven values');
  });

  // The name alone is not the answer to "how do I get one": an adopter who has never minted
  // a token has no reason to know the command exists, and the assertion above only holds the
  // spelling.
  it('names the subscription token as an accepted form, and how it is obtained', () => {
    expect(chapter).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(chapter).toContain('claude setup-token');
    expect(chapter, 'that the command needs a subscription').toMatch(/requires a Claude subscription/);
  });

  /**
   * The cost of the subscription form, and the one claim about it that must stay negative.
   *
   * The shared window is what an adopter meets as a stage dying mid-run rather than as a bill,
   * so it has to be read before the choice rather than after it. The `SHALL NOT` is the part
   * most worth pinning: an earlier draft of this change had the asymmetry backwards and called
   * the token the less scoped credential, and an edit reintroducing that would weigh an
   * adopter's choice against a risk the credential does not carry.
   */
  it('states what the subscription costs, and does not overstate what the token carries', () => {
    expect(chapter, 'limits shared with the adopter\'s own work').toMatch(/usage limits are shared with your own interactive use/);
    expect(chapter, 'bound to the person who minted it').toMatch(/belongs to the person who minted it/);
    expect(chapter, 'the key is bound to no one person').toMatch(/issued independently of any one person/);

    expect(chapter, 'the authority it actually carries').toMatch(/inference-only/);
    expect(chapter, 'the token is never described as the broader credential').not.toMatch(/unscoped|unrestricted|full account access/i);
  });

  // A refusal an adopter meets with no warning reads as jen being broken, and the API key is
  // the way out of it — which is only useful said in advance, since the refusal comes from
  // their installation rather than from anything jen runs.
  it('names that a managed policy can refuse to mint the token, and what is left open', () => {
    expect(chapter).toMatch(/managed.{0,80}policy may forbid minting one/s);
    expect(chapter, 'read as a stated limit rather than a malfunction').toMatch(/stated limit on your installation rather than a malfunction/);
    expect(chapter, 'the other form stays available').toMatch(/`ANTHROPIC_API_KEY` is still open to you/);
  });

  // An adopter holding both is the ordinary state of a developer's machine, so what happens
  // then is a thing they read rather than discover. Refusing is the load-bearing half: a
  // reader who assumes a precedence assumes jen picked the one they meant.
  it('says holding both is refused rather than resolved by a precedence', () => {
    expect(chapter).toMatch(/A runner holds exactly one of them/);
    expect(chapter, 'the run refuses before it spends either').toMatch(/Set both and every run refuses before it starts a session/);
    expect(chapter, 'and does not choose').toMatch(/jen will not pick one for you/);
  });

  it('says what the pipeline does unsupervised, and what a human still owns', () => {
    expect(chapter).toContain('`Todo` → `In Design`');
    expect(chapter).toContain('`Pending` → `In Progress`');
    expect(chapter).toMatch(/parks anything only a person can settle/);
    expect(chapter).toContain('--concurrency');
  });

  it('documents the halt as the tracker\'s project status, under any runner', () => {
    const stopping = chapter.slice(chapter.indexOf('### Stopping it'));

    expect(stopping).toContain(PAUSED_STATUS_NAME);
    expect(stopping).toMatch(/halt under any runner, including one jen does not ship/);
    expect(stopping).toMatch(/no process to stop, no task's status to edit/);
  });

  // The status is one the adopter creates, so naming it is not enough on its own — an
  // adopter who cannot find it in Linear has no halt, and nothing else about the pipeline
  // looks any different. The rename is the same class of silence, one step later.
  //
  // That binding cannot check it belongs in the same test: an adopter who reads
  // `setup-jen`'s report as a verification believes the halt was confirmed when nothing
  // confirmed it. Nothing in the pipeline verifies this status, so the sentence saying so
  // is what stands in place of the check.
  it('says where to create the pause status, and what renaming it costs', () => {
    const stopping = chapter.slice(chapter.indexOf('### Stopping it'));

    expect(stopping, 'the category it goes under').toMatch(/In Progress.{0,40}categor|categor.{0,40}In Progress/s);
    expect(stopping, 'where in Linear').toMatch(/workspace settings/i);
    expect(stopping, 'renaming it turns the halt off').toMatch(/rename.{0,80}(halt|silent)/is);
    expect(stopping, 'binding reports it rather than verifying it').toMatch(/cannot check|could not check/i);
  });
});
