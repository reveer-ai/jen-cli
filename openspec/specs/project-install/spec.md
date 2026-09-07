# project-install Specification

## Purpose

Defines what `jen init` and `jen update` do to a project on disk — which files each writes, when a file is refreshed rather than left alone, when one is removed, and the boundaries both commands hold to so that adopting or upgrading the workflow can never destroy what the project itself authored.

## Requirements

### Requirement: `jen init` installs the payload into a project

`jen init` SHALL write every managed file declared by the `managed-payload` capability into the target project: each fixed path at its declared location, and each variable-set member into the set's declared target directory, carrying the ownership stamp it was staged with.

The command SHALL take the project root as an optional argument, defaulting to the working directory.

#### Scenario: An empty project receives the payload

- **WHEN** `jen init` runs in a directory holding no jen-managed file
- **THEN** root `AGENTS.md` is written
- **AND** each stage skill is written to `.claude/skills/<name>/SKILL.md`
- **AND** each written skill carries the ownership stamp

#### Scenario: The installed skill matches what was shipped

- **WHEN** `jen init` completes
- **THEN** each installed `SKILL.md` is byte-identical to the corresponding file in the package's staged payload

### Requirement: `jen init` refuses to adopt a project that already holds a fixed path

A fixed path carries no ownership stamp, so on first contact jen cannot distinguish a file it wrote from one the project authored. `jen init` SHALL therefore compare each fixed path against the payload it ships and, when the path exists and its content differs, SHALL make no change to the project, report the conflicting path, and exit non-zero.

A `--force` option SHALL override the refusal and write the payload regardless.

The refusal SHALL be reported as an unsupported adoption rather than as a corrupt project: adopting a project that already holds content is a migration, and jen does not yet perform one.

#### Scenario: An existing differing `AGENTS.md` blocks adoption

- **WHEN** a project has a root `AGENTS.md` whose content differs from the shipped one and `jen init` runs without `--force`
- **THEN** the existing `AGENTS.md` is unchanged
- **AND** no managed file is written anywhere in the project
- **AND** the command names the conflicting path and exits non-zero

#### Scenario: An identical fixed path is not a conflict

- **WHEN** a project's root `AGENTS.md` is already byte-identical to the shipped one and `jen init` runs
- **THEN** adoption proceeds
- **AND** the command exits zero

#### Scenario: Force overrides the refusal

- **WHEN** `jen init --force` runs in a project whose root `AGENTS.md` differs from the shipped one
- **THEN** the file is replaced with the shipped content
- **AND** the command exits zero

#### Scenario: Nothing is written before the conflict is detected

- **WHEN** adoption is refused
- **THEN** no stage skill has been written
- **AND** no scaffold file has been created

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

### Requirement: `jen update` refreshes managed files and removes those jen no longer ships

`jen update` SHALL write every managed file the current version ships, replacing existing content, and SHALL then remove every stamped file that the current version does not ship, per the deletion rule in `managed-payload`.

`jen update` SHALL NOT write the once-only scaffold and SHALL NOT apply the fixed-path refusal — a project being updated has already adopted, and wholesale ownership applies from that point on.

`jen update` SHALL succeed on a project that never ran `jen init`, writing the payload and reconciling exactly as it would otherwise. Ownership is legible from the files on disk, so no record of a previous run is required and no distinct uninitialized case exists.

#### Scenario: A hand-edited managed file is restored

- **WHEN** a project's `.claude/skills/design-task/SKILL.md` has been edited and `jen update` runs
- **THEN** the file is byte-identical to the shipped one afterward

#### Scenario: A skill this version no longer ships is removed

- **WHEN** a project holds a stamped `.claude/skills/legacy-stage/SKILL.md` that the current payload does not include
- **THEN** `jen update` deletes it

#### Scenario: A project-authored skill is left alone

- **WHEN** a project holds an unstamped `.claude/skills/deploy-service/SKILL.md` and `jen update` runs
- **THEN** the file is unchanged

#### Scenario: A claimed copy is left alone

- **WHEN** a project has copied a stage skill to a new name and deleted the stamp from the copy
- **THEN** `jen update` neither overwrites nor deletes it

#### Scenario: Update works without a prior init

- **WHEN** `jen update` runs in a project that has never been initialized
- **THEN** the payload is written
- **AND** the command exits zero without reporting a missing installation

### Requirement: Reconciliation is bounded to declared target directories

