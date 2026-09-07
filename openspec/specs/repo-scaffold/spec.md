# repo-scaffold Specification

## Purpose
TBD - created by archiving change eng-131-initialize-jen. Update Purpose after archive.
## Requirements
### Requirement: Ignored files stay visible to search tooling

The repository SHALL carry an `.ignore` file that re-admits every path (`!*`) for editor and search tooling, so that paths `.gitignore` excludes — the governed project's sources under `src/`, build output, and dependencies — stay readable to tools that honor ignore files when searching.

#### Scenario: An agent searches the working tree

- **WHEN** an agent searches with tooling that honors ignore files
- **THEN** files ignored by `.gitignore` are still returned
- **AND** the project's own untracked sources are readable

#### Scenario: The same file is searched and committed

- **WHEN** a file is admitted by `.ignore` but not by `.gitignore`
- **THEN** search tooling shows it
- **AND** git still refuses to track it

### Requirement: Resources are declared in a registry

All work SHALL happen in the context of resources declared in `registry.yaml`, which records each resource with its access and setup information.

The stub `jen init` writes SHALL describe the arrangement an adopted project actually has: the project's own sources tracked under `src/` in the same repository as the workflow's files. Its illustrative content SHALL NOT depict the project's sources as a separate repository cloned into `src/`, which is jen's own arrangement rather than an adopter's and contradicts the repository model the workflow document states.

Nothing in jen's repository reads the scaffold. Its content is inert text here and becomes instructions only in an installed project, so an error in it is invisible to every check jen runs on itself and SHALL be verified against an installed project rather than assumed correct.

#### Scenario: An agent starts a task

- **WHEN** an agent needs to know what it is acting on
- **THEN** it consults `registry.yaml` for the resources relevant to the task

#### Scenario: The stub describes the adopted project's own layout

- **WHEN** an adopter reads the `registry.yaml` that `jen init` wrote
- **THEN** its illustrative content shows the project's sources under `src/` in this same repository
- **AND** no example depicts them as a separately cloned repository

#### Scenario: The scaffold is checked where it takes effect

- **WHEN** the scaffold's content is validated
- **THEN** it is read as installed in a project rather than only as it sits in jen's repository

### Requirement: Assistant configuration is shared except where it is per-install

Assistant configuration SHALL be split in two. The tracked half, `.claude/settings.json`,
SHALL be present in every clone and SHALL be the project's own — the seat its permissions,
hooks, and other assistant configuration take when it has any to declare.

jen SHALL NOT grant permissions in it. A session decides each action on what the action is,
so the workflow's stages depend on no entry jen could write there, and an entry written on a
project's behalf is a guess at a toolchain that did not exist when jen shipped. Seeding the
file with grants SHALL be understood as costing more than it gives: the entries mislead an
adopter about what the pipeline needs, and each one exempts what it matches from the judgment
every other action receives — silently, since nothing in a run reports that a rule matched.

The file SHALL still be written and SHALL still be tracked. It is what the run establishes
trust for, and a project that declares nothing on installation may declare something later
without jen being involved.

Configuration whose values differ from one install to the next — `.claude/settings.local.json`, which carries MCP server ids meaningless in anyone else's clone — SHALL NOT be tracked.

#### Scenario: A clone needs the permissions the stages use

- **WHEN** the repository is cloned
- **THEN** `.claude/settings.json` is present
- **AND** the workflow's stages do not depend on any permission it grants

#### Scenario: jen would seed the file with commands

- **WHEN** the scaffold's assistant configuration is written
- **THEN** it grants no build, lint, typecheck, or test command
- **AND** it grants no command on the project's behalf at all

#### Scenario: A project declares a permission of its own

- **WHEN** a project adds an entry to the tracked assistant configuration
- **THEN** it is the project's entry rather than one jen wrote
- **AND** it is in force in a dispatched run

#### Scenario: Per-install configuration is written

- **WHEN** an install writes `.claude/settings.local.json`
- **THEN** git does not record it
- **AND** it stays local to that install

