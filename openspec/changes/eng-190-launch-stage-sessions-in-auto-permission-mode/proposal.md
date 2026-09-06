## Why

A dispatched stage session runs `claude -p --permission-mode acceptEdits`
([`cli/exec.ts:962`](../../../cli/exec.ts)). `acceptEdits` auto-approves file writes and
almost nothing else: apart from a built-in read-only set, every shell command has to match a
`permissions.allow` entry in the clone's `.claude/settings.json`, and a session under `-p`
with no permission host has nobody to grant what does not match. A stage may therefore
author any code it likes and cannot run the commands that would check it.

Two failures on the `mon` test install, not hypotheses. `implement-task` was dispatched
twice against ENG-179 and wrote nothing both times: task 1.1 of its own `tasks.md` is
`npm install --prefix src`, every later task depends on what that install brings in, and it
correctly refused to write code it could not typecheck. `design-task` could not sync its
artifacts to the tracker: the upload is a `curl PUT` to a signed URL, `curl` is not in the
shipped allowlist, and the step jen's own root `AGENTS.md` mandates is therefore one a jen
session cannot perform.

The shape of the mistake is that a fixed list of command patterns has to anticipate an
arbitrary project's toolchain before the project exists. `auto` inverts that: a classifier
judges each action against 17 allow rules, 69 soft-denies and 1 hard-deny
(`claude auto-mode defaults`), so ordinary development work needs no entry at all.

## What Changes

- **The dispatched-session argv.** `--permission-mode acceptEdits` → `--permission-mode auto`,
  and `--permission-prompts none` is added
  ([`cli/exec.ts:962`](../../../cli/exec.ts)).
- **`scaffold/settings.json` ships an empty allow list.** The file stays — it is the seat an
  adopter's own rules take — but jen grants nothing in it. **BREAKING** for the pipeline's
  own git-host calls: see the fourth bullet.
- **A Claude Code floor of 2.1.259** is introduced and documented. `--permission-prompts` is
  rejected as an unknown option below it, and an unknown option means the session never
  starts. jen has no version floor today, so this is a new requirement on the host that
  invokes `jen run`.
- **The out-of-scope approve/merge questions become live, deliberately.** An allow rule
  resolves at step 1 of the classifier's decision order, so today's `Bash(gh:*)` means
  `gh pr review --approve` and `gh pr merge` never reach the classifier. Emptying the list is
  what sends them there, and auto has a soft-deny for each — `Self-Approval` and
  `Merge Without Review`. The merge is probably already fine: the rule carves out
  `gh pr merge --auto` on a repo with server-enforced required reviews, which is jen's merge
  gate. The approval is the genuinely open one. This change verifies both rather than
  assuming, and a denial lands as its own task with evidence behind it.
- **jen's own `.claude/settings.json` is emptied too, by a human.** jen is its own project:
  a jen stage session clones jen and reads that file. Left as it is, jen's pipeline keeps a
  `Bash(gh:*)` short-circuit an adopter's would not have, and the verification above would
  be measuring the wrong pipeline. An agent cannot edit that file —
  [`cli/AGENTS.md:29`](../../../cli/AGENTS.md) — so it is a step the task carries and a
  person applies.
- **The adopter documentation reverses.** Today README §4 tells an adopter to add their
  typecheck, lint, build and test commands. Under `auto` they usually need to add nothing at
  all, so the section states what a session may do instead of asking for a list.
- Not in scope, and named in `design.md` as a gap this change opens: reporting the
  `permission_denials` the stream already carries. Under `auto` a classifier denial becomes
  the main way a stage quietly fails to do its work, and jen surfaces nothing about it today.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `stage-execution` — a session's permissions are decided per action rather than
  pre-enumerated; the means of asking a person is removed from the session rather than
  merely absent; the invocation requires a CLI version that accepts the flags it passes.
- `repo-scaffold` — the tracked assistant configuration no longer carries permissions the
  workflow's stages depend on; it is a seat for a project's own rules.
- `adoption-docs` — the documentation stops telling an adopter to enumerate their check
  commands, and states the CLI floor the pipeline requires. The environment requirement is
  modified too, for one clause: it describes the permissions section it sits beside, and that
  description is what this change reverses. A requirement inside a capability the delta names
  is not covered by naming the capability.
- `stage-conventions` — the guarantee that a stage may run what its instructions require is
  met by the per-action arrangement rather than by granting the workflow's own tooling in
  the configuration jen writes. Named here because the capability says the opposite in its
  own words: without a delta it survives the archive verbatim and the specs assert both.
- `project-install` — `.claude/settings.json` is created as the project's seat rather than
  seeded with the permissions the stages depend on. Same reason: the sentence reads as an
  instruction to seed grants, and a future session would act on it.

## Impact

- `cli/exec.ts` — `#session`'s argv; the `PERMISSION_WARNING` note, whose stated
  justification is a permission set that no longer exists in the shape it describes.
- `scaffold/settings.json` — emptied of grants.
- `.claude/settings.json` (jen's own) — emptied by hand, outside the agent's reach.
- `test/exec.test.ts` — the `acceptEdits` assertion, plus the new flag.
- `test/payload.test.ts` — "grants the tooling every stage is told to run" asserts the
  opposite of what the scaffold will now say.
- `README.md` §4, and `cli/AGENTS.md`'s two notes on the settings files and on trust, plus
  a note recording what was and was not established about auto discarding allow rules.
- A changeset. Behaviour changes for anyone running the pipeline and a host requirement
  appears, so minor rather than patch.
- Workspace trust (`#trust`) stays and is not weakened by the empty list: it gates the
  project's own rules, hooks and inline servers, which is what an adopter will actually put
  in that file.
