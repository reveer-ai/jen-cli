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

### Requirement: The interface is small and names nothing driver-specific

The sandbox interface SHALL consist of creation — which roots a filesystem for the agent and delivers its secrets — process execution, destruction, and release of the agent's workspace. Rooting a filesystem and injecting secrets are properties of creation rather than operations a caller invokes separately; there is nothing useful a caller could do with a sandbox that had neither.

No type, field, parameter or return value on the interface SHALL name a concept belonging to one driver's implementation. A container identifier, an image reference, a daemon socket, a process identifier, or a host filesystem path SHALL NOT appear on it.

This requirement carries more weight than it would if several drivers existed. A container driver is the only implementation at this stage, so nothing else exercises the interface and nothing else can reveal an assumption that leaked into it. The interface's independence is therefore held by this requirement alone, and it SHALL be checkable by reading the interface's declarations rather than inferred from the implementation's behaviour.

#### Scenario: The interface exposes only what it needs

- **WHEN** the sandbox interface is examined
- **THEN** it declares creation, process execution, destruction, and workspace release, and nothing further

#### Scenario: No driver concept leaks onto the interface

- **WHEN** the sandbox interface's declarations are examined
- **THEN** none of them names a container, an image, a daemon socket, a process identifier, or a host filesystem path

### Requirement: A container driver is the only driver, and the driver set is closed

The substrate SHALL provide exactly one sandbox driver: a container driver, which reaches the container runtime by running its command-line client as a subprocess rather than through a client library.

The available drivers SHALL be a closed set, fixed in the substrate's own source. The substrate SHALL NOT provide a driver registry, SHALL NOT load a driver dynamically, and SHALL NOT accept configuration naming an implementation to load.

A second driver — a sandboxed kernel, a microVM, or an unisolated one serving the substrate's own tests — is expected and is deliberately deferred. It is a change to this capability when a concrete need arrives, written against a container driver whose behaviour has by then been settled in practice. Building it first would mean guessing at the seam it is meant to fit.

#### Scenario: No dynamic driver loading

- **WHEN** the substrate's sources are examined
- **THEN** no code path loads a driver by name from configuration, from the environment, or from the filesystem

#### Scenario: Selection is from the known set

- **WHEN** a driver is selected
- **THEN** it is the driver this capability defines

### Requirement: The container driver isolates the agent from the host and from other agents

The container driver SHALL provision each sandbox as its own container with its own workspace volume.

It SHALL NOT mount any host directory into a sandbox, and SHALL NOT mount the container runtime's socket into a sandbox under any circumstance. The socket prohibition is not one isolation measure among several: mounting it grants trivial host root, which makes every other guarantee here decorative.

Sandboxes SHALL NOT share a workspace. Two sandboxes live at the same time SHALL be unable to read or write each other's workspace, and SHALL be unable to reach the host's filesystem.

#### Scenario: No host directory is mounted

- **WHEN** a sandbox is created
- **THEN** no directory from the host filesystem is mounted into it

#### Scenario: The runtime socket is never mounted

- **WHEN** a sandbox is created
- **THEN** the container runtime's socket is not present inside it

#### Scenario: Two sandboxes cannot see each other

- **WHEN** two sandboxes exist at the same time and one writes a file to its workspace
- **THEN** the other cannot read that file
- **AND** neither can read the host's filesystem

### Requirement: Credentials are delivered by reference and never written to disk

An agent record SHALL carry credentials as references rather than as values, so that the record is inert and safe to persist alongside the project.

The sandbox SHALL resolve each reference and deliver the resulting secret into the sandbox's environment at creation. It SHALL NOT write a secret to any file, inside the sandbox or outside it, and SHALL NOT place a secret on a command line.

Delivering secrets as environment makes their disposal a property of the sandbox's destruction rather than a cleanup step that can be skipped or interrupted. The command-line prohibition is the one that is easy to violate by accident, because the driver reaches the runtime by building command lines: a process's arguments are readable by other processes on the host, so a secret passed that way is disclosed to the whole machine for the life of the call.

#### Scenario: A reference is resolved into the environment

- **WHEN** a sandbox is created from a record carrying a credential reference
- **THEN** the resolved secret is present in the sandbox's environment
- **AND** the reference itself is what the record still holds

