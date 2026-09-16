## ADDED Requirements

### Requirement: Any agent granted spawn can create an agent of the same kind

The supervisor SHALL accept a `spawn` request from an agent with the `spawn` capability and SHALL construct the child as the same `AgentRecord` type used for the agent nobody spawned. It SHALL assign the child's id, set its parent to the caller, and SHALL NOT let the caller supply either field. The resulting record SHALL be persisted outside the sandbox with its parentage before the supervisor answers with the id. No root-specific construction path SHALL exist.

The request SHALL name a non-empty name and charter and MAY name an opening message, a tool list, and a non-empty reasoning-model identifier string. A missing opening message SHALL create a dormant child; a present opening message SHALL enter the child's mailbox and reach its conversation by the ordinary parent-to-child turn path.

The supervisor SHALL refuse a `spawn` request when the caller's record does not grant `spawn`, even if the request arrives on the channel.

#### Scenario: The root spawns a child

- **WHEN** the agent nobody spawned invokes `spawn` with a name and charter
- **THEN** the supervisor creates a child record whose parent is the caller and returns its assigned id
- **AND** the child's record has the same shape as the caller's record

#### Scenario: A spawned agent spawns again

- **WHEN** an agent whose own parent is another agent invokes `spawn`
- **THEN** the supervisor uses the same construction path as for the first generation
- **AND** the new child's parent is that calling agent

#### Scenario: An opening message starts the child

- **WHEN** a spawn request carries an opening message
- **THEN** the supervisor stores it in the child's mailbox and starts the child's first turn through the same path used for later parent messages

#### Scenario: No opening message leaves a valid dormant child

- **WHEN** a spawn request carries no opening message
- **THEN** the child record and parentage are stored and the child is waiting without a running body
- **AND** the id is returned so its parent can address it later

#### Scenario: A raw request cannot bypass the caller's record

- **WHEN** an agent whose record lacks `spawn` raises a `spawn` request on the channel
- **THEN** the supervisor refuses it and creates no child

### Requirement: Spawn inherits references and cannot widen authority

A spawned child's environment, workspace path, and credential references SHALL be copied from its parent. The child's sandbox workspace SHALL remain isolated by the child's own id. The child SHALL inherit its parent's reasoning-model configuration, with only the `model` identifier replaced when the request supplies one. The request SHALL NOT override the `provider`, `baseURL`, or `credential` fields. This model selection SHALL NOT select or configure a coding assistant, which is a separate capability. Neither the request nor the child record SHALL carry a credential value.

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
- **AND** its coding-assistant configuration is not changed by the model choice

#### Scenario: A model override cannot redirect a credential

- **WHEN** a spawn request attempts to provide a model configuration with a different endpoint or credential rather than an identifier string
- **THEN** the supervisor refuses the spawn before creating a child

### Requirement: Spawn returns an id without joining the child's work

The supervisor SHALL answer a valid `spawn` request after the child's record, parent link, and opening message if present are stored and delivery has been initiated. It SHALL NOT wait for the child to finish a turn, report, or complete work. Multiple spawn requests from one agent SHALL be able to create multiple children that are in flight before their parent takes its next model step.

#### Scenario: The child is still working when spawn returns

- **WHEN** a child has begun its opening turn and has not yet reported
- **THEN** the supervisor can return that child's id to its parent
- **AND** the parent is not made to wait for the report

#### Scenario: Fan-out does not join implicitly

- **WHEN** a parent makes four valid spawn requests in immediate succession
- **THEN** each is answered with a distinct durable child id without waiting for any child's report
- **AND** the four children can be in flight before the parent's next model step

### Requirement: An agent may dismiss its direct child's subtree

The supervisor SHALL honor a `stop` request only when the caller's record grants `stop` and the target is a direct child of the caller. It SHALL refuse any other caller or target observably. Stopping a child SHALL dismiss that child and every descendant, ending any live bodies while preserving all their records, transcripts, and workspaces. An agent's report SHALL NOT dismiss it; an agent remains available until stopped.

#### Scenario: Stopping a child dismisses the subtree

- **WHEN** a parent stops a child with descendants
- **THEN** the child and all descendants are dismissed and no body in that subtree remains running
- **AND** their workspaces and transcripts remain available

#### Scenario: A non-child cannot be stopped

- **WHEN** an agent requests `stop` for a sibling or another non-child
- **THEN** the supervisor refuses the request and dismisses nobody

#### Scenario: A caller without stop cannot dismiss its child

- **WHEN** an agent whose record lacks `stop` raises a `stop` request for its direct child
- **THEN** the supervisor refuses it and dismisses nobody

#### Scenario: A report leaves the agent available

- **WHEN** a child reports to its parent and no stop request follows
- **THEN** its record remains available for a later message
