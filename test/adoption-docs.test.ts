/**
 * The adopter's front page, held to the few claims that are load-bearing rather than to its
 * prose.
 *
 * Every one of these is a thing an adopter finds out the hard way when the documentation
 * does not say it: an edit lost to the next update, or a rule they never wrote because they
 * believed the file it goes in was jen's. Nothing at runtime reports either.
 */
import { describe, expect, it } from 'vitest';

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
  const chapter = readme.slice(at('### 4. Permissions'), at('### 5. Take a later version'));

  it('says an action is judged on what it is, and that ordinary work needs no entry', () => {
    expect(chapter).toMatch(/judges each action on what the action is/);
    expect(chapter).toMatch(/needs no entry anywhere/);
  });

  /**
   * The judgment used to arrive with the executor, which launched every session in auto mode and
   * handed it the tracker's MCP configuration. jen launches nothing now, so both depend on how the
   * stage is invoked — and a chapter that states them as facts promises what nothing supplies.
   */
  it('makes the judgment the invoker\u2019s mode, and the tracker tools the adopter\u2019s own', () => {
    expect(chapter).toMatch(/judgment belongs to the mode, not to jen/);
    expect(chapter).toMatch(/unattended invocation .* has to select the judging mode itself/);
    expect(chapter).toMatch(/tracker's own tools come from your assistant's own MCP configuration/);
    expect(chapter, 'nothing grants them where a stage is invoked any more').not.toMatch(/granted where a stage is invoked/);
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
  it('says the file is the project\u2019s, in force in a stage\u2019s session, and shows entries not a file', () => {
    expect(chapter).toMatch(/`\.claude\/settings\.json` is still yours/);
    expect(chapter).toMatch(/in force in a stage's session/);
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

describe('the adoption path', () => {
  // Nothing performs this step, so a path that reads as if `init` had done it leaves an
  // adopter with a workflow pointing at nothing and no signal that it is.
  it('says the registry is filled in by hand', () => {
    const step = readme.slice(at('### 3. Fill in `registry.yaml`'), at('### 4. Permissions'));
    expect(step).toMatch(/`jen init` leaves the workflow pointing at nothing/);
    expect(step).toMatch(/by hand/);
  });

  it('names the command that takes a later version', () => {
    expect(readme.slice(at('### 5. Take a later version'))).toContain('npx jen update');
  });
});
