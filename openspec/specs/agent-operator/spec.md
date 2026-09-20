# agent-operator Specification

## Purpose

Defines the human-facing entry point to a run: how a person starts a tree of agents, how the root's words reach them and theirs reach the root, and what a stalled or failing run looks like from outside it.

## Requirements

### Requirement: One program starts a run and addresses its root

The substrate SHALL provide an entry point by which a person starts a run from a root agent's record and converses with that agent. It SHALL be an executable of the substrate's own, declared alongside the entry point a sandbox runs, and SHALL NOT be a subcommand of any other program.

Until now the substrate has been reachable only from its own tests. A component with no way to run it is one whose behaviour is known only through doubles, and the epic's claims are about what happens when real agents do real work.

The person SHALL address the root and only the root. Reaching any other agent SHALL remain through its parent, as it is for every agent in the tree.

#### Scenario: A run is started from a record

- **WHEN** a person starts the entry point with a root agent's record and an opening message
- **THEN** the run is created, the root is provisioned, and the opening message is delivered to it

#### Scenario: No agent below the root is addressable

- **WHEN** a person attempts to address an agent other than the root
- **THEN** the entry point offers no way to do so

### Requirement: Starting an existing run resumes it rather than restarting it

The entry point SHALL determine whether a run already exists and act accordingly: an absent run SHALL be created from the given record, and an existing one SHALL be recovered from its stored records and transcripts. Which of the two is happening SHALL NOT be something the person has to state.

A run is resumed most often directly after it died, which is the moment a person is least equipped to answer a question about it. An option that says which mode to use is one that can be given wrongly, and given wrongly in the reviving direction it would begin a second run over an existing one's records.

Recovering a run SHALL report what it could not recover and SHALL carry on with the rest, rather than failing wholesale.

#### Scenario: An absent run is created

- **WHEN** the entry point is started against a run that does not exist
- **THEN** the root record is added and the run begins

#### Scenario: An existing run is recovered

- **WHEN** the entry point is started against a run that already exists
- **THEN** every agent is recovered from its stored record and transcript
- **AND** no agent's transcript is restarted or overwritten

#### Scenario: Nothing has to be said about which

- **WHEN** the entry point's inputs are examined
- **THEN** none of them selects between beginning and resuming

### Requirement: The person and the root converse on the one path

A message the person sends SHALL reach the root by the same path a parent's message takes to its child, and SHALL occupy the same position in the root's conversation. A message the root addresses upward SHALL reach the person.

The human is a participant in the message graph rather than an exception to it. A separate channel for the person would make the root structurally different from every other agent, which is the distinction the substrate is arranged to avoid.

#### Scenario: What the person says arrives as a parent's message

- **WHEN** a person sends a message while the root is waiting
- **THEN** the root receives it exactly as a child receives its parent's message

#### Scenario: What the root says upward reaches the person

- **WHEN** the root addresses its parent, or ends a turn
- **THEN** the person is shown what it said

### Requirement: What the person is shown is rendered as any recipient's is

Every message shown to the person SHALL be rendered the way a message delivered to an agent is rendered, carrying its sender's mark and with the same escaping applied to its content.

The path to a person is the one path a message reaches by without being rendered for a recipient. Shown unrendered, a child's report that opens by quoting the substrate's own output is presented to the person as though the substrate had said it — the one forgery every other recipient in the tree is protected from, at the recipient least able to ask the substrate a follow-up question.

#### Scenario: A message names who sent it

- **WHEN** the person is shown a message
- **THEN** it carries the mark of the agent that sent it, or of the substrate where the substrate sent it

#### Scenario: An agent cannot forge the substrate's voice to the person

- **WHEN** an agent's message begins with text shaped like the substrate's own mark
- **THEN** what the person is shown distinguishes it from a message the substrate sent

### Requirement: The person is shown the root's words and reaches the rest by asking

The entry point SHALL show the person what the root says and SHALL NOT stream the output, reasoning, or transcripts of agents below it.

Visibility in this substrate is pull: a transcript is large, a parent reads a child's when the child's prose does not satisfy it, and an interface that pushed every agent's output at a person would reintroduce at the human seam exactly what the design refused everywhere else. What a person wants to know about a descendant, they ask the root, which can read it.

#### Scenario: Only the root's messages are shown

- **WHEN** agents below the root take turns, emit events and report to their parents
- **THEN** none of it is shown to the person except as the root relays it

### Requirement: A run that cannot proceed says so

The entry point SHALL surface to the person the condition in which no agent in the run can make progress, and SHALL surface the substrate's own failures — trouble that no agent can act upon.

It SHALL NOT resolve either. It SHALL NOT wake an agent, send a message of its own, or end one. Breaking a deadlock is a judgment about the work, and the person is who the substrate has for that.

A report of a stalled run SHALL name the agents that are waiting, because one of the shapes this condition takes is a root that has correctly asked the person a question — which the person resolves by answering rather than by intervening.

#### Scenario: A stalled run is reported

- **WHEN** every agent in the run is suspended and nothing is pending that could wake one
- **THEN** the person is told, and told which agents are waiting

#### Scenario: The report changes nothing

- **WHEN** a stalled run is reported
- **THEN** no agent is woken, messaged, or ended on account of it

#### Scenario: The substrate's own trouble reaches the person

- **WHEN** the substrate fails at something no agent can act upon
- **THEN** the person is told, and the run carries on

### Requirement: Ending the entry point ends bodies and keeps every workspace

When the person ends the entry point, it SHALL end the run's sandboxes and SHALL NOT release any workspace.

Ending is not discarding. A run is ended for every reason including the ordinary one, and its agents' work is sitting in their workspaces waiting to be resumed from; a shutdown that took workspaces with it would destroy that work through the action a person takes to stop for the day. Releasing a workspace is irreversible and no part of the substrate does it.

It SHALL do so from the moment the run begins to be provisioned rather than only once the run is under way. Starting boots the root and resuming boots a body for every agent that was working, all of it before a person can address anything — and a start that is taking longer than expected is exactly when a person interrupts. The sandboxes created by then are already the run's, and an interrupt that is not yet listened for leaves every one of them running.

The consequence SHALL be recorded rather than left to be discovered: a run's workspaces outlive the run, and removing them is the person's own act.

#### Scenario: Shutting down leaves the work

- **WHEN** the person ends the entry point
- **THEN** no sandbox of the run is still running
- **AND** every workspace still exists with its contents

#### Scenario: The person interrupts while the run is still starting

- **WHEN** the person interrupts the entry point before its agents have all been provisioned
- **THEN** no sandbox the run had created by then is still running

#### Scenario: The run can be taken up again afterwards

- **WHEN** the entry point is started again against a run that was ended
- **THEN** every agent resumes with the workspace it had
