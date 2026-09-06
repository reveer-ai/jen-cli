## 1. The dispatched-session argv

- [x] 1.1 In `cli/exec.ts` (`#session`, ~line 962), change `--permission-mode` from
  `acceptEdits` to `auto`, and add `--permission-prompts none`. Flag order does not matter
  except that the prompt stays last — a variadic flag placed before it consumes it, which
  the method's own doc comment already warns about.
- [x] 1.2 In `test/exec.test.ts` (~line 352), repoint the `acceptEdits` assertion to `auto`
  and assert `--permission-prompts none` beside it, in the same shape as the existing
  flag-and-value assertions.
- [x] 1.3 Check `test/exec.test.ts` (~line 51) and `cli/exec.ts`'s `prompt()` doc comment
  (~line 325) for prose that describes the permission arrangement. Both were reworded off
  `dontAsk` by ENG-184 and now name `-p` alone as the reason a session cannot ask. That is
  still the primary reason and must stay; where they read as though `-p` is the *only*
  mechanism, add that the invocation also withholds the asking tools.

## 2. Empty what jen grants

- [x] 2.1 `scaffold/settings.json`: empty the `allow` array. Keep the `permissions` object —
  `test/install.test.ts:79` asserts the installed file has that property, and the file's job
  is now to be the seat a project's own rules take.
