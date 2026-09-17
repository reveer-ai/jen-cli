# agent-workspace-tools Specification

## Purpose

Defines the capabilities through which an agent works inside its own sandbox rather than asking the supervisor for anything: reading, listing and writing files under its workspace, and running a command as a child of its own runtime. It covers what each returns, how each fails observably, the single bound on how much a result may carry, the single deadline that guarantees no command can wedge an agent, and the agent-facing guidance that makes these usable without any assistant appearing in the code.

## Requirements

### Requirement: Workspace capabilities are granted by the record and do the work in place

The runtime SHALL offer `fs` and `exec` as capabilities selected from the agent's record exactly as every other capability is, and an agent whose record names neither SHALL be offered neither. Each SHALL be grantable without the other.

Unlike a supervised capability, `fs` and `exec` SHALL perform their work in the runtime process inside the agent's own sandbox and SHALL raise no request to the supervisor. Their invocations and results SHALL be recorded by the runtime's existing dispatch and transcript path, indistinguishable in the log from any other capability's.

Adding them SHALL NOT introduce a capability-specific branch into the dispatcher, the reasoning loop, or the protocol. An agent's registry differs from another's because their records differ, never because their runtimes differ.

#### Scenario: A record grants one and not the other

- **WHEN** a record names `fs` and not `exec`
- **THEN** the agent is offered `fs` alone
- **AND** it can read and write within its workspace and cannot run a command

#### Scenario: A local call is recorded like any other

- **WHEN** an agent invokes `fs` or `exec`
- **THEN** the transcript records the call, its result, its duration, and whether it succeeded
- **AND** no request for it reaches the supervisor

#### Scenario: A record naming neither is valid

- **WHEN** a record names neither `fs` nor `exec`
- **THEN** the agent is constructed successfully and is offered neither

### Requirement: `fs` writes a file's content verbatim and reads within the workspace

The `fs` capability SHALL accept an operation naming one of: list a directory, read a file, write a file. Paths SHALL be interpreted relative to the agent record's workspace, with `.` naming its root.

A write SHALL store the supplied content exactly as given, whatever characters it contains, and SHALL replace the whole file. A write SHALL be atomic with respect to interruption: an interrupted write SHALL leave either the previous content or the new content, never a partial file. `fs` SHALL NOT offer patching, searching, or bulk edits.

`fs` SHALL validate every path at invocation rather than relying on the schema it declares to the model. It SHALL refuse an absolute path, a path escaping the workspace through parent traversal, and a path whose resolution leads outside the workspace through a symbolic link. A write SHALL refuse a target that is an existing symbolic link.

Invalid input, a missing file, and an operating-system error SHALL each be returned as a failed result describing what happened, not raised as an error that ends the agent.

#### Scenario: Content with shell metacharacters survives a write

- **WHEN** an agent writes a file whose content contains quotes, `$`, backticks, and a line that would terminate a shell heredoc
- **THEN** the stored file contains exactly the supplied bytes

#### Scenario: A path leading out of the workspace is refused

- **WHEN** an agent reads or writes a path that is absolute, traverses above the workspace, or resolves through a symbolic link to a location outside it
- **THEN** the call fails with a result naming the reason
- **AND** nothing outside the workspace is read or written

#### Scenario: A missing file is an answer, not a crash

- **WHEN** an agent reads a path that does not exist
- **THEN** the call returns a failed result saying so
- **AND** the agent continues working

#### Scenario: An interrupted write leaves one whole file

- **WHEN** a write is interrupted before it completes
- **THEN** the file holds either its previous content or the new content in full

### Requirement: `exec` runs a command in the agent's container and reports its outcome

The `exec` capability SHALL accept an argument vector, an optional text input for the command's standard input, and an optional working directory interpreted relative to the workspace and defaulting to its root. It SHALL execute the named program directly and SHALL NOT interpose a shell; an agent wanting shell interpretation SHALL pass a shell and its arguments explicitly.

`exec` SHALL supply the given input on the command's standard input and then close it. It SHALL collect the command's standard output and standard error separately and report both, together with the exit code or the signal that ended it.

A nonzero exit, a terminating signal, a failure to start the program, malformed input, a reached output cap, and a reached deadline SHALL each be reported as a failed result carrying whatever output was collected, rather than raised as an error that ends the agent.

The working directory SHALL NOT be treated as a confinement boundary. An agent granted `exec` can execute anything its container can execute, and the container is the boundary.

#### Scenario: A command's streams and exit are reported separately

- **WHEN** an agent runs a command that writes to both streams and exits nonzero
- **THEN** the result carries the two streams distinguishably and the exit code
- **AND** the result is a failure the agent can read and act on

#### Scenario: No shell is interposed

- **WHEN** an agent runs a command whose arguments contain shell metacharacters
- **THEN** those arguments reach the program as written and are not interpreted

#### Scenario: A program that cannot be started is an answer

- **WHEN** an agent runs a program that does not exist in its container
- **THEN** the call returns a failed result naming the failure
- **AND** the agent continues working

#### Scenario: Input is supplied and the stream is closed

- **WHEN** an agent runs a command that reads until end of input
- **THEN** the command receives the supplied text and observes the end of its input

### Requirement: A tool result carries at most one bounded amount, and the agent decides what to keep

