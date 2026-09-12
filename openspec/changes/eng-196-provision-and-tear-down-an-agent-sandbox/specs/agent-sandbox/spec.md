## ADDED Requirements

### Requirement: A sandbox is provisioned from an agent record and destroyed on demand

The substrate SHALL provide a sandbox primitive that creates an isolated environment for a single agent from that agent's record, and destroys it.

The primitive SHALL be called by the supervisor and SHALL NOT be reachable by an agent. An agent that could provision its own sandbox would hold authority its children lack, which is the homogeneity constraint the substrate is built on.

Creation SHALL take the agent's record and yield a handle through which the sandbox's operations are reached. Destruction SHALL take that handle and release everything the sandbox held.

#### Scenario: A sandbox is created from a record

- **WHEN** the supervisor creates a sandbox from an agent record
- **THEN** an isolated environment exists for that agent
- **AND** a handle to it is returned

#### Scenario: A sandbox is destroyed

- **WHEN** a sandbox's handle is destroyed
- **THEN** the environment no longer exists
- **AND** everything it held is released

### Requirement: The sandbox interface is four operations and names nothing driver-specific

The sandbox interface SHALL consist of exactly four operations: root a filesystem, execute a process, configure network, and inject secrets — alongside creation and destruction.

No type, field, parameter or return value on the interface SHALL name a concept belonging to one driver's implementation. A container identifier, an image reference, a daemon socket, a process identifier, or a temporary directory path SHALL NOT appear on it.

The interface is narrow so that a different isolation mechanism can later be placed behind it without reshaping anything above.

#### Scenario: The interface exposes four operations

- **WHEN** the sandbox interface is examined
- **THEN** it declares exactly the four operations, plus creation and destruction

#### Scenario: No driver concept leaks onto the interface

- **WHEN** the sandbox interface's types are examined
- **THEN** none of them names a container, an image, a daemon socket, a process identifier, or a filesystem path belonging to one driver

### Requirement: Two drivers implement the interface, and both satisfy one conformance suite

The substrate SHALL provide exactly two sandbox drivers: a container driver, which is the only one providing isolation, and an in-process driver, which provides none.

A single conformance suite SHALL define the behaviour every driver must exhibit, and SHALL be executed against both. A case in that suite SHALL run against every driver unless it is declared to require isolation, and the declared isolation-requiring cases SHALL be enumerable — so that the cases a given driver did not run are a stated set rather than an accident of which tests happened to pass.

Two implementations are what hold the interface to being an interface. A single implementation admits assumptions belonging to its mechanism without anything detecting them, and the seam is then fiction at the moment something needs to be placed behind it.

#### Scenario: Both drivers run the shared suite

- **WHEN** the conformance suite is executed
- **THEN** every case not declared to require isolation runs against both drivers
- **AND** both satisfy it

#### Scenario: A case cannot be quietly skipped for one driver

- **WHEN** the conformance suite is executed and the cases each driver ran are compared
- **THEN** the difference between them is exactly the set of cases declared to require isolation

### Requirement: The driver set is closed, and there is no plugin mechanism

The available drivers SHALL be a closed set, fixed in the substrate's own source. The substrate SHALL NOT provide a driver registry, SHALL NOT load a driver dynamically, and SHALL NOT accept configuration naming an implementation to load.

The interface exists so that a different isolation mechanism — a sandboxed kernel, a microVM — can be placed behind it later by a change to this capability. That is a deliberate act with a spec behind it, not an extension point for arbitrary implementations, and building the machinery for the second invites the first to be skipped.

#### Scenario: No dynamic driver loading

- **WHEN** the substrate's sources are examined
- **THEN** no code path loads a driver by name from configuration, from the environment, or from the filesystem

#### Scenario: Selection is from the known set

- **WHEN** a driver is selected
- **THEN** it is one of the drivers this capability defines

### Requirement: The in-process driver is a fixture and is never reachable in a real run

The in-process driver SHALL create no isolation of any kind. Its workspace is an ordinary directory on the host and its processes are ordinary host processes, carrying the privileges of the user running the supervisor.

It exists so that the substrate's own tests and its recursive acceptance run execute with no container runtime present, in milliseconds, on any machine. It is a test fixture wearing the sandbox's shape, never a lightweight alternative and never a fallback.

Driver selection SHALL be explicit. The in-process driver SHALL NOT be the default, and SHALL NOT be selected automatically under any condition — in particular, a container runtime that is absent, unreachable, or failing SHALL cause an error rather than a silent substitution. A run that quietly degrades to no isolation is worse than one that fails, because nothing distinguishes it from a run that was isolated.

#### Scenario: Selection is explicit

- **WHEN** a sandbox is created without a driver being named
- **THEN** the in-process driver is not selected

#### Scenario: An absent container runtime is an error, not a downgrade

- **WHEN** the container driver is selected and no container runtime is reachable
- **THEN** creation fails with an error naming the cause
- **AND** the in-process driver is not substituted

### Requirement: The container driver isolates the agent from the host and from other agents

The container driver SHALL provision each sandbox as its own container with its own workspace volume.

It SHALL NOT mount any host directory into a sandbox, and SHALL NOT mount the container runtime's socket into a sandbox under any circumstance. The socket prohibition is not one isolation measure among several: mounting it grants trivial host root, which makes every other guarantee here decorative.

Sandboxes SHALL NOT share a workspace. Two sandboxes live at the same time SHALL be unable to read or write each other's workspace, and SHALL be unable to reach the host's filesystem.

#### Scenario: No host directory is mounted

- **WHEN** a sandbox is created by the container driver
- **THEN** no directory from the host filesystem is mounted into it

#### Scenario: The runtime socket is never mounted

