# stage-execution Specification

## Purpose

Defines how a run request becomes a finished stage session: the isolated working copy each run gets and discards, how the stage and its task are named to the session, what makes the session unable to block on a human and able to run the commands its instructions require, the single identity it acts under, and what is known about the run once it ends — including when it was killed.

## Requirements

### Requirement: A run request becomes exactly one stage session

Execution SHALL consume a run request and start one session for it, running the skill the request names under the role the request names. It SHALL exercise no judgment about what to run: the request SHALL be taken as decided, and execution SHALL NOT re-examine the task's status, re-derive its stage, substitute a different skill, or decline a request on the merits.

Execution SHALL know nothing about what produced the request. The same request SHALL execute identically whether the runner jen ships or a runner it does not produced it, so that a difference between runners cannot become a difference in how a stage runs.

#### Scenario: A run request is executed

- **WHEN** execution receives a run request
- **THEN** exactly one session is started, for the task the request names
- **AND** it runs the skill the request names, under the role the request names

#### Scenario: The request disagrees with the tracker

- **WHEN** a task's status changes between being dispatched and its session starting
- **THEN** the session still runs the skill the request named
- **AND** execution does not re-decide what should have run

#### Scenario: The same request runs under a different runner

- **WHEN** the same run request is executed by a different runner
- **THEN** the session is started the same way, with the same isolation, permissions, and identity

### Requirement: Each run works in a fresh clone at the task's branch, discarded when it ends

Every run SHALL begin by obtaining its own working copy of the repository at the task's branch, and SHALL discard it when the run ends, by success, failure, or termination.

No two runs SHALL share a working copy, and no run SHALL be able to observe or disturb another's. Nothing SHALL be carried between runs in the working copy: what a run means to keep it SHALL push to the git host or write to the tracker, and anything else SHALL be understood to be lost when the run ends.

A run SHALL NOT depend on the working copy having been used before. Every run SHALL be a first run as far as the working copy is concerned, and any state a run needs established SHALL be established by the run itself.

#### Scenario: A run starts

- **WHEN** a session is launched for a task
- **THEN** it works in a clone of the repository checked out at that task's branch
- **AND** that clone was created for this run

#### Scenario: Two runs are in flight at once

- **WHEN** two sessions run at the same time
- **THEN** neither can read or modify the other's working copy

#### Scenario: A run ends

- **WHEN** a run finishes, by any means
- **THEN** its working copy is removed
- **AND** work it did not push or record on the tracker is gone with it

### Requirement: The stage and its task are both named to the session

A session SHALL be told which skill to run, by name, and which task to run it against. Neither SHALL be left to inference.

The skill SHALL be invoked explicitly rather than selected by matching the session's situation against skill descriptions. Selecting a skill from its description is a judgment, and judgment about what to run belongs to the dispatch decision rather than to a session nobody is watching.

Naming the task SHALL be required rather than preferred. A stage takes its task as input and, where it cannot identify one, is required to ask — and a session that cannot block on a human has no such recourse. A session started without its task named would therefore stop correctly and do nothing, consuming a dispatch and presenting, from outside, as a stage failure.

#### Scenario: A session is started

- **WHEN** a session is launched from a run request
- **THEN** the skill it is to run is named to it explicitly
- **AND** the task it is to act on is named to it

#### Scenario: A skill is not selected by inference

- **WHEN** a session begins
- **THEN** the stage it runs is the one the run request named
- **AND** no skill was chosen by matching its description against the session's context

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

### Requirement: A run loads the workflow's context and confirms it reached the tracker

A session SHALL be started with the workflow document, the skills, the assistant configuration, and the tracker tooling available to it. Where the invocation uses a mode that skips discovering these, it SHALL supply each of them explicitly. A session missing them is not a stage — the instructions defining the stage are exactly what would be absent.

