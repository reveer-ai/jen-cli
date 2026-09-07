# stage-conventions Specification

## Purpose

Fixes the rules every stage obeys and none of them owns — what a stage reads before it acts, how it resumes a run that was killed, how a task's branch and change are named, the single PR that carries it end to end, how a finalized artifact reaches the task, what belongs in a description versus a comment, commit format, thread etiquette, where a stage records what it learned, what it is permitted to run, and the comment every session ends with — so that they are stated once rather than six times.

## Requirements

### Requirement: A stage takes a task as its input

Every stage SHALL act on one task, given directly or inferred from context. A stage that cannot determine which task it is acting on SHALL ask rather than guess.

#### Scenario: The task is not stated

- **WHEN** a stage is invoked without a task and the context does not make one unambiguous
- **THEN** the stage asks which task it is acting on

### Requirement: A stage reads the task's record before it acts

Before doing its work, a stage SHALL read the task's record — its status history, its comments, and its PR with the threads on it.

That record is what tells a stage whether it is resuming an interrupted run, picking up work a later stage routed back and why, what a human has already said about it, and whether the task has been circling the pipeline.

The record SHALL be context and SHALL NOT be a gate. A stage SHALL NOT decline to do its work on account of what it reads there; refusing to dispatch a task belongs to the dispatcher.

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

### Requirement: A stage resumes an interrupted run rather than restarting it

A stage SHALL be re-enterable. A session can be killed at any point, and the task's status is left untouched when it is, so a stage SHALL assume it may be resuming and SHALL establish what a previous run already did before producing more.

A stage SHALL treat a marker that records completion — a checked task, a status command reporting an artifact complete, a file that exists — as a claim rather than as proof, and SHALL check it against the evidence: the commits on the branch, the state of the PR, the threads on it, and the comments on the task. Where a marker and the evidence disagree, the evidence SHALL be what the stage acts on.

This matters because a run is a fresh checkout that is discarded when the run ends. Work that was never committed does not survive the session that produced it, so a marker can outlive the work it claims.

#### Scenario: A stage is re-entered after an interrupted run

- **WHEN** a stage begins against a task already in its own status
- **THEN** it checks for work it has already done before producing more
- **AND** it resumes rather than restarting

#### Scenario: A completion marker has no work behind it

- **WHEN** a stage finds a task marked complete with no commit on the branch implementing it
- **THEN** it treats that work as still to do

#### Scenario: Work exists that no marker records

- **WHEN** a stage finds committed work that the change's own bookkeeping does not reflect
- **THEN** it corrects the bookkeeping rather than redoing the work

### Requirement: The branch and the change name derive from the issue's suggested branch name

A task's git branch SHALL be the issue's project-management-suggested branch name verbatim, so the integration that links branch and PR back to the issue matches it.

The task's OpenSpec change name SHALL be that same string lowercased, with any leading `<username>/` segment stripped. OpenSpec requires a lowercase name, and a slash left in the name nests the change directory a level deeper and breaks every `--change` lookup against it.

#### Scenario: A branch is created for a task

- **WHEN** a stage creates the task's branch
- **THEN** the branch name is exactly the name the issue supplies
- **AND** the branch and any PR on it link back to the issue automatically

#### Scenario: A suggested name carries a username prefix

- **WHEN** the issue supplies `josh/ENG-135-implement-workflow`
- **THEN** the branch is `josh/ENG-135-implement-workflow`
- **AND** the change name is `eng-135-implement-workflow`

#### Scenario: A change is looked up by name

- **WHEN** a stage runs an OpenSpec command against the change
- **THEN** the change resolves at a single directory level under `openspec/changes/`

### Requirement: Pull-request work goes to the git host and task work to the tracker

A stage SHALL act on the pull request through the git host's own client, and on the task through the project-management tracker. Reading the threads on a pull request, anchoring a comment to a line of the diff, replying to a thread, resolving it, recording a review verdict, and merging SHALL all be done against the git host. Status, comments, and artifact attachments SHALL be done against the tracker.

A stage SHALL NOT act on a pull request through the tracker's tooling, even where that tooling exposes the capability. A tracker's view of a pull request is derived from an integration that binds a tracker user to a git-host account, so it is available only to identities that have one; an identity acting as an application has no such account, and its every read of that surface returns empty. The failure is silent — the tooling is offered to every identity regardless, and an empty result is indistinguishable from a pull request with nothing on it — so the division SHALL be held by instruction rather than discovered at runtime.

The issue's suggested branch name is the one value that crosses: it is read from the tracker and used to name the branch, as required by the naming convention.

#### Scenario: A stage reads the threads on a pull request

- **WHEN** a stage needs the review threads on a task's PR and whether each is resolved
- **THEN** it reads them from the git host

#### Scenario: A stage records something on the task