#### Scenario: No secret reaches disk or a command line

- **WHEN** a sandbox is created from a record carrying a credential reference
- **THEN** no file written by creation contains the resolved secret
- **AND** no command line assembled by creation contains it

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

### Requirement: Destruction leaves nothing behind, and repetition accumulates nothing

Destroying a sandbox SHALL release every resource it held. After destruction there SHALL be no surviving container, no surviving volume, no surviving process, no leaked file descriptor, and no credential readable anywhere.

Repeated creation and destruction SHALL NOT accumulate resources. The number of cycles exercised SHALL be enough to surface a per-cycle leak — a leak of one resource per cycle is visible within a few dozen — rather than a number chosen for its size.

Leak-freeness matters here in a way it would not for a once-per-run environment: because a sandbox is created and destroyed on every suspension, a resource leaked once is leaked on a schedule.

#### Scenario: A cycle leaves nothing

- **WHEN** a sandbox is created and then destroyed
- **THEN** no container, volume, process, or credential belonging to it remains

#### Scenario: Repetition accumulates nothing

- **WHEN** create/destroy is cycled enough times to surface a per-cycle leak
- **THEN** no containers, volumes, processes, or file descriptors have accumulated

### Requirement: The failure modes are defined rather than incidental

The sandbox SHALL define its behaviour for the failures that arise from its own lifecycle:

- **Creation that fails partway.** Creation SHALL NOT leave a partially provisioned sandbox behind. Whatever was provisioned before the failure SHALL be released, and the failure SHALL be reported to the caller.
- **Destroying something already gone.** Destruction of a sandbox that no longer exists SHALL succeed rather than fail. A sweep and an ordinary teardown can both reach the same sandbox, and a teardown path that fails on an absent target turns cleanup into a source of errors.
- **Destroying something still running.** Destruction of a sandbox whose process is still running SHALL stop it and release its resources rather than waiting for it or refusing.
- **A container runtime that is absent or unreachable.** Creation SHALL fail with an error naming the cause. It SHALL NOT degrade to a less isolated arrangement, now or when a second driver exists. A run that quietly loses its isolation is indistinguishable from one that kept it, which makes silent degradation worse than failure.
- **A record the sandbox cannot use.** A record naming an environment that cannot be provisioned, or a credential that cannot be delivered as named, SHALL fail the creation it belongs to. The failure SHALL NOT be deferred to the processes started later in that sandbox, and an error concerning a credential SHALL name the credential and never its value. Deferring it produces a sandbox that was created successfully and in which nothing can ever run, reported at a place that no longer points back at the record that caused it. A record is data supplied by the caller, so its fields SHALL be treated as values wherever the driver passes them onward, and never as instructions to the thing it passes them to.

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

#### Scenario: An unreachable runtime is an error, not a downgrade

- **WHEN** a sandbox is created and no container runtime is reachable
- **THEN** creation fails with an error naming the cause
- **AND** no less isolated arrangement is substituted

#### Scenario: An unusable record fails creation rather than the processes after it

- **WHEN** a sandbox is created from a record naming an environment that cannot be provisioned, or a credential that cannot be delivered as named
- **THEN** creation fails with an error naming what about the record could not be used
- **AND** no sandbox handle is returned
- **AND** nothing that creation provisioned before the failure survives

### Requirement: Sandboxes have unrestricted network access

A sandbox SHALL have unrestricted network access. No egress restriction, allowlist, or filtering SHALL be implemented, and no operation for configuring one SHALL be added to the interface while there is no policy to configure.

Recorded because it is a security property rather than an omission, and because the condition for changing it is specific: restriction concerns egress, not ingress, since an agent holds credentials. That is acceptable while the substrate runs on its operator's own machine with its operator's own keys, and unacceptable once it executes anyone else's work on shared infrastructure. Adding policy then is a change to this capability, and the interface gains whatever shape that policy actually needs rather than a parameter guessed at in advance.

#### Scenario: Network access is unrestricted

- **WHEN** a sandbox is created
- **THEN** no egress allowlist or filter is applied to it

#### Scenario: No configuration surface is carried for a policy that does not exist

- **WHEN** the sandbox interface is examined
- **THEN** it declares no network configuration operation
