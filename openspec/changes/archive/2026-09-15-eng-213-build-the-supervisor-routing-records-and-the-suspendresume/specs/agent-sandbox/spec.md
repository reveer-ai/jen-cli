## ADDED Requirements

### Requirement: A process's standard input stays open for the life of the process

A process started in a sandbox SHALL be able to receive input for as long as it runs, and its caller SHALL be able to send to it more than once. Standard input SHALL NOT be closed as a consequence of the caller having sent what it had at the moment the process started.

The substrate's only real caller attaches a conversation to a long-running process, and a conversation requires both parties to be able to speak more than once. An input closed after the first thing said permits a caller to deliver a starting instruction and nothing else, which is sufficient only while there is nothing to answer.

This preserves everything the sandbox's credential delivery already establishes rather than relaxing any of it. Credentials SHALL still be delivered to the process on its standard input as it starts; they SHALL still precede anything else sent on that input, and SHALL still arrive ahead of it without the possibility of interleaving; and they SHALL still reach neither a command line nor any file. What changes is only that the input does not end where the credentials and the caller's first message end.

A caller SHALL be able to end the input when it has nothing further to send, and a process SHALL observe that ending as it would observe any input ending.

A failure to send to a process SHALL be reported to the caller. It SHALL NOT be reported as a success, and it SHALL NOT end the process that is doing the sending — the sending process is the supervisor, and one agent's broken channel must not take every other agent's run with it.

#### Scenario: A caller sends to a process more than once

- **WHEN** a process is started in a sandbox and its caller sends to it, and later sends again
- **THEN** the process receives both, in the order they were sent

#### Scenario: Credentials still arrive first and intact

- **WHEN** a process is started with credentials and the caller then sends to it
- **THEN** the process receives its credentials before anything the caller sent
- **AND** nothing the caller sent is interleaved with them

#### Scenario: Credentials still reach neither a command line nor a file

- **WHEN** a process is started with credentials in a sandbox whose input stays open
- **THEN** no command line assembled to start it contains a secret
- **AND** no file written to start it contains one

#### Scenario: A caller with nothing further ends the input

- **WHEN** a caller ends a process's input
- **THEN** the process observes the input as ended

#### Scenario: A send to a process that cannot receive is reported

- **WHEN** a caller sends to a process whose input can no longer be received
- **THEN** the failure is reported to the caller
- **AND** the caller's own process is not ended by it

#### Scenario: A long-running process converses while it runs

- **WHEN** a process that stays running is sent something, replies on its output, and is sent something further
- **THEN** it receives the second message
- **AND** neither its output nor its ending was required to collect the first reply

## MODIFIED Requirements

### Requirement: The interface is small and names nothing driver-specific

The sandbox interface SHALL consist of creation — which roots a filesystem for the agent and delivers its secrets — process execution, destruction, release of the agent's workspace, and release of every sandbox belonging to a run. Rooting a filesystem and injecting secrets are properties of creation rather than operations a caller invokes separately; there is nothing useful a caller could do with a sandbox that had neither.

Releasing a run's sandboxes is the fifth operation and exists because the others cannot express it. Destruction acts on a sandbox the caller is holding, and a caller that has lost its sandboxes — a supervisor that was killed while they were running — has nothing left to destroy them with. The sandboxes are still there, and nothing else can reach them.

That operation SHALL end the sandboxes of a run and SHALL NOT release any workspace. The case it exists for is recovery after a failure, which is exactly when every agent's work is sitting in its workspace waiting to be resumed from. A run-wide release that took workspaces with it would destroy that work at the moment it is least recoverable, and it would do so through a single call that looks like tidying up. This is the same distinction destruction and workspace release already hold apart, at the scale where it is easiest to lose.

No type, field, parameter or return value on the interface SHALL name a concept belonging to one driver's implementation. A container identifier, an image reference, a daemon socket, a process identifier, or a host filesystem path SHALL NOT appear on it. The identifier of a run SHALL NOT appear on it either: a driver is constructed for a run and knows its own, so a caller naming one could name another's.

This requirement carries more weight than it would if several drivers existed. A container driver is the only implementation at this stage, so nothing else exercises the interface and nothing else can reveal an assumption that leaked into it. The interface's independence is therefore held by this requirement alone, and it SHALL be checkable by reading the interface's declarations rather than inferred from the implementation's behaviour.

#### Scenario: The interface exposes only what it needs

- **WHEN** the sandbox interface is examined
- **THEN** it declares creation, process execution, destruction, workspace release, and release of a run's sandboxes, and nothing further

#### Scenario: No driver concept leaks onto the interface

- **WHEN** the sandbox interface's declarations are examined
- **THEN** none of them names a container, an image, a daemon socket, a process identifier, or a host filesystem path

#### Scenario: A run's sandboxes are released without a handle on any of them

- **WHEN** sandboxes are created, every handle to them is discarded, and the run's sandboxes are released
- **THEN** none of those sandboxes is still running

#### Scenario: Releasing a run's sandboxes leaves every workspace intact

- **WHEN** agents have written to their workspaces and the run's sandboxes are released
- **THEN** every workspace still exists with its contents
- **AND** each agent can be provisioned again and find its work

#### Scenario: One run's release does not reach another's

- **WHEN** two runs have sandboxes running and one run's sandboxes are released
- **THEN** the other run's sandboxes are untouched
