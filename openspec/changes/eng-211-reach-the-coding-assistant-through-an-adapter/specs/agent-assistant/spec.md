## ADDED Requirements

### Requirement: A coding assistant is reached through an implementation-independent handle

The substrate SHALL define an adapter whose `start(request)` returns a handle exposing progress, a final result, and a stop operation. The request SHALL describe the work, workspace, and allowed operations without naming a provider's command-line flags, configuration format, event names, or session identifiers. Progress and the result SHALL likewise contain no provider-specific protocol fields.

#### Scenario: A caller observes work through the handle

- **WHEN** a caller starts a coding task
- **THEN** it can consume progress while the task runs
- **AND** it can await one final result and invoke stop while work is in progress

#### Scenario: An implementation can be exchanged

- **WHEN** the Claude Code adapter and the non-Claude test double receive the same request
- **THEN** both satisfy the same handle and result contract
- **AND** the caller contains no branch on which implementation it received

### Requirement: Results distinguish failure and report observed usage

Every settled assistant handle SHALL produce a result that distinguishes success from failure in the result itself. The result SHALL carry a usage object with observed token and cost values where the implementation supplies them; absence of a value SHALL remain distinguishable from zero. A process failure, a reported assistant error, or a missing final result SHALL NOT be reported as success.

#### Scenario: Successful work reports usage

- **WHEN** an assistant completes successfully and its output reports token or cost usage
- **THEN** the result indicates success and carries the observed usage values

#### Scenario: Unsuccessful work is visible

- **WHEN** the assistant process exits without a valid successful final result
- **THEN** the result indicates failure and gives a diagnostic reason
- **AND** the caller does not infer success from a zero process exit alone

### Requirement: The Claude Code adapter runs inside the agent's sandbox

The production adapter SHALL start Claude Code headlessly as a child process in the calling agent's existing sandbox and workspace. It SHALL translate the request's abstract workspace-read, workspace-write, and command-execution grants into Claude Code's permitted tools. It SHALL translate Claude Code's event stream into the neutral progress and result contract. Assistant credentials SHALL be supplied from the sandbox process environment and SHALL NOT be placed in command arguments, the agent record as values, progress, or results.

#### Scenario: Abstract tools become provider grants

- **WHEN** a request grants workspace reading and writing but omits command execution
- **THEN** the Claude Code invocation permits the corresponding file tools and does not permit its command tool
- **AND** no Claude Code tool name appears in the adapter request

#### Scenario: The assistant uses its caller's workspace

- **WHEN** an agent starts coding-assistant work
- **THEN** the assistant process starts in that agent's mounted workspace
- **AND** no second sandbox or workspace is created

#### Scenario: Credential remains out of durable surfaces

- **WHEN** a sandbox delivers an assistant credential and the adapter starts work
- **THEN** the credential value reaches the assistant through its environment
- **AND** the command arguments, record, progress, and result contain no credential value

### Requirement: Stopping active work releases it

An assistant handle's stop operation SHALL be idempotent, terminate active assistant work and its child processes, wait for their exit, end progress, and settle the result as a distinguishable stopped failure. A stop racing with an already settled result SHALL preserve that result.

#### Scenario: Stop releases a live child

- **WHEN** a caller stops an assistant whose process holds an observable resource
- **THEN** the process exits and releases the resource
- **AND** the result reports that work was stopped

#### Scenario: Stop follows completion

- **WHEN** work has already completed and the caller invokes stop twice
- **THEN** both stop calls complete without changing the original result

### Requirement: The assistant is an ordinary record-selected agent capability

The runtime SHALL offer coding-assistant work through its existing capability interface only when the agent's record names `assistant`. The capability SHALL use the adapter handle and return the outcome as a normal capability result. The runtime's reasoning loop and dispatcher SHALL NOT contain an assistant-specific path. An agent at any tree depth SHALL use the same runtime and capability construction path.

#### Scenario: A record grants assistant work

- **WHEN** an agent's record names `assistant`
- **THEN** its model can invoke the assistant through the ordinary capability interface
- **AND** the adapter's success or failure is recorded as that capability invocation's result

#### Scenario: A record withholds assistant work

- **WHEN** an agent's record does not name `assistant`
- **THEN** its model is not offered that capability
- **AND** the agent otherwise uses the same runtime implementation

#### Scenario: The test double exercises the substrate

- **WHEN** an end-to-end substrate test supplies the non-Claude adapter
- **THEN** the agent can complete assistant work through the ordinary capability path
- **AND** no Claude Code process or model call is needed for that assistant work