- [x] 2.2 `test/payload.test.ts` (~line 208, "grants the tooling every stage is told to
  run"): this test asserts `git`, `gh` and `openspec` are present, which is the opposite of
  what the scaffold now says. Replace it with one asserting the scaffold grants nothing, and
  rewrite the comment above it — it currently explains why the shared floor is the right
  thing to assert, and that reasoning is what changed.
- [ ] 2.3 **A person applies this one.** Empty the `allow` array in jen's own
  `.claude/settings.json`. An agent cannot write that file: it grants the running session its
  permissions and the harness denies the write, correctly. Do this before task 5 — with the
  file left as it is, jen's pipeline keeps a `Bash(gh:*)` bypass no adopter would have, and
  the approve/merge verification measures the wrong configuration.

## 3. Documentation

- [x] 3.1 `README.md` §4 ("Grant the permissions the stages need — also yours"): rewrite. It
  currently tells an adopter to add their typecheck, lint, build and test commands and shows
  a `pytest`/`ruff`/`mypy` example. Under `auto` none of that is required. State what the
  session may do, that ordinary development work needs no entry, and that the tracked
  settings file is theirs for a rule they do want. Keep the existing warning that an example
  is entries to add rather than a whole file to paste — `adoption-docs` still requires it —
  and keep §5's neighbouring statement about the runner's environment intact.
- [x] 3.2 `README.md`: state Claude Code ≥ 2.1.259 as a prerequisite for running the
  pipeline, and say what the failure looks like below it — the session is refused before it
  starts, so it presents as a stage that was dispatched and produced nothing.
- [x] 3.3 `cli/AGENTS.md` (~line 27): the note explaining that `scaffold/settings.json` and
  jen's own `.claude/settings.json` are different files with different jobs. Both are now
  empty of grants; the note's point about editing one not changing the other still holds and
  should stay.
- [x] 3.4 `cli/AGENTS.md` (~line 31 and ~line 317): the two workspace-trust notes. Trust is
  still the invocation's job and still keeps a project's own configuration in force, but both
  notes justify it by the allow list jen ships, which is now empty. Reword to name what trust
  actually gates.
- [x] 3.5 `test/adoption-docs.test.ts` (~line 79): asserts §4 sits before §5 and describes
  what that section says. Update to match the rewritten section rather than deleting the
  ordering check — the two sections still answer neighbouring halves of one question.
- [x] 3.6 The change-authoring note, written this round because the first round **claimed it
  and did not write it** — the closing comment reported it done, and it was on no branch.

  It landed at **`openspec/changes/AGENTS.md`**, not the `openspec/AGENTS.md` review asked
  for, because that path cannot hold a file. `openspec init` deletes it; jen's `package.json`
  runs `openspec init` as `prepare`; npm fires `prepare` on the `npm pack` inside
  `test/package.test.ts`. So **`npm test` silently deletes an untracked `openspec/AGENTS.md`**
  — verified directly, and bisected across the suite to that one file.

  That is almost certainly what happened last round rather than the note never being written:
  the order of work is write, run the suite, commit, and the file is gone before `git add`
  sees it. The suite passes, `git status` comes back clean, and the commit looks complete. I
  hit it myself this round — wrote the file, ran the checks, and committed without it — and
  only caught it because the commit's own file list was one short.

  Anything at or below `openspec/changes/` survives, and `openspec list` and `validate
  --changes` both ignore a file sitting there. The note records that trap first, since it is
  the one that eats the note, then the two the change actually hit: `--strict` validating a
  delta against nothing the delta named — the defect that sent this task back in round one,
  with the check to run stated as *grep the main specs for the behaviour, not the files you
  are editing* — and `RENAMED` binding `### Requirement:` headers only, so a scenario heading
  cannot be renamed without churning the whole requirement. Both re-verified against openspec
  1.8.0 rather than restated from round one, and the scenario one's exact `--strict` error is
  quoted, since that error is what a session meets before it understands why.

  Guarded by a test in `test/repo-layout.test.ts` asserting the note is tracked at the
  surviving path and absent from the path that deletes it — confirmed to fail when the file is
  moved back. A note that disappears silently and passes every check is not something to leave
  to the next session's vigilance.

  Not in the payload either way: `PAYLOAD` carries the root `AGENTS.md` and the skills, so this
  is jen's own note and `jen update` will not overwrite it.

## 4. Check the trust warning still means what it says

- [x] 4.1 `cli/exec.ts:42` greps session stderr for `Ignoring \d+ permissions.allow entries`
  and reports it as a workspace that was never trusted. Auto mode *also* discards allow
  rules on entry, for an unrelated reason. Determine what it prints when it does: run a
  session under `--permission-mode auto` in a trusted workspace whose settings carry a rule
  auto drops — `Bash(npm run build:*)` is one — and capture stderr.
- [x] 4.2 If the message matches the existing regex, the check now fires on a healthy run and
  has to distinguish the two causes. If it does not match, leave the regex alone and record
  in `cli/AGENTS.md` that the two were checked and are distinguishable, so the next session
  does not have to re-establish it.

  **It does not match — a trusted `auto` run prints nothing on stderr.** On 2.1.260, a
  trusted workspace whose settings carry `Bash(npm run build:*)` and
  `Bash(npm run typecheck:*)` produced empty stderr under `--permission-mode auto`, while the
  same workspace untrusted printed `Ignoring 5 permissions.allow entries …` byte-identically
  under `acceptEdits` and `auto`. Both runs ended at the same authentication failure, so the
  silence is the trust state and not a run that stopped early. Regex left alone; recorded in
  `cli/AGENTS.md`.

  Corrected in review: this answers the question the task asked and **does not** establish
  that `auto` discards package-manager run commands, which the first pass wrote into four
  documents as fact. Silence is equally consistent with *not discarded*. The mechanism could
  not be settled from a dispatched session — a nested `claude auto-mode config` is blocked by
  the classifier — so the claim was removed rather than guessed at; the decision to empty the
  list never depended on it. What is known is recorded in `cli/AGENTS.md`.

- [x] 4.3 Second review pass found the question above was the wrong half. Auto mode adds no
  *new* cause for the warning — that holds — but this change removes the warning's only
  trigger from the file jen ships. `PERMISSION_WARNING` matches an entry **count**, and the
  CLI prints nothing at zero entries. Reproduced on 2.1.260, untrusted workspace, the flags
  this change now passes, differing only in the array: two entries → `Ignoring 2
  permissions.allow entries …`; `[]` → nothing at all; `[]` plus a real `deny` rule and an
  `env` block → nothing at all. All three reached the same authentication failure, so the
  silence is the trust state and not an early exit.

  The third case is the one that bites: trust gates the *file*, not the `allow` key, so a
  project losing real configuration to an untrusted clone now does so silently. Before this
  change `jen init` seeded eight entries and every jen-installed project therefore emitted the
  warning; every adopter is now at zero by default.

  Regex still left alone — there is no wider string to match, because no line is emitted.
  Corrected the two places claiming the coverage the change removed (`cli/AGENTS.md`'s
  workspace-trust section, and `cli/exec.ts:42`'s doc comment) and opened **ENG-192** for a
  check that does not key on the count. Deliberately not fixed here: this change is the mode
  switch, and the fix is the same shape as the denial-visibility gap filed as ENG-191.

## 5. Verify the behaviour, on jen's own pipeline

Task 2.3 must be done first, or every result here is measuring a `gh` bypass.

- [ ] 5.1 A stage session runs `npm install` and a one-off `node -e` with nothing in the
  settings file granting either. This is the failure ENG-179 hit twice; it is the change's
  primary claim.
- [ ] 5.2 A design-stage session completes a tracker attachment upload — `curl PUT` to a
  signed URL. This is the second observed failure, and it is the step jen's own root
  `AGENTS.md` mandates.
- [ ] 5.3 The tracker's MCP tools still work: a stage announces itself, comments, and moves
  a task. Under `auto` these reach the classifier where they did not before, and
  `External System Writes` is the rule they meet. Publishing the task asked for is carved
  out of it; resolving a PR thread the session did not itself create is the clause that
  reads adverse. Exercise a thread resolution specifically.
- [ ] 5.4 `gh pr review --approve` from `review-task`'s identity, on a PR opened by
  `design-task`'s. This is the open question in `design.md` — whether the classifier reads
  two registered identities in one pipeline as "an automation the agent controls" under
  `Self-Approval`. Record the verdict and, if denied, the reason the classifier gave.
- [ ] 5.5 `gh pr merge --auto` from `deliver-task`'s identity. `Merge Without Review` carves
  out `--auto` on a repo with server-enforced required reviews, which is jen's merge gate, so
  this is expected to pass — confirm it rather than assuming.
- [ ] 5.6 If 5.4 or 5.5 is denied, do not fix it here. Record the classifier's reason and
  open a task for it. The fix depends on the answer, and this change's job was to obtain the
  answer.

## 6. Ship

- [x] 6.1 `npm test` and typecheck pass.
- [x] 6.2 Add a changeset. Minor: the pipeline's behaviour changes and a host prerequisite
  appears that did not exist before.
- [x] 6.3 `dist/` is rebuilt from `cli/exec.ts` carrying the new argv. A runner installs jen
  fresh on every run, so the change does not reach a scheduled run until the release ships.
- [x] 6.4 Open the follow-up task for denial visibility — surfacing the stream's
  `permission_denials` through `verdict()`. `design.md` — Open Questions has the reasoning.
  Opened as ENG-191, related to this task rather than under it.
