## REMOVED Requirements

### Requirement: OpenSpec is available to agents without out-of-band setup
**Reason**: Part of this requirement obliged the dispatcher to make OpenSpec reachable inside the bare clones it launched sessions into. The dispatcher is gone, and scenarios can't be removed from a requirement in place. It is replaced by *OpenSpec is available to an adopted project without out-of-band setup*, which keeps everything else.
**Migration**: None. A stage runs in a checkout where the project's dependencies are installed, which is how OpenSpec already resolves in an attended checkout.

## ADDED Requirements

### Requirement: OpenSpec is available to an adopted project without out-of-band setup

OpenSpec SHALL be obtained from the version jen declares as a dependency, and SHALL NOT be carried in-tree as copied skills or command wrappers. A vendored copy is a snapshot that goes stale silently as OpenSpec releases, and it obliges jen to know OpenSpec's file list.

`jen init` SHALL initialize OpenSpec in the target project by invoking the OpenSpec CLI resolved from jen's own dependency tree, so that adoption is a single command. It SHALL do so only when the project is not already OpenSpec-initialized, and SHALL leave an initialized project's OpenSpec configuration untouched.

An adopted project SHALL be able to run OpenSpec for the life of the project, since every stage of the workflow depends on it. Installing jen as a project dependency is what satisfies this, bringing OpenSpec with it and pinning both versions in the project's lockfile. jen SHALL NOT create or modify the project's package manifest to achieve this; where OpenSpec would not resolve from the project after initialization, `jen init` SHALL report it, so that a project installed some other way is told rather than left to discover it at the first stage.


#### Scenario: An agent works in a fresh clone

- **WHEN** a fresh clone of an adopted project has its dependencies installed
- **THEN** the OpenSpec skills and command wrappers are present
- **AND** no setup step beyond the install is required before the first artifact is created

#### Scenario: A skill is invoked by name

- **WHEN** an agent invokes one of the `openspec-*` skills
- **THEN** the skill is resolvable from the project's own `.claude/skills/`
- **AND** it was produced from the declared dependency rather than from a copy tracked in the repository

#### Scenario: OpenSpec is initialized during adoption

- **WHEN** `jen init` runs in a project that is not OpenSpec-initialized
- **THEN** OpenSpec is initialized in that project
- **AND** its skills and command wrappers are present afterward

#### Scenario: An initialized project is left alone

- **WHEN** `jen init` runs in a project that already holds an `openspec/` directory
- **THEN** OpenSpec initialization is skipped
- **AND** the existing OpenSpec configuration is unchanged

#### Scenario: No OpenSpec file is carried in-tree

- **WHEN** jen's shipped payload is listed
- **THEN** it contains no OpenSpec skill and no OpenSpec command wrapper

#### Scenario: An unreachable OpenSpec is reported

- **WHEN** `jen init` completes in a project from which the OpenSpec CLI would not resolve
- **THEN** the command reports it, naming how to make OpenSpec available

#### Scenario: The package manifest is not written

- **WHEN** `jen init` runs in a project with a package manifest
- **THEN** the manifest is unchanged
