## ADDED Requirements

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

