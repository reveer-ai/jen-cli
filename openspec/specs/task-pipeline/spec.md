# task-pipeline Specification

## Purpose

Defines the pipeline a task travels: the ordered stages, the transition that triggers each one, how a stage hands off, which transitions belong to the user rather than to any stage, what a stage does when there is nobody to confirm with, and how a task is routed backward when a stage finds the previous stage's output unusable.
## Requirements
### Requirement: Refinement precedes the pipeline and ends in `Todo`

`refine-epic` SHALL turn an idea into an epic and its sub-issue tasks, and SHALL leave everything it produces in `Todo`. `Backlog` SHALL hold unrefined placeholders and `Todo` SHALL hold refined tasks ready to design.

Refinement SHALL label what it produces: an epic SHALL carry the `epic` label and a task SHALL carry the `task` label. The labels SHALL be what identifies which of the two an issue is, so that a reader of the tracker alone can tell a task from its parent without inferring it from the issue's shape. Only an issue labelled `task` travels the pipeline; an epic sits in whatever status reflects its children and no stage runs against it.

Promoting a task from `Todo` to `In Design` SHALL be the user's decision. No stage SHALL make that transition.

#### Scenario: An idea is refined

- **WHEN** `refine-epic` finishes breaking an epic down
- **THEN** the epic and its tasks are in `Todo`
- **AND** the epic carries the `epic` label and each task carries the `task` label
- **AND** none of them has been moved into `In Design`

#### Scenario: An epic's status reflects its children

- **WHEN** an epic sits in a stage's status because tasks beneath it are being worked
- **THEN** no stage runs against the epic itself

#### Scenario: An idea is logged without being refined

- **WHEN** an idea is captured that nobody has thought through
- **THEN** it is created in `Backlog`

#### Scenario: A refined task is picked up

- **WHEN** a task in `Todo` is moved to `In Design`
- **THEN** a human made that transition
- **AND** every later transition is a stage's, apart from the promotion out of `Pending`, which is the user's as well

### Requirement: Design confirms with the user when it can, and no stage waits on a reply

`design-task` SHALL confirm with the user before each artifact when confirmation is available to it. When it is not — a run in which asking is denied or impossible — `design-task` SHALL write the artifact set without confirming rather than waiting, and the task's draft PR SHALL be the surface on which that confirmation happens afterward.

`design-task` SHALL determine which of these applies from whether confirmation is actually available to it, and SHALL NOT depend on a flag, an environment variable, or a declared mode to tell it.

No stage SHALL wait on a reply. A stage that needs a human SHALL write what is needed to the task or the PR, move the task to `Pending`, and stop.

#### Scenario: Design runs with a user present

- **WHEN** `design-task` is about to write an artifact and can ask
- **THEN** it confirms with the user first

#### Scenario: Design runs with nobody to ask

- **WHEN** `design-task` is about to write an artifact and confirmation is unavailable
- **THEN** it writes the artifact without confirming
- **AND** the artifact reaches the user through the draft PR rather than through a question

#### Scenario: A stage hits something only a human can decide

- **WHEN** a stage cannot proceed without a human
- **THEN** it records what is needed on the task or as a comment anchored to what it concerns
- **AND** it moves the task to `Pending`
- **AND** the run stops rather than waiting for an answer

#### Scenario: A stage stops early

- **WHEN** a stage stops before finishing its work
- **THEN** the task is in `Pending` rather than in the stage's own status
- **AND** the reason it stopped is readable on the task or the PR

### Requirement: A stage may route a task backward

A stage that finds the previous stage's output unusable SHALL move the task back to the status that owns the fix rather than doing that work itself. Review and testing SHALL route to `In Progress`; implementation SHALL route to `In Design` when there is no usable design to implement.

A stage SHALL NOT route a task backward for a reason the record shows it was already routed back for. Where the task's record shows the same objection has already sent it back once, the stage SHALL move it to `Pending` instead and SHALL say in its comment what sent it back each time. Judging whether two objections are the same one SHALL belong to the stage, which is reading the record anyway and is the only actor in the pipeline capable of the comparison; counting transitions SHALL NOT stand in for it.

#### Scenario: Review finds the implementation wanting

- **WHEN** `review-task` requests changes
- **THEN** the task moves back to `In Progress`
- **AND** the comments backing the verdict are what implementation acts on

#### Scenario: Implementation finds no usable design

- **WHEN** `implement-task` finds the design absent or self-contradictory
- **THEN** the task moves back to `In Design`
- **AND** the blocker is recorded against the artifact it belongs to

#### Scenario: The same objection recurs

- **WHEN** a stage is about to route a task back for something the record shows already sent it back once
- **THEN** it moves the task to `Pending` instead
- **AND** its comment names the objection and each round it sent the task back

#### Scenario: A different objection is found

