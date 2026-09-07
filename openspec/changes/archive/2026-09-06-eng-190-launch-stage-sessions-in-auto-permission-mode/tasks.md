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
- [x] 2.3 **A person applied this one.** Empty the `allow` array in jen's own
  `.claude/settings.json`. An agent cannot write that file: it grants the running session its
  permissions and the harness denies the write, correctly. Do this before task 5 — with the
  file left as it is, jen's pipeline keeps a `Bash(gh:*)` bypass no adopter would have, and
  the approve/merge verification measures the wrong configuration.

  **Done in `7ebc56b`.** All nine entries removed, `permissions` object kept, so the file is
  now byte-equivalent to what `jen init` writes an adopter. Verified rather than taken: the
  commit touches that one file, removes exactly the nine, and the tree is clean. Typecheck,
  build, 443 tests and `--strict` all pass with the grants gone — nothing in jen's own suite
  reads that file, so nothing depended on them.

  Deleting the file outright was considered and rejected. It would satisfy group 5 equally —
  no `Bash(gh:*)` either way — but the `repo-scaffold` delta this change ships says the file
  SHALL still be written and tracked, and jen dropping its own copy while shipping that
  argument is a divergence someone would trip over later. Emptying costs the same and puts jen
  in exactly the configuration an adopter gets, which is the whole point of the task.

  **Group 5 is now unblocked.** It stays test-task's work and stays unchecked here.

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

  **Revised again in round three, because task 2.3 made the surviving half false.** The note
  still called jen's own file "a local config a contributor may add permissions to for jen's
  own build" — fair while it was one, and no longer true once a person emptied it. jen is its
  own project, so a stage session clones jen and reads that file exactly as an adopter's
  session reads theirs: it is jen's *pipeline's* permission configuration, and an entry in it
  is a step-1 bypass jen gets and no adopter does. Leaving the invitation standing pointed a
  contributor at putting `Bash(gh:*)` straight back, which is the outcome ordering 2.3 ahead
  of group 5 exists to prevent — and group 5 is still ahead of this task.

  The clause is replaced with what the file is now, and the note names
  `.claude/settings.local.json` as where a contributor's own grants go. That was the half with
  no home anywhere: it is gitignored already, and nothing said it was the seat. The ignore
  rule's comment now says so too, since it gave only the MCP-id reason.

  Guarded in `test/repo-layout.test.ts` rather than left to the note. Review flagged the test
  as optional and the implementer's call; it is worth its three lines because the failure is
  silent in a way the round's other findings were not — the file is not in the payload, no
  other test reads it, and a restored entry changes nothing anyone would notice except that
  the two calls this change exists to submit to judgment stop being judged.
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

Two preconditions, and the second is not a box on this list. Task 2.3 must be done first, or
every result here is measuring a `gh` bypass. **The runner must also be dispatching from a jen
built from this branch**, because the change's two halves travel by different routes: the argv
arrives in `dist/` and a stale runner still passes `acceptEdits`, while jen's own emptied
`.claude/settings.json` arrives through the clone and is already in force. That combination
denies every shell command. **So a denial in 5.1 or 5.2 is a stale runner until that is ruled
out** — it is not evidence against the change.

**Neither precondition could be met, and that is the finding rather than an obstacle to it.**
There is no runner: `jen` is installed nowhere on the host, no `jen run`/`jen watch` process or
launchd agent exists, and every stage on this task ran as an attended local session. So there
was no stale runner to rule out — and equally, "on jen's own pipeline" could not be performed
as written, because no pipeline is running. The interim window 6.3 describes is inert for the
same reason. `gh` here holds two human accounts and none of the three registered applications.

5.1–5.3 were therefore exercised on their mechanism, from an attended session with jen's own
emptied `.claude/settings.json` in force and auto mode active. The attribution is clean:
`~/.claude/settings.json` carries no `permissions` block, there is no
`.claude/settings.local.json`, and the tracked array is `[]` — so the classifier alone
permitted each of these. 5.4 and 5.5 need two distinct registered identities and are a human's;
they are written up on the issue.

The shape difference from a dispatched session is `-p` with `--permission-prompts none`, which
turns a soft-deny into a denial instead of a prompt. It did not mask anything here: the two
actions the classifier refused in this session came back as denials with no prompt offered, so
the denial path has the same shape, and every result below is an outright allow rather than a
prompt someone answered.

- [x] 5.1 A stage session runs `npm install` and a one-off `node -e` with nothing in the
  settings file granting either. This is the failure ENG-179 hit twice; it is the change's
  primary claim.

  **Holds.** In a workspace whose `.claude/settings.json` is `{"permissions":{"allow":[]}}`,
  `npm install` against a manifest and `node -e 'console.log(6*7)'` both ran. So did the whole
  of this session's work in jen's own checkout under the same empty array — `npm test` (444),
  `npm run build`, `npm run typecheck`, `npx openspec validate --all --strict`, `git`, `gh`,
  `node`.

  Checked one step past the task, because the allow list predicts otherwise:
  `Declared Dependencies` covers a manifest-declared install and **explicitly not** an
  agent-chosen package name, which is the commoner implementation act. `npm install nanoid`
  ran anyway — falling outside an allow rule sends an action to the classifier, it does not
  deny it. Recorded in `cli/AGENTS.md`, since reasoning the other way is the natural mistake.