`fs` and `exec` SHALL each bound what they return by the same limit. On reaching it they SHALL return the content from its beginning up to that limit, and the result SHALL state plainly that it was cut off. `exec` SHALL additionally terminate the command on reaching the limit.

Neither capability SHALL attempt to select which portion of a result is significant — no retention of a trailing portion, no elision of a middle, no per-command rule. Choosing what matters belongs to the agent, which selected the command and can narrow its output before running it.

The limit SHALL be a constant of the implementation, not a parameter of a call and not a field of a record.

#### Scenario: Output within the limit is untouched

- **WHEN** a command produces output smaller than the limit
- **THEN** the result carries all of it exactly as produced
- **AND** the result does not claim anything was cut off

#### Scenario: Output beyond the limit is cut and declared

- **WHEN** a command produces more output than the limit
- **THEN** the result carries the output from its beginning up to the limit
- **AND** the result states that the output was cut off
- **AND** the command is terminated

#### Scenario: A flooding command cannot exhaust the runtime

- **WHEN** a command emits output without stopping
- **THEN** it is terminated at the limit and the agent receives a failed result

### Requirement: Every command is bounded by a deadline the agent cannot set

`exec` SHALL impose a wall-clock deadline on every command it starts. On expiry it SHALL terminate the command and return a failed result carrying the output collected so far and stating that the deadline was reached.

Termination SHALL end the command's descendants and not only the process directly started, so that a program which starts children of its own leaves none running.

The deadline SHALL be a constant of the implementation. It SHALL NOT be a parameter of a call, a field of a record, or otherwise selectable by the agent, because it is the guarantee that an agent cannot be stuck indefinitely and an agent able to choose it is able to defeat it.

No other mechanism SHALL be required for this guarantee to hold. The runtime is not obliged to cancel a capability in progress, and nothing outside the agent's own container is obliged to notice that a command is running.

#### Scenario: A command that never finishes is ended

- **WHEN** a command runs past the deadline
- **THEN** it is terminated and the agent receives a failed result saying the deadline was reached
- **AND** the agent takes its next step

#### Scenario: A command ignoring a polite signal is still ended

- **WHEN** a command past its deadline does not exit on the first termination signal
- **THEN** it is ended regardless

#### Scenario: Descendants do not survive termination

- **WHEN** a command past its deadline has started child processes of its own
- **THEN** none of them remain running afterwards

### Requirement: An installed coding assistant is reached as an ordinary command

An agent SHALL invoke a headless coding assistant, where its container provides one, by running it through `exec` like any other program. The runtime SHALL NOT carry an assistant-specific capability, request, result field, configuration field, or selection rule, and no part of the substrate SHALL name a particular assistant.

An assistant invoked this way SHALL receive the agent's credentials from the environment the sandbox already established, and no credential value SHALL be written to a file, placed in an argument vector, or stored in a record in order to reach it.

Which assistant to use, whether to use one at all, and how to construct its command SHALL be the agent's judgment. Because the invocation is an ordinary call, the transcript SHALL record the command as given, so what was chosen is recoverable afterwards.

#### Scenario: An assistant runs without the substrate knowing it is one

- **WHEN** an agent runs an installed assistant through `exec`
- **THEN** it is dispatched, bounded and recorded exactly as any other command
- **AND** no component distinguishes it from another program

#### Scenario: The assistant authenticates without a secret being stored

- **WHEN** an assistant requiring credentials is run through `exec`
- **THEN** it obtains them from the environment it inherits
- **AND** no credential value appears in an argument, a file, or a record

#### Scenario: The choice is auditable after the fact

- **WHEN** an agent invokes an assistant
- **THEN** the transcript records the command it ran

### Requirement: The agent is told how to manage what its tools return

The descriptions the model reads for `fs` and `exec` SHALL state their scope, their inputs, the shape of their results, and how each fails.

Because the capabilities deliberately make no judgment about which output matters, those descriptions SHALL additionally tell the agent how to manage output: that what a tool result carries is carried again on every later model call; that output expected to be large should be narrowed before the command is run rather than recovered afterwards, by filtering it or by redirecting it to a file and reading it back; that a result may be cut off at a stated limit; and that the only recovery from a cut-off result is running the command again, which may be expensive or unsafe to repeat.

Where an assistant may be installed, the guidance SHALL describe checking that it is present rather than assuming it, preferring an invocation whose output is already small, and establishing what changed from the workspace itself rather than from any assistant's output format. It SHALL NOT encode a rule about when to use an assistant.

Guidance SHALL be carried in the tool descriptions and in the charter an agent's constructor supplies. It SHALL NOT be a hidden instruction and SHALL NOT substitute for the record, which remains the boundary of what an agent may reach.

#### Scenario: The description covers managing output

- **WHEN** an agent reads the description of `exec`
- **THEN** it is told that results persist into later calls, how to narrow output before running, the limit, and that recovery means re-running

#### Scenario: Guidance does not decide for the agent

- **WHEN** an agent is deciding whether to use an installed assistant
- **THEN** the decision rests with the agent
- **AND** no component routes the work to an assistant on its behalf

#### Scenario: A result cut off is recognisable as such

- **WHEN** a result was cut off at the limit
- **THEN** the agent can tell from the result itself that content is missing
