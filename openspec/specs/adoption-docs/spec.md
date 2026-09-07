# adoption-docs Specification

## Purpose

Defines what the project's documentation must tell someone adopting jen — where the boundary between jen's files and theirs falls, how to get from an empty project to a running pipeline, and what the workflow does not yet do — and requires that the path described has been executed rather than only written.

## Requirements

### Requirement: The published front page addresses the adopter

The repository's `README.md` SHALL document adopting and operating jen. It SHALL NOT be a contributor guide.

The registry publishes `README.md` as the package's front page irrespective of which paths the manifest's `files` field selects, so this file is an adopter's first contact with the project whether or not it was written for them.

#### Scenario: The package page documents adoption

- **WHEN** the published package's front page is read
- **THEN** it describes installing jen and running the workflow
- **AND** it does not lead with instructions for building or packaging jen itself

#### Scenario: Documentation reaches the registry without being selected

- **WHEN** the published tarball is inspected
- **THEN** `README.md` is present, though `files` names only the build output

### Requirement: The ownership boundary is stated before the instructions

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

#### Scenario: An adopter wants to change which project the pipeline polls

- **WHEN** an adopter looks for where the pipeline's tracker project is set
- **THEN** the documentation names the registry as the place to change it
- **AND** states that the runner reads it from the checkout when it starts

### Requirement: The adoption path is documented end to end

The documentation SHALL carry the complete path from an unadopted project to a running pipeline: installing the package, running `jen init`, running the binding skill, and running `jen update` to take a later version.

Each step SHALL be given as the command an adopter runs. The documentation SHALL distinguish the steps the CLI performs from the step that requires a conversation with the user, since binding is a skill rather than a subcommand and no command will perform it.

#### Scenario: An adopter reaches a bound project

- **WHEN** an adopter follows the documented path in order
- **THEN** the payload is installed, the project is bound to its tracker, and the pipeline can be driven

#### Scenario: Binding is identified as the user's step

- **WHEN** the documentation describes reaching a bound project
- **THEN** it names the binding skill as a step the user invokes
- **AND** it does not present binding as something installation performed

#### Scenario: Taking a later version is documented

- **WHEN** an adopter on an earlier version wants the current one
- **THEN** the documentation names the command that refreshes the managed files and removes those jen no longer ships

### Requirement: The documented path has been executed

Before the documentation is published, the path it describes SHALL have been run end to end against a project that did not previously hold jen — installing the package as an adopter installs it, initializing, binding, editing a managed file, and updating — and the documentation SHALL be corrected from what that run actually did.

The run SHALL exercise the published artifact rather than the working tree: installing from a packed tarball or the registry, so that staging, the manifest's file selection, and dependency resolution are all exercised as an adopter meets them.

Documentation that has not been executed SHALL NOT be treated as satisfying this capability.

#### Scenario: The path is run before publication

- **WHEN** the adopter's documentation is published
- **THEN** every command in it has been run against a project that did not previously hold jen
- **AND** any step that behaved differently from its description has been corrected

#### Scenario: The run uses the packaged artifact

- **WHEN** the adoption path is validated
- **THEN** jen is installed from a tarball or the registry rather than executed from a working tree

### Requirement: Contributor material lives outside the adopter's document

Material addressed to someone changing jen — building, packaging, testing, and the repository's own layout — SHALL live in a document separate from the adopter's, and the adopter's document SHALL link to it rather than carry it.

This SHALL NOT displace the notes convention: a gotcha about a particular part of the code belongs in the `AGENTS.md` nearest it, and the contributor document SHALL NOT restate those notes.

#### Scenario: Build instructions are not on the package page

- **WHEN** the adopter's documentation is read
- **THEN** it does not carry the build, typecheck, packaging, or staging instructions
- **AND** it links to the document that does

#### Scenario: A contributor finds the checks

- **WHEN** someone intending to change jen reads the contributor document
- **THEN** it names the commands CI runs on every pull request

### Requirement: Documentation states which assistants the payload reaches

The documentation SHALL state that jen writes into `.claude/` only, and that support for another assistant is a symlink the project creates from that assistant's directory to the corresponding `.claude/` path — something jen neither creates nor reads.

#### Scenario: An adopter on another assistant learns where they stand

- **WHEN** an adopter using an assistant other than Claude Code reads the documentation
- **THEN** it states that jen writes `.claude/` only
- **AND** it names the symlink as the project's own step

### Requirement: The documentation states what adoption does not yet cover

The documentation SHALL state that jen does not migrate a project that already holds a conflicting managed file, that `jen init` refuses such a project rather than merging into it, and what the option to override that refusal does.

An adopter meeting the refusal SHALL be able to recognize it from the documentation as a stated limit rather than as a malfunction.

#### Scenario: A project holding its own root instructions is warned

- **WHEN** an adopter whose project already carries a root `AGENTS.md` reads the documentation
- **THEN** it states that initialization will refuse the project and that no file will be written
- **AND** it states what overriding the refusal replaces

