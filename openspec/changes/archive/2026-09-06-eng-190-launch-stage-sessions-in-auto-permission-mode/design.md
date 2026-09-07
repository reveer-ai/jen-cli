## Context

See `proposal.md` — Why. What follows is the mechanism, which is not obvious from the flag
names and decides several things the proposal only asserts.

**The classifier's decision order**, verified against the shipped documentation:

1. An action matching an `allow`, `ask`, or `deny` rule resolves immediately.
2. Read-only actions and edits inside the working directory are auto-approved.
3. Everything else goes to the classifier.
4. A classifier block returns a reason and Claude tries something else.

Three consequences follow that the issue's framing does not.

**An allow rule is not redundant under `auto` — it is a bypass.** Step 1 runs before the
classifier, so a matching rule is not "covered by auto anyway": it is the thing that stops
auto from looking. That inverts the second half of the task. The question is not whether
`auto` makes the entries unnecessary; it is whether we want the pipeline's own git-host
calls exempt from review.

**Whether some entries are discarded regardless is not established, and the decision does
not rest on it.** An earlier draft of this design asserted that `auto` drops
package-manager run commands and wildcarded interpreters from `permissions.allow` on entry,
and named three of jen's four npm entries as that category. Nothing in the record supports
it at that specificity. What 2.1.260 actually carries is (a) an opt-in setting, default
false, that suspends *every* Bash allow rule while auto mode is active, all-or-nothing rather
than by category; (b) an advisory `/auto-mode-setup` review that *flags* entries "broad
enough that auto mode either ignores them at runtime, or auto-approves destructive commands
with no check" and offers to remove them, with the person deciding. So a runtime-ignored
category does exist and is described by breadth — but `Bash(npm run build:*)` is a narrow
rule, and nothing found says it is one of them.

Left there deliberately rather than guessed at, because the conclusion does not need it. An
entry is a step-1 bypass; that alone is the reason to empty the list rather than trim it, and
it holds whether or not the mode would have dropped some of the entries anyway. Treating the
weaker claim as settled would have been worse than dropping it: it is the claim that tells an
adopter three of their old entries are already inert, and if they are not, those are live
bypasses the advice argued them into keeping.

**`--permission-prompts none` changes less than it appears to, and one thing that matters.**
A `-p` run with no permission host already denies anything that would prompt. What the flag
adds is that Claude is told nobody can approve and not to retry, and that the tools which
ask a person — `AskUserQuestion`, MCP elicitation — are *removed from the session*. The
second is the reason to pass it: `stage-execution` already requires that a run cannot block
on a human, and today that rests entirely on there being no channel for an answer. This
makes it rest on the session not holding the tool.

**The cost is a version floor.** `--permission-prompts` requires Claude Code 2.1.259 or
later; below that it is an unknown option, and an unknown option is refused before the
session starts. jen has no version floor today and no place that states one.

## Goals / Non-Goals

**Goals:**

- A stage session can run an ordinary development command — an install, a check, a one-off
  — without an entry naming it in advance.
- What jen grants on a project's behalf goes to zero, so nothing in the scaffold is a guess
  at a toolchain jen never saw.
- The existing "cannot block on a human" guarantee is enforced by the session's tool set,
  not only by the absence of an answering channel.
- The approve and merge behaviour under the new mode is *observed*, on jen's own pipeline,
  before the change is called done.

**Non-Goals:**

- Per-stage permission modes. One mode for all six, as today.
- Fixing anything the verification finds. If `gh pr review --approve` is denied under
  `auto`, this change records the evidence and stops; the fix is its own task, because the
  answer determines the fix and we do not have the answer yet.
- Reporting denials. See Open Questions.

## Decisions

### Empty the allowlist rather than trim it

**Chosen:** `scaffold/settings.json` keeps its shape — a `permissions` object with an `allow`
array — and the array is empty.

The middle option was to keep `git`, `gh`, `openspec`, `npx openspec` as the workflow's own
tooling and drop the four npm guesses. It has a real argument: those commands run constantly
in every stage, a step-1 match costs no classifier round-trip, and a deterministic bypass for
the pipeline's own plumbing is worth something.

It was rejected because the bypass is the problem, not the benefit. `Bash(gh:*)` exempts
every `gh` invocation from review, `gh pr review --approve` and `gh pr merge` included, and
those are the two calls in the whole pipeline where an independent check is worth most.
jen's own workflow document already carries the rule that only `review-task` approves and
only `deliver-task` merges, and notes that the branch cannot enforce it. A broad `gh` grant
is jen going a step further and removing the one check that would notice.

**Why keep the file at all**, rather than retiring it from the payload: it is what the run
establishes trust for, and it is the documented seat for a rule a project does want. Retiring
a fixed path is a migration; keeping an empty file is not.

### Pass `--permission-prompts none`, and state the floor

**Chosen:** pass it unconditionally; document Claude Code ≥ 2.1.259 as a prerequisite.

**Alternative — probe the CLI and omit the flag when unsupported.** Rejected as machinery
guarding a population of zero: jen has no adopters, and every host that runs it today is one
we control. A conditional argv would also have to be tested in both branches forever, to
defend a case that will never occur.

**Alternative — don't pass it.** Denials behave identically, so the only loss is the
retry suppression and the tool removal. The tool removal is the point; it converts a
prose guarantee into a structural one, which is the kind of trade `stage-execution`'s
existing requirement text explicitly asks for.

