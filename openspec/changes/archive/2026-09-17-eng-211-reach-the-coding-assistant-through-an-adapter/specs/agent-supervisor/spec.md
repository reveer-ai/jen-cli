## MODIFIED Requirements

### Requirement: Spawn inherits references and cannot widen authority

A spawned child's environment, workspace path, and credential references SHALL be copied from its parent. The child's sandbox workspace SHALL remain isolated by the child's own id. The child SHALL inherit its parent's reasoning-model configuration, with only the `model` identifier replaced when the request supplies one. The request SHALL NOT override the `provider`, `baseURL`, or `credential` fields. Neither the request nor the child record SHALL carry a credential value.

Selecting the child's reasoning model SHALL have no bearing on what programs the child can run. A child reaches a coding assistant, where its environment provides one, only by holding the capability to run commands; there is no separate assistant configuration on a record for a spawn to inherit, override, or leave alone.

The child's tools SHALL be exactly the requested list if present, or an empty list if omitted. Every requested tool MUST already appear in the parent's tools. A malformed list, a duplicate name, a tool absent from the parent, or a malformed or empty model identifier SHALL cause an observable refusal before any child record, parent link, or sandbox is created. The supervisor SHALL NOT silently drop a requested tool or grant a tool the parent lacked.

#### Scenario: A parent grants a narrower child tool set

- **WHEN** a parent requests a child whose tools are a subset of its own
- **THEN** the child record contains exactly that requested subset
- **AND** the child's credentials remain references inherited from the parent

#### Scenario: An omitted tool list grants none

- **WHEN** a spawn request does not name tools
- **THEN** the child record has no tools
- **AND** the child does not gain `spawn` merely because its parent had it

#### Scenario: A requested tool would widen authority

- **WHEN** an agent requests a child tool it does not itself have
- **THEN** the supervisor refuses the spawn with a failed capability result naming the tool
- **AND** no child record, parent link, or sandbox is created

#### Scenario: The child chooses a model at its parent's endpoint

- **WHEN** a spawn request names a non-empty model identifier
- **THEN** the child record uses that identifier for its reasoning model
- **AND** its provider, endpoint, and credential reference remain the parent's

#### Scenario: A model override cannot redirect a credential

- **WHEN** a spawn request attempts to provide a model configuration with a different endpoint or credential rather than an identifier string
- **THEN** the supervisor refuses the spawn before creating a child

#### Scenario: Reaching an assistant is a tool grant, not a model choice

- **WHEN** a parent that can run commands spawns a child without granting that capability
- **THEN** the child cannot run an installed coding assistant
- **AND** the model identifier the request named has no bearing on that
