## MODIFIED Requirements

### Requirement: A stage is permitted to run what its instructions require

The permissions a run is granted SHALL cover the commands and tools its stage's instructions
tell it to use. A stage instructed to do something the harness denies cannot do its work, and
an unattended run has no one to grant the permission when it is asked for.

This SHALL be satisfied by how the session is started rather than by what was written into
configuration before it started. A session decides each action on what the action is, so the
commands a stage's instructions name are permitted without any of them having been listed
anywhere. jen SHALL NOT grant the workflow's own tooling — version control, the git host, the
specification tooling — in the assistant configuration it writes, even though that tooling is
the same across every project. Sameness was the argument for writing it down, and it does not
survive the change of arrangement: an entry resolves *before* the per-action judgment is made,
so granting the workflow's own calls is what exempts them from the judgment every other action
gets. The pipeline's git-host calls include its approving review and its merge, which are the
calls least worth exempting.

Permissions that differ by install SHALL still be identified rather than assumed — the
tracker's tooling, whose identifiers differ per install and so cannot be named in configuration
shared by every project. This is a question of where a per-install value can be written at all,
and SHALL NOT be read as a residual list of grants the workflow depends on.

#### Scenario: A stage runs the project's checks

- **WHEN** a stage is instructed to run the project's typecheck, lint, build, or tests
- **THEN** the run is permitted to execute them without asking

#### Scenario: The workflow's own tooling would be granted

- **WHEN** jen writes the assistant configuration a stage's session will read
- **THEN** it grants neither the version control, git host, nor specification tooling the workflow itself uses
- **AND** a stage's call to that tooling is judged on what the call is, like any other action

#### Scenario: A permission cannot be granted in shared configuration

- **WHEN** a permission's identifier differs per install
- **THEN** it is granted where that difference is known rather than written into configuration shared by every project