- **WHEN** a stage sets a status, comments, or attaches a finalized artifact
- **THEN** it does so on the tracker

#### Scenario: The pipeline runs under an identity that is not a person's

- **WHEN** a stage acts on a pull request while running as an application rather than as a human user
- **THEN** its reads and writes reach the pull request, because they go to the git host

#### Scenario: A capability is offered on both surfaces

- **WHEN** the tracker's tooling exposes a pull-request operation the git host also offers
- **THEN** the stage uses the git host

### Requirement: One branch and one PR carry a task end to end

Each task SHALL have exactly one branch and exactly one PR. The PR SHALL be opened as a draft during design, holding the OpenSpec artifacts; implementation, review fixes, and testing fixes SHALL land on that same PR; merging it SHALL be the pipeline's last act and what closes the task out.

A stage SHALL update the existing PR and SHALL NOT open a second one for the same task. Opening it, and every subsequent act upon it, SHALL be done with the git host's own client.

#### Scenario: Design produces its first artifact

- **WHEN** the first artifact lands on the branch
- **THEN** a draft PR is opened for the task
- **AND** it contains the OpenSpec artifacts and nothing else

#### Scenario: Implementation begins

- **WHEN** implementation starts on a task whose design is complete
- **THEN** its commits land on the task's existing PR
- **AND** no second PR is opened

#### Scenario: Specs and code are reviewed

- **WHEN** the PR is reviewed
- **THEN** the artifacts and the implementation are visible in the same diff

#### Scenario: The task is delivered

- **WHEN** the task's PR is merged
- **THEN** that merge is what closes the task out

### Requirement: Finalized artifacts are attached to the task

Each artifact SHALL be uploaded to the task as a file attachment once it is finalized, titled with the artifact's name. A draft in progress SHALL NOT be uploaded.

Artifacts SHALL be uploaded one at a time, because the signed upload URL expires within a minute and preparing several up front expires the earliest.

There is no update operation for an attachment. A stage that revises an already-finalized artifact SHALL delete the stale attachment and upload the replacement within the same run, so that exactly one copy of each artifact exists on the task and that copy is current. Once the change is archived the task is the durable record of what shipped, and a stale attachment misrepresents it.

#### Scenario: An artifact is finalized

- **WHEN** a stage finalizes an artifact
- **THEN** the artifact is uploaded to the task as an attachment titled with its name

#### Scenario: Several artifacts are finalized in one run

- **WHEN** more than one artifact is ready to upload
- **THEN** each is prepared and uploaded before the next is prepared

#### Scenario: A finalized artifact is revised

- **WHEN** a stage revises an artifact that was already attached
- **THEN** the stale attachment is deleted and the replacement uploaded in the same run
- **AND** the task carries exactly one copy of that artifact

### Requirement: The issue's description is the humans', and comments carry the narrative

No stage SHALL overwrite a task's description. It holds the original ask, which is what the artifacts answer.

Comments SHALL carry the running narrative of the work — blockers, handoffs, and anything needing a person.

#### Scenario: A stage has something to record on the task

- **WHEN** a stage needs to record a blocker or a handoff
- **THEN** it comments on the issue
- **AND** the description is left as its author wrote it

#### Scenario: An artifact answers the original ask

- **WHEN** the proposal is finalized
- **THEN** it is attached to the task rather than written over the description

### Requirement: Commits lead with the issue identifier and are pushed before handoff

Every commit SHALL begin with the task's issue identifier, as in `ENG-135: add resource loader`.

A stage that writes files SHALL commit and push them before handing off to the next stage.

#### Scenario: A stage commits its work

- **WHEN** a stage commits
- **THEN** the message begins with the issue identifier

#### Scenario: A stage hands off

- **WHEN** a stage moves the task to the next status
- **THEN** everything it wrote is already committed and pushed

### Requirement: A review thread is answered only after its fix is pushed

A stage SHALL push the fix for a review thread before replying to that thread and resolving it. A thread SHALL NOT be resolved against unpushed work, because doing so tells the reviewer something untrue.

#### Scenario: A review comment is addressed

- **WHEN** a stage has written the fix for a thread
- **THEN** the fix is pushed first
- **AND** only then is the thread replied to and resolved

### Requirement: A review verdict is recorded as a host review event, and as a comment when the reviewer authored the PR

A stage that reaches a verdict SHALL record it on the git host as a review event — approval, or changes requested — so that it counts toward the host's own merge gate.

A git host MAY refuse a verdict from the pull request's own author. Before choosing the event, a stage SHALL compare the pull request's author to the identity it is authenticated as. Where the comparison reports the same identity, the stage SHALL record the verdict as a plain review comment stating the verdict in its body. Where it reports different identities, the stage SHALL record the real event.

