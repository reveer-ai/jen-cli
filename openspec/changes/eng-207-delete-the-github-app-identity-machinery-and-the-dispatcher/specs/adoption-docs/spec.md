## MODIFIED Requirements

### Requirement: The documented path has been executed

Before the documentation is published, the path it describes SHALL have been run end to end against a project that did not previously hold jen — installing the package as an adopter installs it, initializing, filling in the registry, editing a managed file, and updating — and the documentation SHALL be corrected from what that run actually did.

The run SHALL exercise the published artifact rather than the working tree: installing from a packed tarball or the registry, so that staging, the manifest's file selection, and dependency resolution are all exercised as an adopter meets them.

Documentation that has not been executed SHALL NOT be treated as satisfying this capability.

#### Scenario: The path is run before publication

- **WHEN** the adopter's documentation is published
- **THEN** every command in it has been run against a project that did not previously hold jen
- **AND** any step that behaved differently from its description has been corrected

#### Scenario: The run uses the packaged artifact

- **WHEN** the adoption path is validated
- **THEN** jen is installed from a tarball or the registry rather than executed from a working tree

### Requirement: The documentation states the permissions the pipeline needs granted

The adopter's documentation SHALL state what a stage session is permitted to do, and SHALL
state that an adopter is not required to enumerate their project's commands for the pipeline
to run them.

It SHALL state that, in a permission mode that judges each action on what it is rather than
matching it against a list, ordinary development work — installing declared dependencies,
running the project's checks, the one-off command a task turns out to need — needs no entry.
It SHALL present that judgment as a property of the permission mode the stage is invoked in,
not as something jen supplies, and SHALL state that an unattended invocation has to select
that mode itself, since jen launches no session and nobody is present to answer a prompt.

It SHALL state that the tracker's tools reach a stage's session through the adopter's own
assistant configuration for the tracker, and SHALL NOT present jen as granting or supplying
them. It SHALL NOT tell an
adopter to add their typecheck, lint, build, or test commands as a condition of unattended
runs, and SHALL NOT present jen as shipping a starting shape for any ecosystem's
conventional command names.

It SHALL state that the tracked assistant configuration is theirs to add to where they do
want a rule of their own, and that an entry there is in force in a stage's session once the
assistant treats the project as trusted. Any
example configuration the documentation shows SHALL be presented as the entries an adopter
adds, and SHALL NOT be presented as a complete file, so that copying it cannot silently
drop what the file already holds.

Because the assistant configuration is written once at installation and owned by the project from then on, jen SHALL NOT be presented as able to add these later. The documentation is what reaches an install that already exists.

#### Scenario: An adopter prepares a project for unattended runs

- **WHEN** the adopter's documentation is read
- **THEN** it states that the project's own check commands need no permission entry
- **AND** it does not name them as something the adopter must grant

#### Scenario: An adopter invokes a stage unattended

- **WHEN** the adopter's documentation is read by someone starting a stage with nobody watching
- **THEN** it states that the invocation has to select the permission mode that judges each action
- **AND** it does not present that judgment as something jen provides

#### Scenario: A stage needs the tracker's tools

- **WHEN** the documentation describes where the tracker's tools come from
- **THEN** it names the adopter's own assistant configuration
- **AND** it does not present jen as granting them

#### Scenario: An adopter's stack is not the one jen assumes

- **WHEN** an adopter whose project is outside any one ecosystem's conventions reads the documentation
- **THEN** it does not describe a starting shape that fails to apply to their project
- **AND** their toolchain is not treated as a case needing extra configuration

#### Scenario: An adopter copies the example

- **WHEN** the documentation's example configuration is copied into a project
- **THEN** whatever the file already holds is not lost by the copying
- **AND** the example is shown as entries to add rather than as the whole file

#### Scenario: An existing install predates the guidance

- **WHEN** a project was installed before this guidance existed
- **THEN** the documentation tells the adopter that the entries jen once wrote are theirs to remove or keep
- **AND** does not suggest that an update will change that file for them

## REMOVED Requirements

