# agent-runtime Specification

## Purpose

Defines the process an agent is while it works: the single record that constitutes an agent, the runtime's own reasoning loop over a configurable model provider, the capability surface through which it reaches everything it can do, and construction from a record plus a prior event log such that a resumed agent is indistinguishable to the model from one that was never interrupted.

## Requirements

### Requirement: An agent is one record, declared once

The substrate SHALL define exactly one agent record type. The record used to construct the agent nobody spawned SHALL be the same type an agent supplies when it spawns another; there SHALL NOT be a second type, a variant, or a superset for either case.

A record SHALL be fully serializable and SHALL be inert: it carries credentials as references to be resolved, never as values, so that it is safe to persist alongside the project. A reference SHALL name both the credential and where to resolve it from, and where the record names a credential for a particular use, it SHALL name one the record already carries rather than restating the reference.

One record type is what makes the epic's homogeneity constraint structural rather than asserted. Two types that agree today are a divergence waiting to happen, and the divergence would not be visible at the point it was introduced.

#### Scenario: The root and a spawned agent are constructed from the same type

- **WHEN** a record is constructed for the agent nobody spawned and a record is constructed by an agent spawning another
- **THEN** both are the same type, with the same fields available
- **AND** no field distinguishes which construction produced it beyond the one naming the agent's parent

#### Scenario: The record carries no secret

- **WHEN** a record is serialized
- **THEN** every credential it carries appears as a reference
- **AND** no credential value appears anywhere in the serialized form

#### Scenario: A credential for a named use is one the record carries

- **WHEN** a record names a credential for a particular use
- **THEN** it names an entry among the credentials the record already carries
- **AND** the reference is not restated a second time

### Requirement: The sandbox receives only what it reads

The record supplied to sandbox provisioning SHALL be derived from the one record type rather than declared separately, and SHALL carry only the fields provisioning reads.

`agent-sandbox` requires that the primitive never read, receive, or behave differently according to an agent's parent, its depth, or whether it is the agent nobody spawned. Supplying the whole record would deliver the agent's parent to it and violate that requirement. Deriving rather than redeclaring also means the narrowed form cannot drift from the record: a field renamed on the record SHALL fail to resolve rather than leave two shapes that agree only by coincidence.

#### Scenario: Provisioning is not given the agent's parent

- **WHEN** a sandbox is provisioned for an agent
- **THEN** what provisioning receives carries no indication of the agent's parent, its depth, or whether it was spawned

#### Scenario: The narrowed form cannot diverge from the record

- **WHEN** a field of the agent record is renamed
- **THEN** the narrowed form fails to resolve rather than continuing to name a field that no longer exists

### Requirement: The runtime is identical in every sandbox

Every agent SHALL run the same runtime, whatever its depth and whether or not it was spawned. The runtime SHALL NOT implement spawning, message routing, or sandbox lifecycle, and SHALL NOT hold any authority that a runtime at any other depth lacks.

A runtime that implemented the capabilities its children call would leave the root holding something a spawned agent does not, which ends homogeneity at its first line. There is therefore no construction path, argument, or configuration by which one runtime differs in kind from another.

#### Scenario: The root's runtime holds nothing extra

- **WHEN** the runtime constructed for the agent nobody spawned is compared with one constructed at any depth
- **THEN** they are the same runtime, with the same operations available
- **AND** neither reaches an operation the other cannot

#### Scenario: The runtime cannot provision or route on its own

- **WHEN** the runtime's own operations are examined
- **THEN** none of them creates a sandbox, destroys one, or delivers a message to another agent

### Requirement: The runtime boots from a record and a prior event log

The runtime SHALL be constructed from an agent record together with a prior event log, and SHALL continue from where that log ends. An empty log SHALL be valid and SHALL denote an agent that has not yet run.

