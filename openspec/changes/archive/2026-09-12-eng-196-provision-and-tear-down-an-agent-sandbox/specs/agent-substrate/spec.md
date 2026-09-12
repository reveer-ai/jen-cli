## ADDED Requirements

### Requirement: The substrate lives at a top-level `agent/` root

The agent substrate SHALL live in a top-level `agent/` directory. It SHALL NOT live under `cli/`, and it SHALL NOT live under `src/`.

`cli/` holds jen's CLI — the dispatcher, the stage table, the Linear client, the executor that launches stage sessions. The substrate is not an extension of that. It is a ground-up redesign of how work gets coordinated, built while its shape is still being found, and it must not inherit the assumptions the CLI is built on: a fixed skill table, one identity per stage, and a tracker as the coordination surface. A separate root is what keeps that separation physical rather than a matter of discipline.

The substrate SHALL NOT be reachable from `cli/`. No module under `cli/` may import a module under `agent/`, and no module under `agent/` may import a module under `cli/`.

#### Scenario: The substrate has its own root

- **WHEN** the repository is listed
- **THEN** the substrate's TypeScript sources are under `agent/`
- **AND** no substrate source file exists under `cli/` or `src/`

#### Scenario: The two bodies of code do not reach each other

- **WHEN** the import graph of `cli/` and `agent/` is examined
- **THEN** no module under `cli/` imports a module under `agent/`
- **AND** no module under `agent/` imports a module under `cli/`

#### Scenario: The substrate is tracked

- **WHEN** a source file is added under `agent/`
- **THEN** git reports it as untracked and stageable, with no change to `.gitignore`

### Requirement: The substrate is outside the repository's build, checks, and published package

The substrate SHALL NOT be compiled by the repository's build command, typechecked by its typecheck command, executed by its test command, run by CI, or included in the published tarball. `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts` and the CI workflow SHALL be left unchanged on its account.

This is deliberate and it is temporary. The substrate is being designed while its shape is still unsettled, and wiring it into the checks that gate every pull request would make an unfinished experiment a condition of merging unrelated work.

This concerns where the substrate's tests are *executed*, never whether they exist. The substrate SHALL be tested as thoroughly as code that CI does run — behaviour implemented without tests is not made acceptable by the absence of a check that would have reported it.

The cost SHALL be recorded rather than left to be discovered: **no automated check covers `agent/`**, so nothing catches a regression there until a person runs its tests by hand. The condition for reversing this is that the substrate stops being an experiment — when something depends on it, or when it is to be published, it SHALL be wired into the repository's checks in the same change that makes either true.

#### Scenario: The repository's build ignores the substrate

- **WHEN** the repository's build command is run
- **THEN** it compiles `cli/` only
- **AND** no substrate output appears in `dist/`

#### Scenario: The published tarball excludes the substrate

- **WHEN** the package is packed and the tarball's entries are listed
- **THEN** no path under `agent/` appears
- **AND** the manifest's `files` field is unchanged

#### Scenario: The substrate is tested regardless

- **WHEN** behaviour is added to the substrate
- **THEN** tests covering it are added in the same change
- **AND** they are runnable by the substrate's own test command

#### Scenario: CI does not run the substrate's tests

- **WHEN** a pull request changes only files under `agent/`
- **THEN** the CI check runs the same commands it runs for any other pull request
- **AND** none of them execute the substrate's tests

### Requirement: The substrate carries its own TypeScript and test configuration

The substrate SHALL carry a TypeScript configuration of its own, holding its sources to the same compiler strictness the CLI is held to — strict type checking, the repository's module resolution, and no unchecked indexed access. It SHALL be a typecheck rather than a build: the substrate emits no compiled output, so it introduces no artifact to ignore, clean, or accidentally publish.

It SHALL also carry a test configuration of its own, so its tests are runnable without the repository's test command and without the constraints that command carries for jen's own suite.

A configuration of the substrate's own is what makes the strictness real. Without one, an editor resolves the nearest configuration, finds none that covers `agent/`, and falls back to inferred defaults that are neither strict nor consistent with the repository's — so the errors a contributor sees would not be the errors any check would report.

#### Scenario: The substrate's sources are strictly typed

- **WHEN** the substrate's typecheck is run against a source file that violates strict type checking
- **THEN** it reports the error

#### Scenario: The typecheck emits nothing

- **WHEN** the substrate's typecheck is run and completes
- **THEN** no compiled output is written anywhere in the repository

#### Scenario: The substrate's tests run on their own

- **WHEN** the substrate's test command is run
- **THEN** its tests execute without invoking the repository's own test suite

### Requirement: The substrate adds no dependency and no package manifest

The substrate SHALL NOT introduce a package manifest of its own, and SHALL NOT add a dependency to the repository's. It SHALL use the tooling the repository already carries.

A manifest is warranted by a dependency and by nothing else. The substrate has none: its sandbox driver reaches the container runtime by running its command-line client as a subprocess rather than through a client library.

If the substrate later requires a dependency the repository does not carry, or is to be published separately, it SHALL gain its own manifest in the change that makes either true.

#### Scenario: No new manifest

- **WHEN** the repository's files are listed
- **THEN** no package manifest exists under `agent/`

#### Scenario: No new dependency

- **WHEN** the repository's manifest is compared against its state before this change
- **THEN** its dependency and devDependency sets are unchanged
