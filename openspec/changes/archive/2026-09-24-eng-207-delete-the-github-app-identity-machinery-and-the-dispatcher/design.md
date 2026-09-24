## Context

The proposal covers why this is happening. This document covers how.

The dispatcher is a closed subgraph of `cli/`. `cli/cli.ts` is its only entry point, through the `run` and `watch` cases and the imports behind them. Inside, `run.ts` → `stages.ts` and `linear.ts`; `exec.ts` → `github.ts` and `stages.ts`; and `watch.ts` → `run.ts` and `registry.ts`. None of those seven modules is imported by `plan.ts`, `apply.ts`, `payload.ts`, `stamp.ts`, `ignore.ts` or `openspec.ts`, which is the half `init` and `update` run on. So the deletion is a cut along an existing seam rather than an untangling. `agent/` doesn't import `cli/` at all.

Prose is what's entangled, not code. The dispatcher and the identities are described in the root `AGENTS.md`, the README, `setup-jen`, three directory notes, eleven specs, and tests that pin that prose. Most of the work, and nearly all the risk, is there.

## Goals / Non-Goals

**Goals:**
- After this change, nothing in the repository describes, configures, tests or refers to the dispatcher, the three git-host roles, the tracker agent, the halt status, or `setup-jen`, outside CHANGELOG entries and archived changes.
- `jen init`, `jen update`, `--help` and `--version` behave exactly as before, apart from shipping one skill fewer and the help text no longer mentioning `run` and `watch`.

**Non-Goals:**
- Changing how the six stage skills work. Their text changes only where the root workflow doc's wording changes under them. None of the skill files restates the dispatcher or the marker.
- Deleting anything on an external host: the registered Apps, the Linear agent, stored secrets, or branch protection.
- Replacing any of it. The run bound, the chief, and onboarding belong to ENG-206 and ENG-209.

## Decisions

### A retired capability is deleted, not emptied

OpenSpec has no operation for removing a capability. A delta that removes every requirement validates under `--strict` and then fails at archive: *"Validation errors in rebuilt spec for pipeline-identity … Spec must have at least one requirement. Aborted. No files were changed."* That's a failure that would surface for the first time in `deliver-task`, after review and testing. Verified on OpenSpec 1.8.0 in a scratch copy of `openspec/`:
- **REMOVED-only deltas, spec directories intact:** archive aborts.
- **REMOVED-only deltas, spec directories already deleted:** archive still aborts, because it treats the delta as creating a new, empty spec.
- **No deltas for the five, spec directories deleted:** archive succeeds, applies the other six deltas, and the five stay gone.

So the five spec directories are deleted by implementation, like any other file this change removes, and the change carries no delta for them. The proposal's *Removed Capabilities* section is the record of what went and why.

*Rejected:* leaving a stub requirement in each spec, such as "this capability is retired", just to satisfy the validator. That's the "dead path that still reads as configuration" this change exists to remove, in spec form.

This is exactly the kind of gotcha the notes convention is for, so implementation adds it to `openspec/changes/AGENTS.md`.

### A scenario whose heading became false is replaced, not edited

Four requirements lose a scenario whose heading is now false, such as *A dispatcher examines a task* or *An adopter wants to change which project the pipeline polls*. `MODIFIED` can't drop a scenario (see `openspec/changes/AGENTS.md`), so each one is `REMOVED` and re-`ADDED` under a new name carrying the rest unchanged. Where a heading is still true and only its body names the dispatcher, the body is edited under `MODIFIED` and the heading stays, which is the cheaper route that note recommends.

### The `jen:run` marker goes, and the comments it rode in stay

The marker was a string the dispatcher parsed. What stages actually read on re-entry is the pairing of an opening comment and a closing comment, and that pairing reads the same without the marker. The root doc is the only place that states the marker. The skills cite the convention rather than restating it, and `test/stages.test.ts` and `test/dispatch.test.ts`, the only code that knows the string, are deleted anyway. So removing it is one paragraph.

Comments already on Linear issues keep their marker. That's history, like archived changes, and nothing reads it.

### Root `AGENTS.md` is reworded in place, with no new mechanism