Both SHALL arrive together, as a single boot input on the runtime's standard input, and neither SHALL be supplied as a command-line argument. An event log grows without bound, and a single command-line argument is subject to a fixed size limit irrespective of any total; a log therefore cannot be carried that way at all. Carrying the record on the same input keeps the agent's charter out of the host's view of its processes, and makes it impossible for a record and a log to arrive from separate sources and disagree.

The boot input SHALL be delivered on the same channel that carries the sandbox's credential delivery, and SHALL arrive intact after it.

#### Scenario: A fresh agent boots from an empty log

- **WHEN** the runtime is constructed from a record and an empty event log
- **THEN** construction succeeds and the agent begins its first turn

#### Scenario: Neither record nor log is passed as an argument

- **WHEN** the runtime is launched
- **THEN** no command-line argument carries the record or the event log

#### Scenario: The boot input survives credential delivery

- **WHEN** credentials are delivered to the process and the boot input follows them on the same channel
- **THEN** the runtime receives its boot input complete and unmodified

#### Scenario: A malformed boot input fails at construction

- **WHEN** the runtime receives a boot input that is not a well-formed record and log
- **THEN** construction fails with an error naming what could not be read
- **AND** no model call is made

### Requirement: A resumed agent is indistinguishable to the model

A runtime constructed from a record and a prior event log SHALL produce requests byte-identical to those a runtime that ran the same steps without interruption would have produced.

This is the property the whole suspend/resume model rests on, and it is available only because the model holds no state between calls: every step re-sends the entire conversation regardless, so a rebooted process and a live one differ in nothing the model can observe — provided what they send is the same. Byte-identity rather than equivalence is required because providers key prompt caches on prefix content, so a difference of a single character is not cosmetic; it misses cache on every resume.

The projection from event log to what is sent SHALL be deterministic, and SHALL be performed by the runtime on both the uninterrupted and the resumed path. A projection performed by one component while working and another while resuming would make this property depend on two implementations agreeing, which nothing on either side alone can verify.

#### Scenario: Resumed and uninterrupted runs send the same bytes

- **WHEN** a sequence of turns is run in a single runtime, and the same sequence is run in runtimes destroyed and reconstructed from the emitted log at every turn boundary
- **THEN** the requests sent in the two runs are byte-identical, in the same order

#### Scenario: The projection does not vary between runs

- **WHEN** the same event log is projected more than once
- **THEN** the result is byte-identical each time

#### Scenario: One projection serves both paths

- **WHEN** the projection used while working is compared with the projection used while resuming
- **THEN** they are the same

### Requirement: The transcript is an event log carrying what verification needs

The runtime SHALL emit its record of what happened as an ordered log of events rather than as the message array it sends to the provider.

An event log SHALL carry, beyond the content of the conversation, what the message array cannot: when each step occurred, what it cost in tokens, how long each capability invocation took, and whether it succeeded. The transcript is the substrate's only verification surface — a parent that cannot reconstruct what a child did from it has no way to catch a confident lie — and a claim written by an agent is exactly as forgeable as the prose beside it, whereas a record of what the runtime observed is not.

Storing events rather than the provider's own message shapes also keeps the record off the provider side of a seam the substrate expects to move. Where a provider supplies reasoning content whose representation is its own, the log SHALL carry it in a form that can be replayed without being interpreted.

#### Scenario: The log carries what the message array cannot

- **WHEN** a step completes
- **THEN** the log records when it occurred, the tokens it consumed, and for each capability invoked, its duration and whether it succeeded

#### Scenario: Provider-specific reasoning content is replayable

- **WHEN** a provider returns reasoning content in a representation of its own
- **THEN** the log retains it in a form that projection replays without interpreting it

### Requirement: The runtime's reasoning loop is its own

The runtime SHALL conduct its own reasoning loop: it decides when to call the model, dispatches the capabilities the model calls, appends their results, and decides when the exchange is over. It SHALL NOT delegate that control flow to a client library, a framework, or to any program it runs.