A run SHALL establish that the tracker tooling actually connected, rather than inferring it from the session having started. A tracker connection that fails to initialize SHALL NOT be allowed to pass unnoticed: a session that cannot reach the tracker cannot announce itself, and a task with no announcement is dispatched again by the next tick, so this failure feeds directly back into repeated dispatch.

#### Scenario: A session starts

- **WHEN** a stage session begins
- **THEN** the workflow document, the stage's skill, and the tracker tooling are available to it

#### Scenario: The tracker tooling fails to connect

- **WHEN** a session's tracker connection does not initialize
- **THEN** the run establishes that this happened
- **AND** it is reported rather than left to appear as a session that simply did nothing

### Requirement: A run holds exactly one role's credentials and leaves none behind

A run SHALL be given the credentials of the single role its run request names, resolved from its environment at the point of use. It SHALL NOT be given another role's credentials, and a session SHALL NOT be able to obtain one.

No credential SHALL be written to a file the run leaves behind, committed, or recorded on the tracker, and no credential SHALL remain on the host once the run has ended. Where a credential a run requires is absent, the run SHALL fail before starting the session and SHALL name which one is missing, rather than starting work that cannot be completed.

#### Scenario: A session runs

- **WHEN** a session is started for a run request naming a role
- **THEN** it holds that role's credentials
- **AND** it cannot obtain the credentials of any other role

#### Scenario: A required credential is missing

- **WHEN** a run is to be started without a credential its role requires
- **THEN** no session is started
- **AND** the missing credential is named

#### Scenario: The host is inspected after a run

- **WHEN** a run has ended
- **THEN** no credential it used remains on the host

### Requirement: A run reaches a model under exactly one of two credentials

A run SHALL reach a model through either of two credentials — an API key, or a subscription token — each supplied to the runner as an environment variable under its own name. A run SHALL hold exactly one of them.

Both forms SHALL be accepted on equal terms. Neither SHALL be the default and neither SHALL be the fallback: they differ in what they cost the adopter rather than in what they enable, and the choice is the adopter's to make knowingly.

Where neither credential is set, the run SHALL fail before starting a session and SHALL name both accepted credentials. Naming only one would direct an operator toward the form they had chosen not to use, and this is the same refusal the run already makes for every other credential it reads: before a session starts, naming what is absent, rather than partway through work that cannot be completed.

Where both credentials are set, the run SHALL fail before starting a session, and SHALL NOT resolve the ambiguity by precedence. Which credential a run spends is not a detail a pipeline may settle on an operator's behalf: one form bills a key and the other consumes a usage window shared with the adopter's own work, so choosing silently is wrong in both directions and is wrong invisibly. The refusal SHALL state that exactly one is to be held, because — unlike an absent credential — the name alone does not say what to do about it.

A credential set to an empty value SHALL be treated as not set, under either name. A secret that a hosted runner was never given expands to an empty value rather than being absent, so a managed workflow can pass both names through unconditionally and an adopter who supplied one is not told they supplied two.

The session SHALL be given the credential the run holds, under that credential's own name. The name the run does not hold SHALL NOT be present in the session's environment, whether or not the runner's own environment carried it — a session that could see both would leave the choice to be made downstream, which is the ambiguity the refusal above exists to prevent.

#### Scenario: A run holds a subscription token

- **WHEN** a session is started for a run whose environment supplies a subscription token
- **THEN** the session receives it under the subscription token's own name
- **AND** the API key's name is absent from the session's environment

#### Scenario: A run holds an API key

- **WHEN** a session is started for a run whose environment supplies an API key
- **THEN** the session receives it under the API key's own name
- **AND** the subscription token's name is absent from the session's environment

#### Scenario: Neither credential is set

- **WHEN** a run is to be started with no model credential in its environment
- **THEN** no session is started
- **AND** both accepted credentials are named

#### Scenario: Both credentials are set

- **WHEN** a run is to be started with both model credentials in its environment
- **THEN** no session is started
- **AND** neither is chosen over the other
- **AND** the refusal states that the run is to hold exactly one

