## MODIFIED Requirements

### Requirement: A stage reads the task's record before it acts

Before doing its work, a stage SHALL read the task's record — its status history, its comments, and its PR with the threads on it.

That record is what tells a stage whether it is resuming an interrupted run, picking up work a later stage routed back and why, what a human has already said about it, and whether the task has been circling the pipeline.

The record SHALL be context and SHALL NOT be a gate. A stage SHALL NOT decline to do its work on account of what it reads there. Whether a task should be worked at all is decided by whoever starts the stage, not by the stage.

#### Scenario: A stage begins work

- **WHEN** any stage starts against a task
- **THEN** it has read the task's status history, comments, and PR threads before producing anything

#### Scenario: The record shows work routed back

- **WHEN** a stage finds the task was moved back to its status by a later stage
- **THEN** it reads why before starting, rather than treating the task as new work

#### Scenario: The record shows a task circling

- **WHEN** a stage finds the task has been routed backward repeatedly
- **THEN** it may say so on the task
- **AND** it still does its work, because stopping the task is not its decision

### Requirement: Pull-request work goes to the git host and task work to the tracker

A stage SHALL act on the pull request through the git host's own client, and on the task through the project-management tracker. Reading the threads on a pull request, anchoring a comment to a line of the diff, replying to a thread, resolving it, recording a review verdict, and merging SHALL all be done against the git host. Status, comments, and artifact attachments SHALL be done against the tracker.

A stage SHALL NOT act on a pull request through the tracker's tooling, even where that tooling exposes the capability. A tracker's view of a pull request is derived from an integration that binds a tracker user to a git-host account, so it is available only to identities that have one. An identity without a linked git-host account, such as one acting as an application, reads that surface as empty every time. The failure is silent — the tooling is offered to every identity regardless, and an empty result is indistinguishable from a pull request with nothing on it — so the division SHALL be held by instruction rather than discovered at runtime.

The issue's suggested branch name is the one value that crosses: it is read from the tracker and used to name the branch, as required by the naming convention.

#### Scenario: A stage reads the threads on a pull request

- **WHEN** a stage needs the review threads on a task's PR and whether each is resolved
- **THEN** it reads them from the git host

#### Scenario: A stage records something on the task

- **WHEN** a stage sets a status, comments, or attaches a finalized artifact
- **THEN** it does so on the tracker

#### Scenario: The pipeline runs under an identity that is not a person's

- **WHEN** a stage acts on a pull request under an identity that has no git-host account linked in the tracker
- **THEN** its reads and writes reach the pull request, because they go to the git host

#### Scenario: A capability is offered on both surfaces

- **WHEN** the tracker's tooling exposes a pull-request operation the git host also offers
- **THEN** the stage uses the git host

## REMOVED Requirements

### Requirement: A stage announces itself on the task before it acts
**Reason**: One of its scenarios describes a dispatcher that no longer exists, and a scenario heading cannot be changed in place. It is replaced by *A stage announces itself on the task before it starts work*, which drops the machine-readable marker, whose only reader was the dispatcher.
**Migration**: A stage still opens with an announcement comment and closes with a comment, and just leaves out the `jen:run` marker.

## ADDED Requirements

### Requirement: A stage announces itself on the task before it starts work

A stage SHALL comment on the task before producing anything, saying which stage is running and that it has picked the task up. It SHALL do so on its own behalf, once its session is actually running, rather than anything writing the announcement in advance on its behalf.

That announcement SHALL be what marks the task as being worked, to a person and to a stage alike. It SHALL be a plain comment. It SHALL carry no machine-readable marker, since nothing parses one. The task's status SHALL NOT be read as evidence that nothing is working it, because the status stays actionable until the stage moves it.

A stage re-entering a task it finds already announced SHALL treat the announcement as a claim rather than as proof, exactly as it treats any other completion marker, and SHALL establish from the evidence what a previous run actually did.

#### Scenario: A stage begins

- **WHEN** a session starts against a task
- **THEN** it comments that the stage has picked the task up before it produces anything

#### Scenario: A task is found already announced

- **WHEN** a task in a stage's status carries an announcement from a session that has not reported an outcome
- **THEN** the task is treated as being worked, or as worked by a session that died
- **AND** a second session is not started against it without first establishing which

#### Scenario: A session dies before announcing itself

- **WHEN** a session ends before it comments
- **THEN** the task carries no evidence it was started
- **AND** it is indistinguishable from a task nothing has run against