A step is one model call together with the results of the capabilities it invoked. A turn is a message from the agent's parent through to the agent's reply. A turn SHALL end when the model produces content with no capability calls outstanding; that content is the agent's message to its parent. There SHALL be no separate completion channel and no status field an agent writes to signal that it has finished.

The distinction matters because a coding assistant is a program the agent runs, not the agent's loop. If the assistant's loop were the agent's, the agent's behaviour would change wholesale with the assistant rather than one of its tools changing. The runtime therefore holds no concept of an assistant at all: an assistant is reached through the ordinary command-running capability, and nothing in the loop, the dispatcher, or the protocol distinguishes it from any other program.

#### Scenario: A turn ends on content with nothing outstanding

- **WHEN** the model returns content and calls no capability
- **THEN** the turn ends and that content is the agent's message to its parent

#### Scenario: A step continues when capabilities are called

- **WHEN** the model calls one or more capabilities
- **THEN** each is dispatched, its result is appended to the log, and the loop takes another step

#### Scenario: The loop is not delegated

- **WHEN** the runtime's use of its model client is examined
- **THEN** it does not use any facility of that client that would run the capability-dispatch loop on its behalf

#### Scenario: Running an assistant is not delegating the loop

- **WHEN** an agent runs a headless coding assistant as a command
- **THEN** the result returns to the same loop as any other capability result
- **AND** the agent decides what to do next

### Requirement: Capabilities are uniform, and the runtime knows only their shape

The runtime SHALL reach everything an agent can do through one capability interface. A capability SHALL declare a name, a description, a schema for its input, and an invocation, and MAY declare a stream of progress.

The runtime SHALL know that shape and nothing about any particular capability. Adding or removing a capability SHALL require no change to the runtime, and a runtime holding no capabilities at all SHALL be valid — an agent that reasons and does nothing else. A capability performed within the sandbox and one forwarded outside it SHALL be indistinguishable to the loop and to the model.

Uniformity is what prevents the runtime from acquiring authority. The moment the runtime contains a branch that knows what spawning means, spawning is something a runtime does, and a root runtime can differ from one below it.

#### Scenario: An empty capability set is valid

- **WHEN** a runtime is constructed with no capabilities
- **THEN** it runs its loop to completion, reasoning and producing a message to its parent

#### Scenario: Adding a capability does not change the runtime

- **WHEN** a capability is added or removed
- **THEN** no change to the runtime is required for it to be offered and invoked

#### Scenario: The loop cannot tell local from forwarded

- **WHEN** the loop dispatches a capability performed inside the sandbox and one forwarded outside it
- **THEN** it dispatches both through the same interface, and nothing in the dispatch distinguishes them

#### Scenario: A capability's failure is a result, not a crash

- **WHEN** a capability invocation fails
- **THEN** the failure is recorded as that invocation's result and the loop takes another step
- **AND** the runtime does not exit

### Requirement: A capability may bound the work it starts

A capability that starts work the runtime cannot otherwise end SHALL bound that work itself and SHALL report reaching the bound as a failed result rather than by raising an error or by never returning.

The runtime SHALL NOT be relied upon to cancel a capability in progress. It passes a signal for a capability that has somewhere to hear about suspension, and that signal is not a guarantee that any invocation will be interrupted. A capability whose work can fail to terminate SHALL therefore carry its own bound, because the loop dispatches capabilities one after another and an invocation that never returns is an agent that never returns.

#### Scenario: An unbounded capability cannot stall the agent

- **WHEN** a capability starts work that does not finish
- **THEN** the capability ends that work at its own bound and returns a failed result
- **AND** the agent takes its next step

#### Scenario: The runtime is not the canceller

- **WHEN** a capability is in progress
- **THEN** nothing in the loop is required to interrupt it for the agent to remain able to proceed

### Requirement: An agent's capabilities are selected by its record

The set of capabilities a runtime offers SHALL be determined by the agent's record, and SHALL NOT be a constant of the runtime.