### Requirement: The documentation states the permissions the pipeline needs granted

The adopter's documentation SHALL state what a stage session is permitted to do, and SHALL
state that an adopter is not required to enumerate their project's commands for the pipeline
to run them.

It SHALL state that each action is judged on what it is rather than matched against a list,
so ordinary development work — installing declared dependencies, running the project's
checks, the one-off command a task turns out to need — needs no entry. It SHALL NOT tell an
adopter to add their typecheck, lint, build, or test commands as a condition of unattended
runs, and SHALL NOT present jen as shipping a starting shape for any ecosystem's
conventional command names.

It SHALL state that the tracked assistant configuration is theirs to add to where they do
want a rule of their own, and that an entry there is in force in a dispatched run. Any
example configuration the documentation shows SHALL be presented as the entries an adopter
adds, and SHALL NOT be presented as a complete file, so that copying it cannot silently
drop what the file already holds.

Because the assistant configuration is written once at installation and owned by the project from then on, jen SHALL NOT be presented as able to add these later. The documentation is what reaches an install that already exists.

#### Scenario: An adopter prepares a project for unattended runs

- **WHEN** the adopter's documentation is read
- **THEN** it states that the project's own check commands need no permission entry
- **AND** it does not name them as something the adopter must grant

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

### Requirement: The documentation states what the environment set on the runner reaches

The adopter's documentation SHALL state that the variables an operator sets on the runner reach the pipeline's sessions. It SHALL be stated beside the permissions guidance, which answers the neighbouring half of the same question: the permissions section says a project's own commands run without having to be named in advance, and this says how those commands are given the configuration they read.

It SHALL be stated unconditionally. The passthrough is available on the runner jen ships, which is the only runner it ships, so the documentation SHALL NOT carry a caveat naming a runner the mechanism is unavailable on.

It SHALL state that jen's own namespace is withheld from sessions, and that the variables carrying the role credentials are within it, so an adopter does not read the passthrough as exposing them.

It SHALL state how to narrow a variable to a single stage, and SHALL state that the declaration holds variable *names* rather than values. Any example SHALL name more than one variable: a declaration holding a single name is indistinguishable at a glance from a variable holding a value, and an example that reads that way teaches an adopter to write their secret into it.

It SHALL state that the narrowing keys on the stage rather than on the role. An adopter who reasons from the roles will expect a variable given to the stage that tests to be withheld from the stage that merges, and it is not the role that arranges this, since both act under the same one.

#### Scenario: An adopter supplies their project's own test configuration

- **WHEN** an adopter reads the documentation to learn how their suite reaches its database
- **THEN** it states that variables set on the runner reach the stages
- **AND** it states which namespace is withheld from them

#### Scenario: An adopter narrows a variable to one stage

- **WHEN** an adopter wants a credential to reach only the stage that tests
- **THEN** the documentation gives the declaration that arranges it
- **AND** states that the declaration names variables rather than carrying their values

#### Scenario: The example does not read as carrying a value

- **WHEN** the documentation's example declaration is read
- **THEN** it names more than one variable

#### Scenario: The passthrough carries no runner caveat

- **WHEN** an adopter reads how to supply their project's configuration
- **THEN** the mechanism is stated without qualifying which runner it is available on

#### Scenario: An adopter expects the role to scope it

- **WHEN** an adopter assumes that restricting a variable to testing keeps it from delivery because of their roles
- **THEN** the documentation states that reviewing, testing, and delivering share one role
- **AND** that the narrowing is by stage

### Requirement: The documentation says how autonomy is turned on, what it does once it is, and what drives it

The adopter's documentation SHALL carry the step from an installed, bound project to one that acts on its own: what the runner requires configured, and how to start it.

It SHALL state plainly that running the pipeline outside the git host does not remove the git host from it — pull requests, review verdicts, and the merge gate are unchanged, and so are the registered identities they depend on.

The documentation SHALL state that a runner jen does not ship is equally valid, and that anything able to invoke the tick on a schedule is one — a timer, a container, or a scheduled job on the git host. It SHALL NOT supply a workflow file, a template, or a worked example for any of them. jen shipped a scheduled git-host workflow and removed it because the job holds a paid runner for the whole life of every session it launches; publishing a ready-made replacement would return an adopter to that cost with jen's apparent endorsement, where an adopter who writes their own has chosen it.

The documentation SHALL state the conditions that come with the runner and are not obvious from starting it: that a session dies with the process that launched it, what the pipeline then reads on that task, and that a session which hangs hangs the loop until an operator stops it.