- **WHEN** a stage routes a task back for something the record does not show it was routed back for before
- **THEN** it routes it backward normally
- **AND** the task is not parked on account of having been routed back previously

### Requirement: A stage either hands off or parks the task at `Pending`

Every stage session SHALL end in one of exactly two ways: it moves the task to the status of the stage it hands off to, or it moves the task to `Pending`. A stage SHALL NOT finish leaving the task in its own status.

`Pending` SHALL mean the task is a human's, and SHALL be where a stage puts anything only a human can settle — a decision the stage cannot make, a blocker it cannot clear, work that has finished and needs a person before it goes on, or a task it judges should stop circling. The comment accompanying the move SHALL say which of those it is, because the status carries only that a human is needed and not why.

No stage SHALL move a task out of `Pending`, and no stage SHALL be started against a task that sits in it. Together with `Todo` → `In Design`, moving a task out of `Pending` SHALL be one of the two transitions that are the user's alone.

A stage status SHALL therefore always mean that a session is working the task or that a session died working it, and SHALL never mean that the task is at rest.

#### Scenario: A stage completes its work

- **WHEN** a stage finishes what it set out to do and the next stage can proceed
- **THEN** it moves the task to that stage's status

#### Scenario: A stage needs a human

- **WHEN** a stage cannot proceed without a person
- **THEN** it moves the task to `Pending` and comments with what is needed
- **AND** the run stops rather than waiting for an answer

#### Scenario: A task rests in `Pending`

- **WHEN** a task's status is `Pending`
- **THEN** no stage is started against it however long it stays there
- **AND** the transition out of it is made by a person

#### Scenario: A task is found in a stage's status

- **WHEN** a task is observed sitting in a stage's status
- **THEN** it means a session is working it or a session died working it
- **AND** it never means the task is finished with that stage

### Requirement: Design ends at `Pending` and promotion is the user's

`design-task` SHALL NOT hand the task to implementation when it finishes. It SHALL move the task to `Pending`, having written its artifacts, opened the draft PR, and commented.

Moving a task from `Pending` to `In Progress` SHALL be the user's decision, because that transition starts implementation and implementation is user-led. Together with `Todo` → `In Design`, this SHALL be one of two transitions no stage makes.

Design SHALL NOT be an exception to how a stage ends. It parks the task at `Pending` for the same reason any stage does — a person is needed next — and its end-of-session comment is what says the artifacts are ready to read rather than that something is wrong.

#### Scenario: Design finishes its artifacts

- **WHEN** `design-task` completes the full artifact set and validates it
- **THEN** it moves the task to `Pending`
- **AND** its comment says the design is complete and awaiting promotion
- **AND** no stage moves it to `In Progress`

#### Scenario: A designed task is promoted

- **WHEN** a task whose design is complete is moved from `Pending` to `In Progress`
- **THEN** a human made that transition

#### Scenario: A design run is interrupted

- **WHEN** a design session is killed before finishing
- **THEN** the task is left in `In Design`, which a finished design run would not have done
- **AND** the absence of the move to `Pending` is what distinguishes the two

### Requirement: Each stage is one skill, triggered by the task's presence in its status

The workflow SHALL define one skill per stage, and the task's presence in that stage's status SHALL be what triggers the skill's work. The stages, their statuses, and their handoffs SHALL be:

| Status | Skill | Hands off |
|---|---|---|
| — | `refine-epic` | tasks land in `Todo` |
| `In Design` | `design-task` | `Pending`; the user promotes |
| `In Progress` | `implement-task` | `In Review`, or `Pending` |
| `In Review` | `review-task` | `In Testing`, or back to `In Progress`, or `Pending` |
| `In Testing` | `test-task` | `In Delivery`, or back to `In Progress`, or `Pending` |
| `In Delivery` | `deliver-task` | `Done`, or `Pending` |

Residence in a stage's status SHALL be a sound trigger because no stage leaves a task in its own status: a stage hands off or parks the task at `Pending`, so a task found in a stage's status has either not been picked up or is being worked. Whoever starts a stage SHALL distinguish those two from the session's own announcement on the task, and SHALL NOT need to read the task's transition history to do it.

No stage SHALL require any trigger beyond that status, and the pipeline SHALL NOT record a task's position in it anywhere other than the task's own status.

#### Scenario: A task is moved into a stage's status

- **WHEN** a task is moved to `In Progress`
- **THEN** its presence in that status is what triggers `implement-task` to do its work
- **AND** no queue, run record, or separate pipeline-position field is consulted

#### Scenario: A task rests in a status it was already moved into

- **WHEN** a task is in `In Design` and a session has already announced itself against it
- **THEN** its presence in that status is not a fresh trigger
- **AND** what establishes that is the announcement on the task rather than the status alone

#### Scenario: A stage completes its work

- **WHEN** a stage that hands off finishes
- **THEN** it moves the task to the status of the stage it hands off to
- **AND** that status is the next stage's trigger