This is what allows agents running an identical runtime to hold unequal authority: two agents differ in what they can do because their records differ, never because their runtimes do. It is the point at which authority over anything the substrate does not itself contain — a repository above all — is selected per agent rather than inherited.

A capability named by a record that the runtime cannot resolve SHALL fail construction, naming what could not be resolved. Offering an agent fewer capabilities than its record grants, silently, would give it a charter it cannot carry out and no way to discover why.

#### Scenario: Two agents on one runtime hold different capabilities

- **WHEN** two runtimes are constructed from records naming different capabilities
- **THEN** each offers the model exactly what its own record names
- **AND** the two runtimes are otherwise identical

#### Scenario: An unresolvable capability fails construction

- **WHEN** a record names a capability the runtime cannot resolve
- **THEN** construction fails with an error naming that capability
- **AND** the agent does not begin a turn with a reduced set

### Requirement: An interrupted capability call is answered, never replayed

Where a prior event log ends with a capability call whose result was never recorded, the runtime SHALL append a result reporting that the call was interrupted and its outcome is unknown, and SHALL continue from there.

That result SHALL be appended to the event log as an event in its own right, not applied only to what is sent. A parent reading the transcript is then able to see that it happened, and a subsequent resume projects it like any other event rather than deriving it again.

The runtime SHALL NOT re-execute the interrupted call, and SHALL NOT discard the model's decision to make it. Re-execution is unsafe because nothing records whether the call took effect before the interruption, so a call that changes something outside the workspace could take effect twice. Discarding erases a decision the agent made and conceals an effect that may already have landed. What remains is the only account that is both true and acceptable to the provider, which rejects a call left unanswered — so doing nothing is not available.

#### Scenario: An unanswered call is answered on resume

- **WHEN** a runtime is constructed from a log ending in a capability call with no result
- **THEN** a result reporting the interruption is appended to the log
- **AND** the agent continues its turn

#### Scenario: The interrupted call is not re-executed

- **WHEN** a runtime resumes from a log ending in an unanswered capability call
- **THEN** that capability is not invoked on account of that call

#### Scenario: The synthesized result is visible and stable

- **WHEN** the log of a resumed agent is read
- **THEN** the interruption appears as a recorded event
- **AND** a further resume from that log does not add a second one

### Requirement: The runtime is launched by the substrate's own entry point

The runtime SHALL be launched by an entry point the substrate's own manifest declares. It SHALL NOT be reachable as a subcommand of the repository's CLI.

`agent-substrate` forbids any module under the CLI's root from importing one under the substrate's. A subcommand of the CLI would have to reach the runtime to launch it, so the entry point named in this task's original description cannot exist while that requirement stands. The substrate's own entry point is what satisfies both.

#### Scenario: The CLI does not reach the runtime

- **WHEN** the CLI's import graph is examined
- **THEN** no module under it imports a module under the substrate

#### Scenario: The substrate declares its own entry point

- **WHEN** the substrate's manifest is read
- **THEN** it declares the entry point by which the runtime is launched

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

### Requirement: Spawn and stop are ordinary record-selected capabilities

The substrate SHALL declare `spawn` and `stop` through the runtime's existing capability interface. Each SHALL have an agent-facing name, description, and input schema, and SHALL forward its invocation to the supervisor on the ordinary correlated request channel. The reasoning loop SHALL NOT contain a capability-specific path for either one.

The runtime SHALL offer each capability to an agent if and only if its record names that capability. Registering the declaration SHALL NOT grant it to every agent.

#### Scenario: A record grants spawn

- **WHEN** an agent's record names `spawn` among its tools
- **THEN** the model is offered `spawn` through the same interface as any other capability
- **AND** invoking it raises a `spawn` request to the supervisor and returns its answer as a normal capability result

#### Scenario: A record does not grant spawn

- **WHEN** an agent's record does not name `spawn`
- **THEN** the runtime does not offer `spawn` to its model
- **AND** the agent runs the same runtime implementation as one whose record does name it