Where a value the runner needs may be supplied in more than one form, the documentation SHALL name every accepted form and SHALL state what choosing each one costs. Model access is that case: the pipeline runs on an API key or on a subscription token, and the variable names alone answer neither which to use nor what follows from the answer. The documentation SHALL state how the subscription token is obtained, and that the subscription's usage limits are shared with the adopter's own interactive use of the same account — so a polling pipeline can exhaust a window they were about to work in, surfacing as a stage dying mid-run rather than as a bill. It SHALL state that the token is long-lived and bound to the person who minted it and to their subscription, where an API key is issued independently of any one person. It SHALL NOT describe the token as unscoped: it carries inference-only authority by design, which is what a pipeline session needs and less than a login grants, and an adopter told otherwise would weigh the choice against a risk the credential does not carry. It SHALL state that a runner holds exactly one, and that setting both is refused rather than resolved in the adopter's favour by a precedence.

Where minting the token can be refused by policy on a managed installation, the documentation SHALL say so. An adopter who meets that refusal SHALL be able to recognize it as a stated limit on their installation rather than as a malfunction, and SHALL be left with the other form still open to them.

The alternative spellings of one value SHALL NOT be presented as additional values. The documentation states how many values the runner needs, and an adopter who counts a credential twice looks for a secret they were never meant to store and cannot tell a complete configuration from an incomplete one.

The documentation SHALL state what the pipeline will do while nobody is watching: which transition a human still owns, that a stage may park a task where a person is needed, and how much may run at once.

It SHALL state how to stop it. The halt SHALL be documented as the tracker's project status rather than as stopping a runner or editing task statuses, and SHALL be documented as applying to any runner, including one jen does not ship.

Because the status that pauses the pipeline is one the adopter creates, the documentation SHALL name it exactly, SHALL say which category to file it under, and SHALL state that renaming it disables the halt without any other symptom. An adopter who never creates it SHALL be told what they do not have, since a pipeline missing only its halt runs indistinguishably from one that has it.

#### Scenario: An adopter turns the pipeline on

- **WHEN** an adopter follows the documented steps
- **THEN** the values and credentials the runner needs are named
- **AND** the pipeline polls their project

#### Scenario: An adopter expects the runner to remove the git host

- **WHEN** an adopter reads about the runner
- **THEN** the documentation states that the git host identities and the merge gate are still required

#### Scenario: An adopter wants to run the pipeline on their git host's scheduler

- **WHEN** an adopter reads whether they can drive the pipeline from a scheduled git-host job
- **THEN** the documentation states that anything able to invoke the tick on a schedule is a runner
- **AND** states why jen no longer ships one for the git host
- **AND** supplies no workflow file or template for it

#### Scenario: An adopter reads what the runner does not protect them from

- **WHEN** an adopter reads the conditions that come with the runner
- **THEN** it states that a session dies with the process that launched it, and what the task then reads as
- **AND** states that a hung session hangs the loop until it is stopped

#### Scenario: An adopter already pays for a subscription

- **WHEN** an adopter who does not want to fund an API key reads what model access requires
- **THEN** the documentation names the subscription token as an accepted form
- **AND** says how it is obtained

#### Scenario: An adopter weighs the subscription against a key

- **WHEN** an adopter reads what choosing the subscription costs
- **THEN** the documentation states that its usage limits are shared with their own interactive work
- **AND** states that it is bound to the person who minted it and to their subscription
- **AND** does not describe it as carrying authority beyond inference

#### Scenario: An adopter's installation forbids minting a token

- **WHEN** an adopter on a managed installation is refused the subscription token
- **THEN** the documentation has already named that a policy can refuse it
- **AND** states that the API key remains open to them

#### Scenario: An adopter holds both forms

- **WHEN** an adopter reads what happens if both model credentials are set
- **THEN** the documentation states that the run refuses rather than choosing one

#### Scenario: An adopter counts what they must store

- **WHEN** an adopter reads how many values the runner needs
- **THEN** the two spellings of model access are counted as one value

#### Scenario: An adopter wants it stopped

- **WHEN** an adopter looks for how to halt the pipeline
- **THEN** the documentation names the project status that halts dispatch
- **AND** says where to create it and which category it belongs under
- **AND** states that it applies to any runner, including one jen does not ship

#### Scenario: An adopter reads what the halt costs

- **WHEN** an adopter reads how the pause status is matched
- **THEN** the documentation states that renaming it turns the halt off silently

### Requirement: The documentation states the session-tool version the pipeline requires

The adopter's documentation SHALL state the minimum version of the assistant CLI the
pipeline's sessions are launched with, and SHALL say that a host below it cannot run the
pipeline.

It SHALL be stated as a prerequisite rather than as a note, because the failure it prevents
does not present as a version problem: the invocation carries an option an older CLI does
not recognize, the session is refused before it starts, and the run reports a stage that
produced nothing. An adopter reading that has no reason to look at their CLI version.

#### Scenario: An adopter prepares a host for the pipeline

- **WHEN** the adopter's documentation is read
- **THEN** it names the minimum assistant CLI version the pipeline requires

#### Scenario: An adopter's host is below the minimum

- **WHEN** the pipeline is run on a host whose CLI predates the stated version
- **THEN** the documentation is what tells the adopter why no session starts
