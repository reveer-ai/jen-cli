import { describe, expect, it } from 'vitest';

import { readRepoFile, trackedFiles } from './helpers.js';

const workflow = readRepoFile('AGENTS.md');

// The rule the git host cannot express. The branch asks for one approval and cannot ask
// which stage gives it, so implement-task's restraint is a convention rather than a setting —
// which makes where it is written the only thing keeping it true. It goes in the document
// every stage reads, once. Two copies drift, and the copy a
// stage happens to read is then a coin toss between a current rule and a stale one.
describe('the approval convention', () => {
  it('is stated in the workflow document every stage reads', () => {
    expect(workflow).toContain('only review-task');
    expect(workflow).toContain('only deliver-task merges');
  });

  it('is stated nowhere else', () => {
    // Scoped to the skills, because they are what would restate it: a stage skill telling
    // its own reader not to approve is the obvious place to put this and the wrong one.
    //
    // Both halves, because the rule has two and either can be restated alone. The approval
    // half is the one at risk today, but a guard that covers one half of a two-half rule is
    // a guard that reports clean while the rule forks.
    const halves = ['only review-task', 'only deliver-task merges'];
    const restated = trackedFiles().filter(
      (path) =>
        path.startsWith('.claude/skills/') &&
        halves.some((half) => readRepoFile(path).includes(half)),
    );
    expect(restated, 'the convention is stated in more than one place').toEqual([]);
  });
});
