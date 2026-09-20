## MODIFIED Requirements

### Requirement: The entry point is a peer on the supervisor's channel

The runtime's entry point SHALL converse with the supervisor over its standard input and standard output for the life of the agent's activity, rather than running to completion and printing a result.

It SHALL raise a request when the agent reaches a capability it does not hold, and continue from the answer. It SHALL report the end of a turn on that channel. It SHALL report a suspension on that channel. It SHALL report a turn it could not complete on that channel, carrying what went wrong. None of the four SHALL be signalled by the process exiting: an entry point that speaks only by ending can say a thing once, cannot say anything while a turn is in progress, and cannot suspend without destroying the agent it is.

**The runtime SHALL NOT hold a failure it has not reported.** There SHALL be no state in which the runtime has a diagnosis of its own failure and is still waiting on the channel for something to arrive. Waiting is what the supervisor does not do for an agent it believes is working: it holds that agent's messages for a turn boundary, so a runtime that records a failure and then waits has made the one event that would release it conditional on itself. The failure is reported where it happens, and reporting it is the whole of handling it.

A failure the runtime reports SHALL leave the agent able to take another turn. Reporting is not ending: the conversation and the workspace are intact, and what could not be completed is one turn rather than the agent.

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

#### Scenario: A turn that cannot be completed is reported rather than kept

- **WHEN** a turn fails part-way through, and the agent's supervisor has sent nothing since
- **THEN** the runtime reports the failure on the channel, carrying what went wrong
- **AND** it does so without waiting for anything further to arrive

#### Scenario: A reported failure leaves the agent able to take another turn

- **WHEN** a runtime has reported a turn it could not complete
- **THEN** the process is still running
- **AND** a message sent to it afterwards begins a new turn

#### Scenario: The boot input's remainder is left for the conversation

- **WHEN** the runtime has read its boot input
- **THEN** whatever followed it on the same channel is available to be read as the conversation
- **AND** nothing of it was consumed by reading the boot input