### Do not weaken the "cannot block on a human" requirement

The existing requirement says the enforcement is non-interactivity and *not* a permission
level, and warns that writing it as though a mode denied asking "invites an enforcement that
does not exist". That warning is still correct and the modified text keeps it. What is added
sits beside it rather than replacing it: non-interactivity is what makes an answer
impossible; withholding the tools is what stops the session spending turns discovering that.
A future reader must not come away thinking `--permission-prompts none` is what prevents
blocking.

### Verify approve and merge rather than reasoning about them

`Self-Approval` blocks approving a PR "authored by an automation the agent controls".
`review-task` approves a PR opened by `design-task` — a different registered identity, same
pipeline. Whether the classifier reads that as the same automation is a judgment call it
makes at runtime, and no amount of reading the rule text settles it.

`Merge Without Review` is likelier fine: it carves out `gh pr merge --auto` on a repo with
server-enforced required reviews, which is exactly jen's merge gate.

Both get exercised for real. The verification is cheap — jen's own pipeline is right here —
and a guess recorded as a finding would be worse than no finding.

### jen's own settings file is part of the change, and a person applies it

jen is its own project, so a jen stage session clones jen and reads jen's own
`.claude/settings.json`. If that file keeps `Bash(gh:*)` while the scaffold empties,
jen's pipeline runs with a bypass no adopter would have, and the verification above measures
a configuration nobody else will ever be in.

An agent cannot write that file — the harness denies it, correctly, since it is the file
granting the running session its permissions (`cli/AGENTS.md`). So the change lands in two
halves that do not run in the same place, which is the shape that file already warns about.
The task list carries the human half explicitly rather than discovering it at the write.

**Ordering matters:** the file must be emptied *before* the approve/merge verification, or
the verification passes for the wrong reason.

## Risks / Trade-offs

- **`gh pr review --approve` is denied under `auto`, stalling the pipeline at review.** →
  This is the outcome the verification exists to detect, and it is detected on jen's own
  pipeline rather than in an adopter's. The change does not attempt a fix; the finding lands
  as its own task with the classifier's own reason attached. Until that task lands, a denied
  approval leaves the PR unapproved and the task parks at `Pending` — visible, not silent.

- **`PERMISSION_WARNING` gains a second cause.** `cli/exec.ts` greps stderr for
  `Ignoring \d+ permissions.allow entries` and reports it as "the workspace was never
  trusted". Auto mode may also set allow rules aside, for an unrelated reason. If it announces
  that in a message of the same shape, every run reports a trust failure that did not happen.
  → Check what auto mode prints when it drops rules, before trusting the existing regex.
  With the scaffold emptied there is nothing left in an adopter's file for auto to drop, but
  a project with its own rules is exactly the case that would trip it.

- **Classifier latency and token cost on every shell command.** Each `git`, `gh`, and
  `curl` call now costs a round-trip that a step-1 match would have skipped. → Accepted:
  the entries that would have skipped it are the ones we are removing on purpose, and a
  stage session's wall time is not a constraint anyone is optimizing.

- **A classifier verdict is not stable across CLI versions the way a pattern is.** A rule
  set that shifts could deny something a stage depends on, with no diff in jen to explain
  it. → Accepted, and it is the trade the whole change makes: a wrong-in-both-directions
  list that fails today, against a judgment that could drift tomorrow. The mitigation is
  the denial visibility in Open Questions, which is why that gap is worth closing soon.

- **Three consecutive classifier blocks disable auto mode for the rest of the session.**
  The documented fallback is to resume prompting; in a session that cannot prompt, that
  leaves the run denied for everything that is not read-only. → A stage that hits it fails
  visibly rather than silently, and parks. Worth knowing when reading a stage that stopped
  doing anything partway through.

## Migration Plan

No data, no persisted state, no adopters. The steps that need ordering:

1. `scaffold/settings.json` and jen's own `.claude/settings.json` empty together, the
   latter by hand, before any verification of approve or merge.
2. The change ships as a minor release. `dist/` carries the argv, and a runner installs jen
   fresh, so *the argv* reaches no scheduled run until that release is published. jen's own
   `.claude/settings.json` is gated by nothing — it travels in the repository, and `#trust`
   exists so a clone's own file is honoured, so it is in force the moment a session clones
   this branch. Until the release lands, jen's own pipeline therefore runs the old argv
   against the emptied file: `acceptEdits` with nothing to match, denying every shell
   command, which is worse than either endpoint.
3. Rollback refills the settings files first and reverts the argv second, or refills them and
   stops. Reverting the argv *alone* restores exactly the combination above, so the refill is
   not the costless afterthought — it is the half that has to go first. There is still no
   state to unwind, both steps are cheap, and the version floor only ever gated a flag we
   would stop passing.

## Open Questions

None blocking. One gap this change opens, deliberately left to its own task:

**Denial visibility.** `--output-format stream-json`, which jen already parses, delivers
denied actions as `permission_denied` system messages and lists them in the result's
`permission_denials`. Under `acceptEdits` a denial meant a missing allowlist entry, which an
operator could reason about from the scaffold. Under `auto` it means a classifier verdict,
which is visible nowhere in jen's output at all. `verdict()` already assembles a run's
failures from several independent signals and is the natural home for it. Filed separately
so this change stays the mode switch and the allowlist decision.