#### Scenario: A credential is present but empty

- **WHEN** a run's environment carries one model credential and the other as an empty value
- **THEN** the empty one is treated as not set
- **AND** the run holds the one that carries a value

### Requirement: A session inherits the runner's environment, and a variable can be withheld from every stage but one

A session SHALL be given the environment the runner holds, less what jen reserves to itself. A project's own checks read configuration jen cannot enumerate — the database a suite connects to, the endpoint an integration test reaches for — and the same reasoning that requires a project's own permission grants to be in force requires the variables those commands read to arrive with them. This SHALL be understood as an intended mechanism rather than as a consequence of how a session happens to be started.

Variables in jen's own namespace SHALL NOT reach a session. That namespace is jen's to define, which is what makes withholding it by prefix exhaustive rather than a guess at what a name might mean: the set is closed and has no unnamed member to miss. The credentials of every role are within it, so the requirement that a run hold exactly one role's credentials and that a session be unable to obtain another's continues to be met by this, and is neither relaxed nor restated by it.

The inherited set SHALL NOT be inverted into an allow list of the variables jen can name. No such list is ever complete for an arbitrary project's toolchain, and every name omitted from one would surface as a stage failing at the first command that needed it — mid-run, with nobody present, presenting as a broken stage rather than as a list jen got wrong. That is the late failure this capability already warns about for permissions, and the default SHALL NOT be arranged so as to manufacture it.

An operator SHALL be able to declare that a named variable reaches one stage and no other. The declaration SHALL name variables rather than carry their values, so that a project's variables reach its commands under the project's own names and a secret is written down in one place rather than two. A variable no declaration names SHALL reach every stage, and an operator who declares nothing SHALL observe the environment their sessions receive today.

The restriction SHALL key on the stage rather than on the role. Reviewing, testing, and delivering all act under one role, so a role-keyed restriction would hand a variable meant for the stage that tests to the stage that merges — which is the arrangement this requirement exists to make expressible.

A declaration that withholds nothing SHALL be reported and SHALL NOT fail the run. A declaration naming a stage that does not exist, and a declaration naming a variable that is not set, both leave every stage holding exactly what it would have held anyway; the variables such a declaration named SHALL be inherited as though it had not been written, and the run SHALL say what it found so that the operator learns their declaration had no effect. Stopping a pipeline over a declaration that changed nothing SHALL NOT be done.

#### Scenario: A stage runs a command that needs the project's own configuration

- **WHEN** an operator has set a variable on the runner and a session runs a command that reads it
- **THEN** the variable is present in the session's environment under its own name

#### Scenario: jen's own namespace does not reach a session

- **WHEN** a session's environment is examined
- **THEN** no variable in jen's own namespace is present
- **AND** this holds for every variable in it, not only those carrying a role's credentials

#### Scenario: A variable is restricted to one stage

- **WHEN** an operator declares a variable restricted to a single stage
- **THEN** that stage's session receives it
- **AND** no other stage's session receives it

#### Scenario: The restricted stage shares its role with another

- **WHEN** the stage a variable is restricted to acts under the same role as another stage
- **THEN** the other stage still does not receive it
- **AND** sharing the role does not qualify a stage for it

#### Scenario: Nothing is declared

- **WHEN** an operator has declared no restriction
- **THEN** every variable the runner holds, less jen's own namespace, reaches every stage

#### Scenario: A declaration names a stage that does not exist

- **WHEN** a declaration names something that is not one of the pipeline's stages
- **THEN** the run reports it, naming what was written and what would have been valid
- **AND** the variables it named are inherited as though it had not been written
- **AND** the run is not failed by it

#### Scenario: A declaration names a variable that is not set

- **WHEN** a declaration restricts a variable the runner does not hold
- **THEN** the run reports it
- **AND** the run is not failed by it

### Requirement: A run's outcome is established from what the session reported

