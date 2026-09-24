## MODIFIED Requirements

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
