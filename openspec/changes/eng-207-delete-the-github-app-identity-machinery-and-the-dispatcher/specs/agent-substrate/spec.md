## MODIFIED Requirements

### Requirement: The substrate lives at a top-level `agent/` root

The agent substrate SHALL live in a top-level `agent/` directory. It SHALL NOT live under `cli/`, and it SHALL NOT live under `src/`.

`cli/` holds jen's CLI — the installer that writes the workflow document and its stage skills into a project. The substrate is not an extension of that. It is a ground-up redesign of how work gets coordinated, built while its shape is still being found, and it must not inherit the assumptions the workflow is built on: a fixed skill table and a tracker as the coordination surface. A separate root is what keeps that separation physical rather than a matter of discipline.

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