A run SHALL capture, for each session, whether it succeeded, what it cost, and a record of what it did, and SHALL make these available to whatever records runs.

Success SHALL NOT be concluded from the session's exit status alone. A failure occurring inside a session — an authentication failure being the plain case — is reported in the session's own structured result, and a run that consulted only the exit status could therefore treat a session that did nothing as one that succeeded. The run SHALL treat the session's reported result as authoritative and the exit status as corroboration, so that a failure signalled by either is a failure.

#### Scenario: A session succeeds

- **WHEN** a session completes its stage
- **THEN** the run records that it succeeded, what it cost, and a record of what it did

#### Scenario: A session fails inside itself

- **WHEN** a session fails in a way reported in its result rather than by its exit status
- **THEN** the run records it as a failure

#### Scenario: A session fails by exiting non-zero

- **WHEN** a session exits non-zero
- **THEN** the run records it as a failure

### Requirement: A terminated run leaves the task as the session left it

Termination SHALL be treated as ordinary operation rather than as a crash. A stopping runner and a cancelled job driving one both terminate their sessions, so a run SHALL expect this and SHALL handle it deterministically.

On termination a run SHALL let the session stop, SHALL discard its working copy and any state it established for it, and SHALL write nothing to the tracker on the session's behalf. The task SHALL be left carrying the announcement its session wrote and no closing outcome, which is what every later tick reads as a session still working it, and it SHALL remain undispatched until a person moves it.

Closing the announcement for a session that did not close it SHALL NOT be done. A task that can be dispatched again after its session died is a task a deterministically failing stage can be dispatched against repeatedly, and the non-expiring announcement exists precisely so such a stage fails once instead of every tick. It would also place a tracker write outside a stage session, which the dispatch capability prohibits.

#### Scenario: A run is terminated

- **WHEN** a run receives a termination signal
- **THEN** its session stops, its working copy is discarded, and nothing is written to the tracker for it

#### Scenario: The task after a terminated run

- **WHEN** a tick later examines a task whose session was terminated
- **THEN** it reads the task as still being worked
- **AND** dispatches nothing for it until a person moves it

#### Scenario: A scheduled job is cancelled

- **WHEN** the job driving a run is cancelled
- **THEN** the run terminates in this same way
- **AND** leaves no partially cleaned working copy or credential behind

### Requirement: A session's transcript is kept only where the operator asks for it

A run SHALL discard the session's transcript with the rest of the run's working state unless the operator has named a place to keep it. Where one is named, the run SHALL write that session's transcript there and the run's record SHALL name the file.

Keeping one SHALL be the operator's decision rather than jen's default. A transcript is the session's entire stream — the repository's content, every tool result, and whatever the stage read along the way — so a durable copy of it is a disclosure, and jen SHALL NOT make one on an operator's behalf.

Where a transcript is kept, it SHALL be written outside the run's own working directory, which is removed when the run ends. It SHALL NOT be written into the project's checkout, which is discarded, and SHALL NOT be committed or pushed by the run.

A failure to write a transcript SHALL NOT change the session's outcome. It SHALL be reported alongside the run's other failures rather than raised over them, on the same terms as a failed cleanup: the session's own result is what the report exists to carry.

#### Scenario: No location was named

- **WHEN** a run finishes and the operator named no place to keep transcripts
- **THEN** the transcript goes with the run's working state
- **AND** the run's record says no transcript was kept

#### Scenario: A location was named

- **WHEN** a run finishes and the operator named a directory for transcripts
- **THEN** the session's transcript is written there
- **AND** the run's record names the file it was written to

#### Scenario: The transcript outlives the run

- **WHEN** a kept transcript is looked for after the run has ended
- **THEN** it is still there
- **AND** the run's own working directory, with the credentials it held, is gone

#### Scenario: A transcript cannot be written

- **WHEN** the named location cannot be written to
- **THEN** the failure is reported with the run's other failures
- **AND** it does not turn a successful session into a failed one

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