#### Scenario: A child invokes spawn again

- **WHEN** a spawned agent's record names `spawn` and its model invokes it
- **THEN** the invocation follows the same runtime declaration and supervisor request path used by the agent nobody spawned
- **AND** no root-only runtime path is used

#### Scenario: Stop is a normal capability result

- **WHEN** an agent whose record names `stop` invokes it for a child id
- **THEN** the runtime raises a `stop` request and presents the supervisor's success or refusal to the model as a normal capability result
- **AND** the agent's turn can continue

### Requirement: Send and await are ordinary record-selected capabilities

The substrate SHALL declare `send` and `await` through the runtime's existing capability interface. Each SHALL have an agent-facing name, description, and input schema, and SHALL forward its invocation to the supervisor on the ordinary correlated request channel. The reasoning loop SHALL NOT contain a capability-specific path for either one.

The runtime SHALL offer each capability to an agent if and only if its record names that capability, on the same terms as every other capability. Registering the declaration SHALL NOT grant it.

Declaring a capability the supervisor already routes SHALL be an addition to the runtime's declarations and nothing else. Adding one SHALL NOT require a change to the reasoning loop, to the dispatcher, or to the protocol — the property that keeps a runtime at depth four byte-identical to the one nobody spawned.

#### Scenario: A record grants send

- **WHEN** an agent's record names `send` among its tools
- **THEN** the model is offered `send` through the same interface as any other capability
- **AND** invoking it raises a `send` request to the supervisor and returns its answer as a normal capability result

#### Scenario: A record does not grant await

- **WHEN** an agent's record does not name `await`
- **THEN** the runtime does not offer `await` to its model
- **AND** the agent runs the same runtime implementation as one whose record does name it

#### Scenario: Neither capability has a path of its own

- **WHEN** an agent invokes `send` or `await`
- **THEN** the invocation is dispatched by the same code that dispatches work done inside the sandbox
- **AND** neither the reasoning loop nor the protocol distinguishes it from any other capability

### Requirement: An agent waiting for a message names how long its body is kept

The declaration of `await` SHALL read the agent's instruction about its container out of that agent's own input, and the runtime SHALL carry it on the suspension it reports.

An agent suspending to wait is the one party that knows whether it is about to be woken in seconds or in a day, because it has just decided what it dispatched. Reading the number from the model's own input is the only place it can come from without a constant appearing somewhere no charter can reach.

Where the agent names nothing, the runtime SHALL report the instruction to keep nothing, which is the absence of a request rather than a choice made on the agent's behalf.

#### Scenario: An agent names how long to keep its container

- **WHEN** an agent invokes `await` naming how long its container should be kept
- **THEN** the request the runtime raises carries that instruction

#### Scenario: An agent names nothing

- **WHEN** an agent invokes `await` without naming anything about its container
- **THEN** the request the runtime raises carries the instruction to keep nothing
- **AND** no default is supplied by the runtime or left for the supervisor to supply

### Requirement: A capability's description says what withholding it costs

The agent-facing description of `spawn` SHALL tell a spawning model what a child is unable to do without each capability it may grant, in terms of what that child can still do.

A model choosing a child's tools is making an authority decision with only the description in front of it, and the consequences of withholding are not evenly distributed: an agent that holds no `send` still reports to its parent when its turn ends, because reporting at a turn boundary is not a capability and cannot be withheld. A description that leaves that unsaid invites a parent to believe it has silenced a child it has merely made less talkative, or to grant everything because it cannot tell what any of it costs.

The description SHALL say that an expectation about the shape of an interaction — that a child answer once and stop, say — belongs in that child's charter rather than in its grant.

#### Scenario: A spawning model is told what a grant withholds

- **WHEN** a model reads the description of `spawn`'s tool grant
- **THEN** it is told that a child without `send` still reports when its turn ends
- **AND** it is told that a one-shot interaction is expressed in a charter rather than by withholding a capability
