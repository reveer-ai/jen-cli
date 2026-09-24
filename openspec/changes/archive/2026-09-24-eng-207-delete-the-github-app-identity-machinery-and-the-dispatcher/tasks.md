## 1. Delete the dispatcher and the identity code

- [x] 1.1 Delete `cli/run.ts`, `cli/watch.ts`, `cli/exec.ts`, `cli/github.ts`, `cli/stages.ts`, `cli/linear.ts` and `cli/registry.ts`.
- [x] 1.2 Reduce `cli/cli.ts` to `init`, `update`, help and version. Remove the `run` and `watch` cases, `parseTick`, `parseWatch`, `dispatch`, the imports behind them, and every `RunOptions` field only they used (`env`, `transport`, `exec`, `launch`, `wait`). Rewrite the header comment and `USAGE` so neither mentions `run`, `watch`, a tracker credential, a runner or the halt. Narrow `run()`'s return type to `number` if nothing asynchronous is left, then drop the promise narrowing its callers carry (for example `test/install.test.ts`).
- [x] 1.3 Delete `test/github.test.ts`, `test/dispatch.test.ts`, `test/watch.test.ts`, `test/exec.test.ts`, `test/stages.test.ts`, `test/linear.test.ts` and `test/merge-gate.test.ts`. In `test/cli.test.ts`, remove any case exercising `run` or `watch`. Remove any export of `test/helpers.ts` or `test/fixture.ts` left with no caller.
- [x] 1.4 Move `yaml` from `dependencies` to `devDependencies` in `package.json`, and refresh `package-lock.json`.
- [x] 1.5 `npm run typecheck` and `npm test` pass.

## 2. Remove `setup-jen` and the identity configuration

- [x] 2.1 Delete `.claude/skills/setup-jen/`, and remove `'setup-jen'` from `SKILLS` in `cli/payload.ts`, along with any comment there that cites it. Update `test/payload.test.ts`: drop the `setup-jen` case and the reasoning that used it, and keep the test that the payload's skill set isn't the stage list, if a non-stage skill still ships (`refine-epic`). Otherwise remove that test too.
- [x] 2.2 Remove the `identity` entries and the comment block describing identities, roles and credentials from `registry.yaml` and `scaffold/registry.yaml`, along with the instruction to run `setup-jen`. The stub now says the adopter fills it in by hand. Update `test/registry.test.ts` to match, so it asserts nothing about identities or roles.

## 3. Correct the documentation

- [x] 3.1 In root `AGENTS.md`, apply the `stage-conventions` and `task-pipeline` deltas:
  - **Read the record:** drop "Refusing to dispatch a task belongs to the dispatcher".
  - **Where the work goes:** reword "which is what a dispatched run is" to name an identity without a linked git-host account.
  - **Verdicts and merges:** remove "each stage acts under its role's own identity". The breach is visible in the PR timeline because the approving actor is recorded there. Keep the convention.
  - **Announce yourself before you act:** remove the `jen:run` marker and the sentences about the dispatcher reading it and re-dispatching.
  - **Don't route a task back:** drop "no dispatcher can make that comparison by counting transitions", or reword it without a dispatcher.
  - **Stages:** reword "The pipeline drives itself from `In Progress` onward" to say that every later transition is a stage's.

  Update `test/workflow.test.ts` to match the reworded convention.
- [x] 3.2 In `README.md`, delete *Running the pipeline* with all its subsections, *Give the stages the configuration your commands read*, and *Bind the project to its tracker*. Replace the binding step with filling in `registry.yaml` by hand, and renumber the adoption steps. Remove every remaining mention of `jen run`, `jen watch`, `setup-jen`, the `JEN_GH_*` variables, `LINEAR_API_KEY`, identities, roles, the merge gate and `On Pause`. Also correct the permissions chapter's "dispatched run". Then update `test/adoption-docs.test.ts` so it asserts only what `adoption-docs` still requires: delete the runner-chapter and environment-chapter suites and the registry-reader assertion.
- [x] 3.3 In `CONTRIBUTING.md`, replace the *Bind it — run the `setup-jen` skill* step with filling in the registry, and remove any other mention of the removed commands or skill.
- [x] 3.4 Edit the main `openspec/specs/adoption-docs/spec.md` **Purpose** directly. It promises "a running pipeline", and a delta can't change a Purpose.

## 4. Retire the removed capabilities and notes

- [x] 4.1 Delete `openspec/specs/pipeline-identity/`, `openspec/specs/task-dispatch/`, `openspec/specs/stage-execution/`, `openspec/specs/pipeline-runner/` and `openspec/specs/project-binding/` (see design, *A retired capability is deleted, not emptied*).
- [x] 4.2 In `cli/AGENTS.md`, delete every section from *The tick writes nothing* to the end. Also delete the paragraph under *Resolving the OpenSpec binary goes through the bare specifier* that documents `exec.ts`'s shim.
- [x] 4.3 Delete `.github/AGENTS.md`'s *Running a stage from a workflow* section.
- [x] 4.4 Delete both sections of `.claude/skills/AGENTS.md`, and delete the file if only its introduction remains.
- [x] 4.5 Add a section to `openspec/changes/AGENTS.md` saying that a capability can only be retired by deleting its spec directory. It should quote the archive abort a REMOVED-only delta produces, and say that `--strict` doesn't catch it.

## 5. Verify and record

- [x] 5.1 Run the design's residue grep over the whole repository, excluding `CHANGELOG.md`, `openspec/changes/archive/` and `node_modules/`, for: `jen run`, `jen watch`, `dispatch`, `tick`, `runner`, `JEN_GH`, `LINEAR_API_KEY`, `On Pause`, `setup-jen`, `identity`, `role`, `installation token` and `jen:run`. Resolve every hit. Anything kept (for example the release App, `review-task`'s author comparison, or `agent/`'s own vocabulary) is kept for a reason you can state.
- [x] 5.2 `openspec validate eng-207-delete-the-github-app-identity-machinery-and-the-dispatcher --strict` passes. Copy `openspec/` to a scratch directory, run `openspec archive eng-207-delete-the-github-app-identity-machinery-and-the-dispatcher --yes` there, and confirm it succeeds and leaves none of the five retired specs.
- [x] 5.3 Pack and install as an adopter (`cli/AGENTS.md`, *Exercising it as an adopter*):
  - `jen init` writes one skill fewer, with no `setup-jen`.
  - `jen update` over a project holding a stamped `setup-jen` removes it.
  - `jen run` and `jen watch` report an unknown command.
  - `jen --help` mentions neither.
- [x] 5.4 Add a `minor` changeset for `@reveer/jen` saying that `jen run`, `jen watch` and `setup-jen` are removed, and that `yaml` is no longer a runtime dependency.