### Requirement: The ownership boundary is stated before the instructions
**Reason**: One of its scenarios says the runner reads the registry when it starts, and there is no runner any more. Scenarios can't be removed from a requirement in place, so it is replaced by *The ownership boundary is stated ahead of the installation steps*.
**Migration**: None needed. The replacement carries every other part of it unchanged.

### Requirement: The adoption path is documented end to end
**Reason**: It made running the binding skill (`setup-jen`) a step on the path, and that skill is removed. It is replaced by *The adoption path is documented from installation to update*.
**Migration**: The adopter fills in `registry.yaml` by hand.

### Requirement: The documentation states what the environment set on the runner reaches
**Reason**: The environment passthrough and its per-stage narrowing belonged to the executor `jen run` launched sessions through. That executor is removed, so there is no runner whose environment reaches a session.
**Migration**: None. Stages run in whatever session a person invokes them from.

### Requirement: The documentation says how autonomy is turned on, what it does once it is, and what drives it
**Reason**: jen no longer ships a way to make the pipeline act on its own. `jen run`, `jen watch`, the runner's credentials and the project-status halt are all removed. Autonomy on managed projects is ENG-206's chief agent.
**Migration**: None. Stages run in whatever session a person invokes them from.

### Requirement: The documentation states the session-tool version the pipeline requires
**Reason**: The minimum CLI version existed because of an option the executor passed when it launched a session. Nothing in jen launches a session any more.
**Migration**: None. Stages run in whatever session a person invokes them from.

## ADDED Requirements

### Requirement: The ownership boundary is stated ahead of the installation steps

The adopter's documentation SHALL state which files jen owns and overwrites and which the project owns, and SHALL state it ahead of the installation steps.

An adopter who hand-edits a managed file loses that edit on the next update. Discovering the boundary after the loss is the failure this ordering exists to prevent, so the boundary SHALL NOT be relegated to a later section, a footnote, or a reference to the specifications.

The statement SHALL cover, at minimum: that root `AGENTS.md` and the shipped skills are jen's and are replaced wholesale; that `registry.yaml` and the assistant settings are written once and never touched again; that everything else — the project's sources, its specs, and any skill it authors — is the project's; and what the ownership stamp does, which is to mark a file as jen's to *remove* rather than to decide whether it is overwritten.

The documentation SHALL NOT present removing the stamp as a way to keep an edit to a skill jen currently ships. It does not: the payload is written to its declared paths unconditionally, and the next update restores both the file and its stamp. Stating otherwise would tell an adopter their edit is safe in exactly the case where it is lost.

#### Scenario: The boundary precedes the install instructions

- **WHEN** the adopter's documentation is read from the top
- **THEN** the ownership boundary appears before the installation command

#### Scenario: An adopter checks whether an edit will survive

- **WHEN** an adopter wants to know whether editing a shipped skill is safe
- **THEN** the documentation states that the file is jen's and that an update replaces it
- **AND** it states that removing the stamp does not prevent that
- **AND** it names authoring a separate skill as the way to hold code the update will not touch

#### Scenario: An adopter learns what the stamp actually governs

- **WHEN** the documentation describes the ownership stamp
- **THEN** it states that a stamped file jen no longer ships is deleted on update
- **AND** that removing the stamp from such a file keeps it
- **AND** that a file jen never shipped is left alone whether or not it is stamped

### Requirement: The adoption path is documented from installation to update

The documentation SHALL carry the complete path from an unadopted project to one running the workflow: installing the package, running `jen init`, recording the project's repository and tracker in `registry.yaml`, and running `jen update` to take a later version.

Each step SHALL be given as the command an adopter runs, or as the edit they make where no command performs it. The documentation SHALL NOT present filling in the registry as something installation performed.

#### Scenario: An adopter reaches a working project

- **WHEN** an adopter follows the documented path in order
- **THEN** the payload is installed, the registry names the project's repository and tracker, and the stages can be invoked against its tasks

#### Scenario: The registry is identified as the adopter's to fill in

- **WHEN** the documentation describes the registry
- **THEN** it states that `jen init` writes a stub and the adopter fills it in by hand

#### Scenario: Taking a later version is documented

- **WHEN** an adopter on an earlier version wants the current one
- **THEN** the documentation names the command that refreshes the managed files and removes those jen no longer ships