A host MAY NOT report an authenticated identity for every kind of token it accepts, so the comparison MAY be unanswerable. Where it is, the stage SHALL attempt the real event and, if the host refuses it, SHALL record the verdict as a review comment instead. A refusal of that fallback is a failed run and SHALL NOT be recorded as a verdict.

The determination SHALL be made from the author and the authenticated identity, both of which the host reports, and SHALL NOT be made by interpreting the text of a refusal: a refused self-review and a transport failure are indistinguishable from the message alone. Where the comparison is unanswerable, a refusal SHALL trigger the fallback without being interpreted for its cause.

#### Scenario: The reviewer is not the author

- **WHEN** a stage submits a verdict on a pull request opened by a different identity
- **THEN** the verdict is recorded as a review event of the kind the verdict calls for

#### Scenario: The reviewer is the author

- **WHEN** a stage submits a verdict on a pull request whose author the comparison reports as the identity it is authenticated as
- **THEN** the verdict is recorded as a review comment carrying the verdict in its body
- **AND** the stage does not attempt the event the host would refuse

#### Scenario: The authenticated identity cannot be determined

- **WHEN** a stage submits a verdict while holding a token the host reports no identity for
- **THEN** the stage attempts the review event the verdict calls for
- **AND** records the verdict as a review comment if the host refuses that event
- **AND** does not read the refusal for its cause

#### Scenario: A verdict submission fails

- **WHEN** recording a verdict fails
- **THEN** the stage does not infer the cause from the message
- **AND** the run does not treat the verdict as recorded

### Requirement: A stage records what it learned beside the code it applies to

A convention a change establishes, or a gotcha a future session would otherwise rediscover the hard way, SHALL be written down by the stage that learned it, at the point it learned it, so that it rides in the change's own diff and is reviewed and tested along with everything else.

A stage SHALL write nothing when nothing clears the bar. A note nobody needed is worse than no note.

#### Scenario: A stage establishes a convention

- **WHEN** implementation settles a convention future work will need to follow
- **THEN** the stage records it in the same change, beside the code it applies to

#### Scenario: A stage learns a gotcha late in the pipeline

- **WHEN** testing discovers something expensive that only surfaces when the change is exercised
- **THEN** the stage records it rather than leaving it for the next session to rediscover

#### Scenario: A run turns up nothing worth recording

- **WHEN** a stage finishes and has learned nothing that clears the bar
- **THEN** it writes no note

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

### Requirement: Every session ends with a comment on the task

A stage SHALL comment on the task at the end of every session, whatever the outcome — work finished, work stopped early, or work blocked. A stage SHALL NOT finish silently, including when nothing went wrong.

The comment SHALL carry what the stage did, what it decided, where it stopped and why, and what the next stage is picking up. A comment that records only that the stage ran SHALL NOT satisfy this.

Together with the announcement a stage opens with, this is what makes a session's record on the task complete: an announcement with no closing comment is a session that died, and the task's status — still the stage's own, since a stage that finishes moves it — says the same thing. The closing comment is also the only thing carrying *why* a task was parked at `Pending`, which the status cannot express.

#### Scenario: A stage finishes its work

- **WHEN** a stage completes everything it set out to do
- **THEN** it comments on the task saying so before it exits

#### Scenario: A stage stops early

- **WHEN** a stage stops without finishing
- **THEN** it comments with where it stopped and why
- **AND** the comment is what says why the task is at `Pending`

#### Scenario: A session is killed mid-run

- **WHEN** a session ends without reaching its own end
- **THEN** an announcement exists with no closing comment
- **AND** the task is still in the stage's own status
- **AND** a stage re-entering the task reads that pairing as an interrupted run whose markers are unverified

### Requirement: A stage announces itself on the task before it acts

A stage SHALL comment on the task before producing anything, saying which stage is running and that it has picked the task up. It SHALL do so on its own behalf, once its session is actually running, rather than anything writing the announcement in advance on its behalf.

That announcement SHALL be what marks the task as being worked. The task's status SHALL NOT be read as evidence that nothing is working it, because the status stays actionable until the stage moves it.

A stage re-entering a task it finds already announced SHALL treat the announcement as a claim rather than as proof, exactly as it treats any other completion marker, and SHALL establish from the evidence what a previous run actually did.

#### Scenario: A stage begins

- **WHEN** a session starts against a task
- **THEN** it comments that the stage has picked the task up before it produces anything

#### Scenario: A dispatcher examines a task

- **WHEN** a task in a stage's status carries an announcement from a session that has not reported an outcome
- **THEN** the task is treated as being worked
- **AND** nothing dispatches against it

#### Scenario: A session dies before announcing itself

- **WHEN** a session ends before it comments
- **THEN** the task carries no evidence it was started
- **AND** it is indistinguishable from a task nothing has run against