The search for stamped files SHALL be confined to the target directories the payload's variable sets declare, at the depth those sets write. jen SHALL NOT walk the project tree looking for stamps, and SHALL NOT consider a stamped file outside a declared target directory a deletion candidate.

#### Scenario: A stamped file outside a target directory survives

- **WHEN** a project holds a stamped file at `docs/SKILL.md` and `jen update` runs
- **THEN** the file is unchanged

#### Scenario: The search does not descend past the set's depth

- **WHEN** a project holds a stamped file at `.claude/skills/team/nested/SKILL.md`, deeper than the variable set writes
- **THEN** `jen update` leaves it unchanged

#### Scenario: Unrelated content in the target directory survives

- **WHEN** `.claude/skills/` holds a directory with no `SKILL.md` in it
- **THEN** neither command removes it

### Requirement: Neither command writes outside managed paths

Every filesystem write, replacement, or deletion either command performs SHALL fall within the managed paths declared by `managed-payload` or the scaffold paths named above. No other path in the project SHALL be created, modified, or removed.

This boundary SHALL be enforced against the filesystem rather than against the path as written, because a symlink turns an in-bounds path into a write anywhere at all. Accordingly:

- A symlink occupying a managed path SHALL be replaced with a regular file rather than written through. It SHALL count as content already at that path, so `jen init` treats a symlinked fixed path as a conflict.
- When a symlinked directory lies between the project root and a managed path, neither command SHALL write to or delete anything below it, and neither SHALL treat anything below it as a deletion candidate. The run SHALL instead report the link and exit non-zero having written nothing at all — including the managed paths it could have reached. `--force` SHALL NOT override this: it grants permission to replace a file jen owns wholesale, not to write outside the project.

The project's `.gitignore` SHALL NOT be written or modified. jen SHALL instead report any managed path that the project's ignore rules exclude, because a managed file inside an ignored path is absent from a fresh clone and invisible to review.

#### Scenario: An unrelated project file is untouched

- **WHEN** either command runs in a project containing application sources, configuration, and documentation
- **THEN** no file outside the managed and scaffold paths is created, modified, or removed

#### Scenario: An existing `.gitignore` is not modified

- **WHEN** `jen init` runs in a project with a `.gitignore`
- **THEN** the file's content is unchanged

#### Scenario: An ignored managed path is reported

- **WHEN** a project's ignore rules exclude `.claude/`
- **THEN** the command reports that a managed path is ignored

#### Scenario: A symlink at a managed path is replaced, not followed

- **WHEN** a project's root `AGENTS.md` is a symlink to its own `CLAUDE.md` and `jen update` runs
- **THEN** `AGENTS.md` is a regular file holding the shipped content
- **AND** `CLAUDE.md` is unchanged

#### Scenario: A symlink pointing outside the project is not written through

- **WHEN** a project's root `AGENTS.md` is a symlink to a file outside the project root and `jen update` runs
- **THEN** the file outside the project is unchanged

#### Scenario: A dangling symlink at a fixed path is a conflict, not an absence

- **WHEN** a project's root `AGENTS.md` is a symlink to a path outside the project that does not exist, and `jen init` runs without `--force`
- **THEN** adoption is refused
- **AND** no file is created outside the project

#### Scenario: A symlinked target directory blocks the run

- **WHEN** a project's `.claude/skills` is a symlink to a directory outside the project holding a stamped file, and `jen update` runs
- **THEN** the command reports the symlink and exits non-zero
- **AND** no managed file is written, in the project or outside it
- **AND** the stamped file outside the project is not deleted

### Requirement: Both commands are non-interactive and idempotent

Neither command SHALL prompt for input, read from standard input, or require credentials, on any path including failure. Both SHALL be safe to run unattended in CI.

Running either command twice against an unchanged project and package SHALL leave the second run with nothing to change on disk.

Each command SHALL report what it did — which managed paths it wrote, which it refreshed, and which it removed — and SHALL exit zero on success and non-zero on failure.

#### Scenario: A second run changes nothing

- **WHEN** `jen update` runs twice in succession against the same project and package version
- **THEN** the second run makes no change to any file's content

#### Scenario: No prompt is issued

- **WHEN** either command runs with standard input closed
- **THEN** it completes or fails without waiting for input

#### Scenario: Failure is reported and signalled

- **WHEN** a command cannot complete
- **THEN** it reports the reason
- **AND** exits non-zero