- [x] 5.2 A design-stage session completes a tracker attachment upload — `curl PUT` to a
  signed URL. This is the second observed failure, and it is the step jen's own root
  `AGENTS.md` mandates.

  **Holds.** A real `prepare_attachment_upload` against this issue, then
  `curl -X PUT --data-binary` to the returned `storage.googleapis.com` URL replaying all four
  signed headers verbatim: **HTTP 200**. Deliberately not finalized with
  `create_attachment_from_upload` — the mechanism under test is the PUT, and testing has no
  artifact to attach, so the upload is orphaned and nothing appears on the issue.
- [x] 5.3 The tracker's MCP tools still work: a stage announces itself, comments, and moves
  a task. Under `auto` these reach the classifier where they did not before, and
  `External System Writes` is the rule they meet. Publishing the task asked for is carved
  out of it; resolving a PR thread the session did not itself create is the clause that
  reads adverse. Exercise a thread resolution specifically.

  **Holds, including the adverse clause.** The announcement went up through the tracker MCP,
  and the status move at the end of this run went the same way. The clause worth the task:
  `resolveReviewThread` on `PRRT_kwDOTyXn5s6fsg_L` — a thread this session did not create —
  returned `isResolved: true`. Chosen already-resolved so the probe changed nothing.

  The rule text is now read rather than inferred, from `claude auto-mode defaults`, which the
  earlier note recorded as unreachable — that was `auto-mode config`, and `defaults` is a
  different command that works from an attended session. `External System Writes` is a
  soft-deny, and **under `--permission-prompts none` every one of the 69 soft-denies is a hard
  denial for a stage**, which is what makes that list rather than the allow list the one to
  check a new pipeline act against. In `cli/AGENTS.md`.
- [ ] 5.4 `gh pr review --approve` from `review-task`'s identity, on a PR opened by
  `design-task`'s. This is the open question in `design.md` — whether the classifier reads
  two registered identities in one pipeline as "an automation the agent controls" under
  `Self-Approval`. Record the verdict and, if denied, the reason the classifier gave.

  **Not performable from here, and left unchecked rather than argued around.** It needs two
  distinct registered applications; this host has one identity and it is the pull request's
  author, which is why all six review rounds recorded `COMMENT` and the host refused before
  the classifier was ever consulted. `Self-Approval`'s text does not settle it either way —
  whether one pipeline application counts as "an automation the agent controls" over another
  is the runtime judgment the task exists to obtain. Still open; a human's.
- [ ] 5.5 `gh pr merge --auto` from `deliver-task`'s identity. `Merge Without Review` carves
  out `--auto` on a repo with server-enforced required reviews, which is jen's merge gate, so
  this is expected to pass — confirm it rather than assuming.

  **Not performable from here.** The merge is `deliver-task`'s act on this very pull request,
  and testing performing it would be the stage overreach the conventions name. The rule text
  read from `auto-mode defaults` does carry the carve-out verbatim — "`gh pr merge --auto` on
  a repo with required-reviews branch protection is NOT this rule" — which is evidence for the
  expectation and not the confirmation the task asks for. Still open; falls to delivery or to a
  human.
- [x] 5.6 If 5.4 or 5.5 is denied, do not fix it here. Record the classifier's reason and
  open a task for it. The fix depends on the answer, and this change's job was to obtain the
  answer.

  **Opened as ENG-193, on a condition adjacent to the one written here.** Neither call was
  denied — neither was reached — so there is no classifier reason to carry, and that absence
  is the whole content of the handoff. The task says so plainly rather than implying a verdict
  was obtained, and it carries what a later run needs: the rule text, why an attended session
  cannot reach it, and the instruction to capture the classifier's reason verbatim if it does
  fire.

  5.5 is deliberately not carried with it. The carve-out is verbatim in the rule and the first
  `deliver-task` merge exercises it, so a task would be answered before anyone picked it up.

**The user closed group 5 out on this evidence.** 5.1–5.3 hold; 5.4 and 5.5 stay unchecked
because they were not verified, and marking them otherwise would be a false record. The
decision was to accept that and let the `Self-Approval` question ride to ENG-193 — where it
had been scoped from the start — rather than hold delivery for a runner. 5.6 records the
consequence, and nothing about the change waits on either answer.

## 6. Ship

- [x] 6.1 `npm test` and typecheck pass.
- [x] 6.2 Add a changeset. Minor: the pipeline's behaviour changes and a host prerequisite
  appears that did not exist before.
- [x] 6.3 `dist/` is rebuilt from `cli/exec.ts` carrying the new argv. That half of the change
  reaches a scheduled run only when the release ships, since a runner installs jen fresh on
  every run. The other half is not gated by anything: jen's own emptied
  `.claude/settings.json` travels in the repository and is in force for every session that
  clones this branch. Between the two, jen's own pipeline runs the old argv against the empty
  array — `acceptEdits` with nothing left to match, which denies every shell command — and
  publishing the release is what closes that window.
- [x] 6.4 Open the follow-up task for denial visibility — surfacing the stream's
  `permission_denials` through `verdict()`. `design.md` — Open Questions has the reasoning.
  Opened as ENG-191, related to this task rather than under it.
