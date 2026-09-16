## ADDED Requirements

### Requirement: The entry point is a peer on the supervisor's channel

The runtime's entry point SHALL converse with the supervisor over its standard input and standard output for the life of the agent's activity, rather than running to completion and printing a result.

It SHALL raise a request when the agent reaches a capability it does not hold, and continue from the answer. It SHALL report the end of a turn on that channel. It SHALL report a suspension on that channel. None of the three SHALL be signalled by the process exiting: an entry point that speaks only by ending can say a thing once, cannot say anything while a turn is in progress, and cannot suspend without destroying the agent it is.

The channel SHALL be the one that remains after the boot input, and the runtime SHALL NOT consume past its boot input's terminator.

This replaces the entry point's former behaviour of running a single turn and writing the resulting message and event log as it exited. That shape was sufficient while nothing existed to converse with, and it is not extensible to one that does.

#### Scenario: A capability the agent does not hold is reached by asking

- **WHEN** the model calls a capability whose work is not done inside the sandbox
- **THEN** the runtime raises a request on the channel and waits
- **AND** it continues from the answer as it would from any other capability's result

#### Scenario: A turn ends without the process ending

- **WHEN** a turn ends
- **THEN** the runtime reports it on the channel
- **AND** the process is still running and able to take another turn

#### Scenario: The boot input's remainder is left for the conversation

- **WHEN** the runtime has read its boot input
- **THEN** whatever followed it on the same channel is available to be read as the conversation
- **AND** nothing of it was consumed by reading the boot input

### Requirement: Events are emitted as they occur

The runtime SHALL emit each event as it is appended to the transcript, rather than emitting the transcript when the agent stops.

An agent's container may end at any moment, including by a failure nothing anticipated, and the transcript is what a resumed agent continues from. A transcript emitted at the end is lost in exactly the case it exists for; one emitted as it grows leaves the agent resumable from wherever it actually reached.

The events emitted SHALL be the same events, in the same order, that the transcript would have carried had it been emitted whole. Emission is when the record leaves the runtime, not what the record is.

#### Scenario: Events leave the runtime as they happen

- **WHEN** an agent takes a step
- **THEN** the events for that step are emitted before the next step begins

#### Scenario: An agent killed mid-turn has emitted what it did

- **WHEN** an agent produces several steps and its process is killed abruptly
- **THEN** the events for the completed steps were already emitted

#### Scenario: Incremental emission carries the same log

- **WHEN** the events emitted across an agent's activity are collected in order
- **THEN** they are the transcript that activity produced, in the order it produced them

### Requirement: A suspension carries the agent's own instruction about its body

Where the runtime reports a suspension, it SHALL carry the suspending agent's own instruction about how long its container is to be kept before being torn down.

Where the agent expressed no such instruction, the runtime SHALL report the instruction to keep nothing. That value is the runtime's expression of a request the agent did not make, and it SHALL NOT be left for the supervisor to supply — a default chosen there would be the supervisor holding a policy about an agent's body, which is the agent's to hold.

#### Scenario: An expressed instruction is carried

- **WHEN** an agent suspends having expressed how long its container should be kept
- **THEN** the suspension the runtime reports carries that instruction

#### Scenario: An unexpressed instruction is reported as keeping nothing

- **WHEN** an agent suspends without expressing anything about its container
- **THEN** the suspension the runtime reports carries the instruction to keep nothing
