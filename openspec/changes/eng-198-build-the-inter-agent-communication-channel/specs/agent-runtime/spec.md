## ADDED Requirements

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
