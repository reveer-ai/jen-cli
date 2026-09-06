## MODIFIED Requirements

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
