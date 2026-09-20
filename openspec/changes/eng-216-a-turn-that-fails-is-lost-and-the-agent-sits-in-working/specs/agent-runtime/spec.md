## MODIFIED Requirements

### Requirement: The entry point is a peer on the supervisor's channel

The runtime's entry point SHALL converse with the supervisor over its standard input and standard output for the life of the agent's activity, rather than running to completion and printing a result.

It SHALL raise a request when the agent reaches a capability it does not hold, and continue from the answer. It SHALL report the end of a turn on that channel. It SHALL report a suspension on that channel. None of the three SHALL be signalled by the process exiting: an entry point that speaks only by ending can say a thing once, cannot say anything while a turn is in progress, and cannot suspend without destroying the agent it is.

**A turn the runtime cannot complete SHALL end the process, and the reason SHALL be written to standard error before it does.** This is the one thing the entry point says by ending, and it is consistent with the three above rather than an exception to them. Each of those is something the agent carries on after, which is why none can be spoken by exiting. Stopping is the one event for which saying it once, on the way out, is the whole of it — and it is already how a runtime that cannot read its boot input says so.

**The runtime SHALL NOT go on waiting on the channel while holding a failure it has not surfaced.** The supervisor holds a working agent's messages for a turn boundary, so a runtime that records a failure and continues reading has made the one event that would release it conditional on itself: it waits for a frame that waits for a turn report that waits for the frame. A diagnosis that is correct, complete and unsendable is the defect, and a channel that can hold one is what must not exist.

The reason SHALL reach standard error whatever the runtime does to stop reading afterwards. Ending the conversation is itself capable of raising a failure, and one raised there SHALL NOT displace the failure being reported — the account a parent is given would otherwise describe how the process closed its own input rather than why it stopped.

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

#### Scenario: A turn that cannot be completed ends the process

- **WHEN** a turn fails part-way through, and nothing further arrives on the channel
- **THEN** the runtime writes the reason to standard error and the process ends
- **AND** it does so without anything further being sent to it

#### Scenario: The reason reported is the one that stopped the turn

- **WHEN** a turn fails and the runtime stops reading its channel
- **THEN** what standard error carries is the failure that stopped the turn
- **AND** not any failure raised by the act of stopping

#### Scenario: The boot input's remainder is left for the conversation

- **WHEN** the runtime has read its boot input
- **THEN** whatever followed it on the same channel is available to be read as the conversation
- **AND** nothing of it was consumed by reading the boot input
