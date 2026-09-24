## Why

jen still ships a status-polling dispatcher (`jen run` / `jen watch`) that runs each stage under one of three registered GitHub Apps, and `setup-jen` still walks every adopter through registering those Apps and configuring a merge gate for them. None of it has ever been used: every commit for a month is Josh's own git identity, and PRs #41–43 were authored, reviewed and merged by `joshtgi`. ENG-200 moves managed projects to a jen-hosted backend where authority comes from runtime capabilities rather than host identities, so this path has no future either. A dead path that still reads as configuration is worse than no path at all. `setup-jen` keeps asking people to register three applications that nothing reads.

## What Changes

- **BREAKING**: Remove the `jen run` and `jen watch` commands, along with every option only they took (`--dry-run`, `--team`, `--project`, `--concurrency`, `--issue-page`, `--comment-page`, `--transcripts`, `--interval`). `jen init`, `jen update`, `--help` and `--version` stay.
- Delete the dispatcher and everything only it reaches. That's `cli/run.ts`, `cli/watch.ts` and `cli/exec.ts`; `cli/github.ts` (App JWT signing, installation tokens, `credentialsFor`, the `JEN_GH_*` environment contract); `cli/stages.ts` (status → skill → role table); `cli/linear.ts` (tracker client, `On Pause` halt matching, `LINEAR_API_KEY`); and `cli/registry.ts` (read only by `watch`). The dispatcher's concurrency cap goes with them and gets no successor. The bound an unattended agent run needs belongs to ENG-206.
- Delete their tests (`github`, `dispatch`, `watch`, `exec`, `stages`, `linear`), and the `merge-gate` test, since its subject is removed. Remove whatever `adoption-docs`, `registry`, `workflow`, `payload` and `cli` tests assert about removed text or commands.
- **BREAKING**: Delete the `setup-jen` skill outright. It is no longer shipped in the payload, and `jen update` removes the stamped copy from a project that has one. Most of the skill is the three-application and tracker-agent registration, the credentials, the merge gate and the halt. What would be left after those go is a tracker binding that nothing reads and no adopter needs, since jen's own binding is already written in `registry.yaml`. What a managed project is given in its place is ENG-209's question.
- Remove the `identity` entries, the `role` field and the comment block describing them from `registry.yaml` and `scaffold/registry.yaml`. Also remove both files' instruction to run `setup-jen`. The `repository` and `project-management` entries stay, because the workflow document still tells a stage to consult them.
- Remove the README's runner chapter (*Running the pipeline*), its environment chapter (*Give the stages the configuration your commands read*), its binding step (*Bind the project to its tracker*), and every reference to identities, credentials, the halt or `setup-jen`. The same goes for `CONTRIBUTING.md`.
- Correct the root workflow document where it describes machinery that no longer exists:
  - Under **Verdicts and merges**: *"each stage acts under its role's own identity"*. That was never true.
  - Every sentence that names a dispatcher or a tick, such as *"refusing to dispatch belongs to the dispatcher"* and *"which is what a dispatched run is"*. Each gets reworded to name whoever starts a stage.
  - The `<!-- jen:run … -->` marker is removed from **Announce yourself before you act**. The dispatcher was its only reader. The opening and closing comments stay, because their pairing is what tells a stage re-entering the task that an earlier session died. No skill restates the marker, so removing it is this one edit.
  - The status-as-trigger model and all six skills otherwise behave exactly as they do today.
- Remove the notes that document only deleted code: most of `cli/AGENTS.md` from *The tick writes nothing* onward, `.github/AGENTS.md`'s *Running a stage from a workflow*, and anything in `.claude/skills/AGENTS.md` that rests on the tracker agent or on `setup-jen`.

**What stays**, and why each piece does:
- **The six stage skills, `refine-epic` and the `gh` pull-request flow:** jen's own development runs on them.
- **`review-task`'s comparison of the PR author with the authenticated identity:** you author and review your own PRs, and this comparison is what makes the verdict a `COMMENT`.
- **The release workflow's own GitHub App:** it opens Version PRs and has nothing to do with the pipeline's roles.
- **CHANGELOG entries and archived changes:** they're history.

## Capabilities

### New Capabilities

None.

### Removed Capabilities

These five capabilities are retired completely. Each spec directory is deleted outright under `openspec/specs/`, and the change carries no delta for it. OpenSpec can't express removing a capability: archive refuses to write a spec with every requirement gone ("Spec must have at least one requirement"). This proposal is what records the removal.

- `pipeline-identity`: the three roles, their credentials, the merge gate, and the delivering role's verdict credential.
- `task-dispatch`: `jen run`'s tick.
- `stage-execution`: the executor that turned a run request into a session.
- `pipeline-runner`: `jen watch`.
- `project-binding`: `setup-jen`.

### Modified Capabilities

- `adoption-docs`: remove the requirements for the environment passthrough, autonomy and the runner, and the session-tool version. Replace the adoption-path requirement, which made `setup-jen` a step on the path. Modify the ownership-boundary, executed-path and permissions requirements where they credit a runner, binding, or a dispatched run.
- `stage-conventions`: modify the record requirement, which hands refusal to "the dispatcher". Modify the announcement requirement to drop its dispatcher scenario and the marker. Modify the pull-request requirement's scenario about the pipeline running as an application.
- `task-pipeline`: modify the `Pending` and stage-trigger requirements, which say no dispatcher dispatches from `Pending` and that telling "not picked up" from "being worked" is the dispatcher's job. Modify the refinement requirement, which names "the dispatcher" as a reader of the labels.
- `openspec-integration`: remove the dispatcher's obligation to make OpenSpec reachable inside the bare clones it launched sessions into.
- `repo-scaffold`, `project-install`: modify the sentences that say a project's own permission entries are "in force in a dispatched run" and that `.claude/settings.json` is "what a dispatched run establishes trust for".

## Impact

- **CLI surface:** `jen run` and `jen watch` stop existing, so anyone invoking them gets `Unknown command`. That's a breaking change to the published package, so it ships as a minor changeset (the package is pre-1.0). jen has no adopters, so nobody's runner is affected.
- **Code:** 7 modules, 8 test files and one shipped skill deleted, and `cli/cli.ts` shrinks to `init`, `update`, help and version. The `yaml` dependency stays, because `test/registry.test.ts` and possibly others still parse with it (implementation confirms).
- **Outside the repository, and not this change's to do:** the three registered Apps (`reveer-jen-design`, `-dev`, `-deliver`) and the Linear `jen` agent still exist on their hosts, as do any `JEN_GH_*` secrets someone stored. Uninstalling them is a person's job. This change stops anything from pointing at them.
- **Not touched:** `agent/`, which neither imports `cli/` nor is imported by it; the release pipeline; and the six stage skills beyond the wording above.