- **WHEN** a sandbox is created by the container driver
- **THEN** the container runtime's socket is not present inside it

#### Scenario: Two sandboxes cannot see each other

- **WHEN** two sandboxes exist at the same time and one writes a file to its workspace
- **THEN** the other cannot read that file
- **AND** neither can read the host's filesystem

### Requirement: Credentials are delivered by reference and never written to disk

An agent record SHALL carry credentials as references rather than as values, so that the record is inert and safe to persist alongside the project.

The sandbox SHALL resolve each reference and deliver the resulting secret into the sandbox's environment at creation. It SHALL NOT write a secret to any file, inside the sandbox or outside it, and SHALL NOT place a secret on a command line.

Delivering secrets as environment makes their disposal a property of the sandbox's destruction rather than a cleanup step that can be skipped or interrupted.

#### Scenario: A reference is resolved into the environment

- **WHEN** a sandbox is created from a record carrying a credential reference
- **THEN** the resolved secret is present in the sandbox's environment
- **AND** the reference itself is what the record still holds

#### Scenario: No secret reaches disk

- **WHEN** a sandbox is created from a record carrying a credential reference
- **THEN** no file written by creation contains the resolved secret

#### Scenario: Secrets die with the sandbox

- **WHEN** a sandbox holding a resolved credential is destroyed
- **THEN** the secret is no longer present anywhere the sandbox left behind

### Requirement: The sandbox is unaware of hierarchy

The sandbox primitive SHALL be identical for every agent, whatever its depth. It SHALL NOT read, receive, or behave differently according to an agent's parent, its depth, or whether it is the agent nobody spawned.

The caller differs between the root agent and one spawned four levels down. The primitive does not.

#### Scenario: The root's sandbox is provisioned like any other

- **WHEN** a sandbox is created for an agent whose record names no parent
- **THEN** it is created by the same code path, with the same operations available, as one created for an agent at any depth

### Requirement: Containers are ephemeral and workspaces outlive them

A sandbox SHALL exist only while its agent is actively working, and creation and destruction SHALL therefore be treated as a hot path rather than a once-per-agent operation. An agent that suspends and resumes many times causes many create/destroy cycles.

The workspace SHALL outlive the sandbox that mounted it. It SHALL be destroyed with the agent, never with a single period of the agent's activity, so that a resumed agent finds its files as it left them.

#### Scenario: A workspace survives its sandbox

- **WHEN** a sandbox writes a file to its workspace and is then destroyed
- **AND** a new sandbox is created for the same agent
- **THEN** the file is present in the new sandbox's workspace

#### Scenario: A workspace is released with its agent

- **WHEN** an agent's workspace is released
- **THEN** the storage it occupied is reclaimed

### Requirement: Destruction leaves nothing behind, across many cycles

Destroying a sandbox SHALL release every resource it held. After destruction there SHALL be no surviving container, no surviving process, no leaked file descriptor, and no credential readable anywhere.

Repeated creation and destruction SHALL NOT accumulate resources. A large number of cycles SHALL leave the host in the state it started in.

Leak-freeness matters here in a way it would not for a once-per-run environment: because a sandbox is created and destroyed on every suspension, a resource leaked once is leaked on a schedule.

#### Scenario: A cycle leaves nothing

- **WHEN** a sandbox is created and then destroyed
- **THEN** no container, process, or credential belonging to it remains

#### Scenario: Many cycles accumulate nothing

- **WHEN** a large number of create/destroy cycles are run
- **THEN** no containers, volumes, processes, or file descriptors have accumulated

### Requirement: The failure modes are defined rather than incidental

The sandbox SHALL define its behaviour for the three failures that arise from its own lifecycle:

- **Creation that fails partway.** Creation SHALL NOT leave a partially provisioned sandbox behind. Whatever was provisioned before the failure SHALL be released, and the failure SHALL be reported to the caller.
- **Destroying something already gone.** Destruction of a sandbox that no longer exists SHALL succeed rather than fail. The supervisor's sweep and its ordinary teardown can both reach the same sandbox, and a teardown path that fails on an absent target turns cleanup into a source of errors.
- **Destroying something still running.** Destruction of a sandbox whose process is still running SHALL stop it and release its resources rather than waiting for it or refusing.

#### Scenario: A half-created sandbox is cleaned up

- **WHEN** creation fails after provisioning has begun
- **THEN** the failure is reported to the caller
- **AND** nothing provisioned before the failure survives

#### Scenario: Destroying an absent sandbox succeeds

- **WHEN** a sandbox that has already been destroyed is destroyed again
- **THEN** the operation succeeds

#### Scenario: Destroying a running sandbox stops it

- **WHEN** a sandbox whose process is still running is destroyed
- **THEN** the process is stopped
- **AND** its resources are released

### Requirement: Network configuration is an operation, and is unrestricted

Configuring a sandbox's network SHALL be an operation on the interface. No egress restriction, allowlist, or filtering SHALL be implemented at this stage: a sandbox has unrestricted network access.

The operation exists so that a policy can be applied later without reshaping the interface. Maintaining an allowlist is friction on every package install, every git remote, and every model endpoint while the substrate's fundamentals are still being found, and the isolation that matters here is of the filesystem and of credentials.

The condition for revisiting SHALL be recorded rather than left implicit: restriction concerns egress, not ingress, because an agent holds credentials. That risk is acceptable while the substrate runs on its operator's own machine with its operator's own keys, and unacceptable once it executes anyone else's work on shared infrastructure.

#### Scenario: The operation exists

- **WHEN** the sandbox interface is examined
- **THEN** configuring the network is one of its operations

#### Scenario: Network access is unrestricted

- **WHEN** a sandbox is created
- **THEN** no egress allowlist or filter is applied to it
