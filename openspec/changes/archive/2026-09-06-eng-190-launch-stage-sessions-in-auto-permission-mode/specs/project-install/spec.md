## MODIFIED Requirements

### Requirement: `jen init` writes a scaffold the project then owns

`jen init` SHALL create `registry.yaml` and `.claude/settings.json` when they are absent. `registry.yaml` SHALL be written as a stub whose unfilled state is distinguishable from a registry a project has filled in, so that a later setup step can tell the two apart. `.claude/settings.json` SHALL be written as the seat a project's own assistant configuration takes, and SHALL NOT be seeded with permissions: no permission written there is one the workflow's stages depend on.

Creating it empty of grants SHALL be understood as the point rather than an omission. The file is what a dispatched run establishes trust for, so it has to exist on installation; what it must not do is arrive carrying a guess at the adopter's toolchain, or grants for the workflow's own tooling that would exempt the pipeline's calls from the judgment each action otherwise gets.

Both files SHALL be project-owned from the moment they exist. jen SHALL NOT overwrite, merge into, or delete either on any subsequent run, including `jen init` re-run and `jen update`. An install predating this arrangement therefore keeps the entries jen once wrote, and removing them SHALL be the adopter's to do rather than something an update performs.

jen SHALL NOT write `openspec/config.yaml` itself; it is produced by the delegation described in the `openspec-integration` capability.

#### Scenario: The scaffold is created on first adoption

- **WHEN** `jen init` runs in a project holding neither file
- **THEN** `registry.yaml` is created as a stub
- **AND** `.claude/settings.json` is created granting nothing

#### Scenario: An existing scaffold file is left alone

- **WHEN** `jen init` runs in a project whose `registry.yaml` has been filled in
- **THEN** its content is unchanged

#### Scenario: `--force` does not extend to the scaffold

- **WHEN** `jen init --force` runs in a project with an existing `.claude/settings.json`
- **THEN** that file is unchanged

#### Scenario: An install predates the empty scaffold

- **WHEN** `jen update` runs in a project whose `.claude/settings.json` carries permissions an earlier jen wrote
- **THEN** they are left in place
- **AND** removing them is the project's to decide

#### Scenario: Update never writes the scaffold

- **WHEN** `jen update` runs in a project whose `registry.yaml` has been deleted
- **THEN** it is not recreated