Each sentence that names a dispatcher, a tick or a role's identity is rewritten to say what's true without one. It either names "whoever starts a stage" or drops the clause. The status-as-trigger model stays word for word apart from that. This is also the file `jen update` replaces wholesale in an adopter's project, so the change reaches every install, and jen has none.

### `setup-jen` is removed from the payload, and `jen update` retires the installed copy

`setup-jen` is a stamped member of the skills variable set. Dropping it from `SKILLS` in `cli/payload.ts` is all it takes for `jen update` to delete the installed copy (stamp ∩ not-shipped). No migration is needed, which is the mechanism working as designed. `jen init` output and help text derive from `SKILLS.length`, so they follow automatically.

### `yaml` becomes a devDependency

`cli/registry.ts` is the only non-test importer of `yaml`. Once it's deleted, a runtime dependency that nothing at runtime uses would stay in every adopter's install. `test/registry.test.ts` and `test/release.test.ts` still parse YAML, so it moves to `devDependencies` rather than being dropped.

### What stays in the registry is what the workflow document reads

`registry.yaml` and `scaffold/registry.yaml` keep the `repository` and `project-management` entries and their explanation, because the root doc tells a stage to consult them. The identity entries, the `role` field, the comment block about identities, and the pointer to `setup-jen` go. The stub's "fill it in by hand" wording takes the pointer's place. jen's own `registry.yaml` loses its four identity entries.

### Notes are cut to what still describes living code

- **`cli/AGENTS.md`:** every section from *The tick writes nothing* to the end is deleted. Of the sections before it, the second paragraph of *Resolving the OpenSpec binary goes through the bare specifier* is also deleted, because it documents `exec.ts`'s shim. The rest of that section and the others stay.
- **`.github/AGENTS.md`:** *Running a stage from a workflow* is deleted. Its two rules concern a stage's credential on an Actions runner, and no stage runs on one any more. The release App's sections stay.
- **`.claude/skills/AGENTS.md`:** both sections are deleted. One diagnoses the tracker agent's empty diffs, and the other reads App installations for the merge gate. If nothing is left but the heading, the file is deleted.

### Tests are deleted with their subjects and pruned everywhere else

The following are deleted outright: `github`, `dispatch`, `watch`, `exec`, `stages`, `linear` and `merge-gate`. In `adoption-docs`, `registry`, `workflow`, `payload`, `cli` and `install`, the assertions about removed text are deleted rather than inverted. An assertion that the README *doesn't* mention `jen watch` would be exactly the kind of lingering reference this change removes. Any export in `test/helpers.ts` or `test/fixture.ts` left without a caller goes too.

`test/workflow.test.ts` pins the **Verdicts and merges** approval convention. The convention survives with its identity sentence reworded, so that test is edited rather than deleted.

## Risks / Trade-offs

- **[A reference survives in prose]** → Before handing off, grep the repository, excluding `CHANGELOG.md`, `openspec/changes/archive/` and `node_modules/`, for `jen run`, `jen watch`, `dispatch`, `tick`, `runner`, `JEN_GH`, `LINEAR_API_KEY`, `On Pause`, `setup-jen`, `identity`, `role`, `installation token` and `jen:run`. Every hit gets read and either kept for a stated reason or removed. As `openspec/changes/AGENTS.md` warns, this checks behaviour at requirement granularity, not just files.
- **[`--strict` passes while a main spec still contradicts the change]** → The same grep covers `openspec/specs/`. The deltas here came from exactly that search (`openspec-integration` was found that way), but implementation reruns it after the edits.
- **[Archive is the first thing to exercise the deltas' application]** → Implementation runs `openspec archive --yes` against a scratch copy of `openspec/` after deleting the five directories, and confirms it succeeds before handing off. That's the check that found the empty-spec abort.
- **[Breaking the published CLI]** → jen has no adopters. A minor changeset (pre-1.0) records that `run` and `watch` are gone, so the next release says so.
- **[The Apps still hold write access to `reveer-ai/jen-cli`]** → Out of this change's reach. The closing comment names them so a person can uninstall them.

## Migration Plan

None inside the repository. For any project that installed jen, `jen update` removes `setup-jen` and replaces the root `AGENTS.md`. Their `registry.yaml` is project-owned and keeps whatever identity entries it holds, which are inert. Outside the repository, uninstalling the three Apps and the Linear agent is a person's step, named in the handoff.
