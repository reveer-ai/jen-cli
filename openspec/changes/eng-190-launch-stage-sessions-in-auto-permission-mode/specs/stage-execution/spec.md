## ADDED Requirements

### Requirement: A session's permissions are decided per action, not enumerated in advance

A session SHALL be started under an arrangement that decides each action on what the action
is, rather than one that permits only what was named before the session began. jen SHALL
NOT be the party that enumerates the commands a stage may run.

The reason is that the enumeration cannot be written. A stage's work is an arbitrary
project's own toolchain — its installs, its checks, the one-off command a task turns out to
need — and jen chooses what it ships before any of that exists. A list written under that
constraint is wrong in both directions at once: it grants entries a project has no use for
and withholds the ones it depends on. The cost SHALL be understood as falling on the run
rather than on the list: an unattended session denied a command has nobody to ask, so it
either stops with the work undone or proceeds without the check it was told to make.

Where a project names its own permissions, those SHALL still be in force, and SHALL still be
what the run establishes trust for. The per-action arrangement replaces what jen enumerates
on a project's behalf, not what a project enumerates for itself.

#### Scenario: A stage runs a command nothing named in advance

- **WHEN** a session runs an ordinary development command that no configuration lists
- **THEN** it is judged on what the command is
- **AND** it is not refused merely for being unlisted

#### Scenario: A stage installs what its own task list requires

- **WHEN** a stage's first task is to install the project's declared dependencies
- **THEN** the install is not denied for want of a matching entry
- **AND** the tasks that depend on it can proceed

#### Scenario: jen would enumerate a project's commands

- **WHEN** jen decides what a session may run
- **THEN** it does not name the project's build, lint, typecheck, or test commands
- **AND** an adopter is not required to name them either for ordinary work to run

### Requirement: A run states the session-tool version its invocation requires

Where the invocation depends on an option that a session tool accepts only from some version
onward, that version SHALL be stated as a requirement on the host that runs the pipeline.

An unrecognized option is refused before the session starts, so the failure SHALL be
understood as arriving in the worst available form: no session, no transcript, and nothing
in the run's output distinguishing it from a stage that was dispatched and did nothing.
Stating the version is what turns that into a prerequisite an operator can satisfy.

#### Scenario: The invocation passes a version-dependent option

- **WHEN** the invocation carries an option not accepted by every version of the session tool
- **THEN** the minimum version that accepts it is stated to the operator

#### Scenario: A host is below the stated version

- **WHEN** the pipeline runs on a host whose session tool is older than the stated version
- **THEN** the requirement is discoverable from the documentation rather than only from a failed run

## MODIFIED Requirements

### Requirement: A run cannot block on a human

A session SHALL be started with no interactive channel to a person, so that it has no
way to put a question to one, and that inability SHALL hold even where a permission rule
would otherwise allow the asking. The stage skills state that they never wait on a human;
this requirement SHALL make it enforced by how the session is started rather than trusted
to the prose.

The enforcement SHALL rest on the session being non-interactive, and SHALL NOT rest on the
permission mode alone: no `--permission-mode` value denies asking, and a requirement written
as though one did invites an enforcement that does not exist.

Where the invocation can also withhold the means of asking — removing the tools that put a
question to a person, rather than leaving them present with nobody to answer — it SHALL do
so. The two are not alternatives: non-interactivity is what makes an answer impossible, and
withholding the tools is what stops a session spending its turns discovering that. A session
that can still call an asking tool will call one, be denied, and may try again; one that
holds no such tool records what it needs and parks the task, which is what the workflow
requires of it.

A run SHALL NOT be left waiting on input that cannot arrive. Where a stage needs a person, it SHALL record what it needs and park the task, which the workflow already requires of it, rather than stalling.

#### Scenario: A stage would ask a question

- **WHEN** a session attempts to ask a person a question
- **THEN** it is denied
- **AND** the run does not wait

#### Scenario: A permission rule would allow asking

- **WHEN** a configuration would otherwise permit the asking
- **THEN** the denial still holds

#### Scenario: The permission level would not prompt

- **WHEN** the session runs under a permission mode that lets tools act without prompting
- **THEN** it still has no channel on which to ask a person a question
- **AND** the denial does not depend on which permission mode was chosen

#### Scenario: The means of asking can be withheld

- **WHEN** the invocation is able to start the session without the tools that ask a person
- **THEN** the session is started without them
- **AND** a stage that needs a person records it and parks the task instead of attempting to ask

### Requirement: The permissions a run is granted are in force

A run SHALL ensure the permissions granted to its working copy actually apply to the session, rather than assuming that writing them into the working copy is enough. Establishing this SHALL be the invocation's responsibility, because nothing inside a repository can grant trust for a working copy that does not exist until the run creates it.

A project's own grants SHALL be honoured. The permissions a project declares for itself — its typecheck, build, lint, and test commands, which cannot be known in advance — SHALL be in force in a dispatched run exactly as they are in an attended one. An arrangement in which only a fixed, jen-supplied set of permissions can ever apply SHALL NOT be used, because it leaves a project unable to grant its runs the commands its own checks require.

This SHALL hold whether or not jen grants anything itself. A run that establishes trust for a working copy carrying no grants from jen is doing the same job it always did: what trust gates is the project's own configuration, and a project that declares nothing today may declare something tomorrow without the invocation changing.

Getting this wrong SHALL be understood as failing late rather than early: the session starts, works, and is denied only when it reaches the first command it believed it was permitted to run, with nobody present to grant it.

#### Scenario: A stage runs a permitted command

- **WHEN** a session runs a command its working copy's configuration grants
- **THEN** it executes
- **AND** no permission is requested from anyone

#### Scenario: A project grants itself a command jen does not ship

- **WHEN** a project has granted a command specific to its own toolchain
- **THEN** a dispatched run may execute that command
- **AND** the grant is in force without jen having known about it

#### Scenario: A working copy has never been used before

- **WHEN** a run's working copy is one nothing has ever run in
- **THEN** its permissions are in force for that run
- **AND** this holds on every run, not only the first

#### Scenario: A working copy carries no grants from jen

- **WHEN** the working copy's configuration names no permissions jen supplied
- **THEN** trust is still established for it
- **AND** a permission the project adds later is in force without the invocation changing
