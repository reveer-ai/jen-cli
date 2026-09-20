## Purpose

Defines the environment an agent's sandbox is built from — what the substrate's own image provides, what it pins, what it must never contain, and the sense in which it belongs to the project rather than to the substrate.

## ADDED Requirements

### Requirement: The substrate provides an image carrying its runtime

The substrate SHALL provide a definition of an environment that carries its own entry point, such that a sandbox built from it can become an agent with no further preparation. The entry point SHALL be reachable by name, so that provisioning an agent requires naming the environment and nothing else.

An agent record already names the environment its sandbox is built from, and the substrate supplies no default for that field. This requirement does not introduce one: it makes an environment exist that a record *can* name, without making it the one a record must name.

The image SHALL provide everything a sandbox is required to provide of an environment, so that an agent built from it can be created, can idle, and can have processes started in it.

#### Scenario: An agent runs from the image with no further preparation

- **WHEN** a sandbox is created from the substrate's image and an agent is provisioned into it
- **THEN** the substrate's entry point starts
- **AND** the agent boots, takes a turn, and reports it

#### Scenario: The environment remains the record's choice

- **WHEN** the substrate's sources are examined for a default environment
- **THEN** no default is supplied, and a record that names no environment is refused as before

### Requirement: What the image carries is pinned

Every component the image installs SHALL be pinned to an exact version — the base it is built from, the language runtime it provides, and any program installed into it.

Nothing automated builds or tests this image, so an unpinned component changes what every agent runs with no check reporting it and no change to any file in the repository. The consequence would appear as an agent behaving differently for reasons nothing recorded, which is the hardest class of failure to trace back to its cause.

The language runtime SHALL be at a version that executes the substrate's sources directly, since the substrate's entry point is TypeScript and is not compiled before it is installed.

#### Scenario: Every installed component names an exact version

- **WHEN** the image definition is read
- **THEN** its base and each program it installs name an exact version
- **AND** none of them resolves to whatever is newest at build time

#### Scenario: The runtime's sources execute without a build step

- **WHEN** an agent is provisioned from the image
- **THEN** the substrate's entry point runs from its own sources
- **AND** no compiled output of the substrate is present in the image

### Requirement: Building the image proves its commands run, not that they exist

The build SHALL verify that the substrate's entry point actually executes, and SHALL fail if it does not. Verifying that the command is merely present SHALL NOT satisfy this: a present command that cannot load its own dependencies, or whose sources the language runtime will not execute, is exactly the failure this check exists to catch, and a presence check passes it.

The check SHALL NOT invoke the entry point in a way that waits for input. The entry point reads what it needs from its standard input and takes nothing from its arguments, so a check that starts it without closing its input waits forever — a build that hangs rather than one that fails.

Where the image provides a coding assistant, the build SHALL verify that it runs too, in a way that requires no credential.

#### Scenario: A broken entry point fails the build

- **WHEN** the image is built and the substrate's entry point cannot execute — a missing dependency, or sources the language runtime will not run
- **THEN** the build fails and names it

#### Scenario: The check terminates

- **WHEN** the image is built
- **THEN** the verification of the entry point completes without waiting for input

#### Scenario: An assistant is verified without authenticating

- **WHEN** the image is built and provides a coding assistant
- **THEN** the build confirms the assistant runs
- **AND** no credential is required to do so

### Requirement: The image carries no credential

No credential value SHALL be written into the image, passed to its build, or present in any layer of it. An agent's credentials SHALL continue to reach it only as the sandbox already delivers them — per process, on the process's own standard input.

An image is copied, cached, shared and inspected layer by layer, and a value written into one is recoverable from it long after the build that put it there. This is the same rule the sandbox already holds for a container's configuration, applied one level earlier, and it is where the rule is easiest to break by accident because a build argument does not look like a stored secret.

#### Scenario: No credential is recoverable from the image

- **WHEN** the built image's layers and configuration are inspected
- **THEN** no credential value appears in any of them

#### Scenario: An agent still authenticates

- **WHEN** an agent provisioned from the image runs a program requiring its credentials
- **THEN** the program obtains them from the environment the sandbox established

### Requirement: A pinned assistant is the image's, never the substrate's manifest's

Where the image provides a headless coding assistant, that assistant SHALL be declared by the image definition and SHALL NOT be declared as a dependency of the substrate.

The substrate may not name a particular assistant — an assistant is reached as an ordinary command and nothing in the substrate distinguishes one from another program. A dependency entry in the substrate's own manifest would be the substrate naming one, which is that rule's plain words, and it would make replacing the assistant a change to the substrate rather than a change to an environment.

Keeping it in the image is also what keeps the choice reversible: replacing the assistant, or providing none, SHALL be possible by changing the image alone, with no change to any substrate source.

#### Scenario: The substrate's manifest names no assistant

- **WHEN** the substrate's manifest is read
- **THEN** no coding assistant appears among its dependencies

#### Scenario: Replacing the assistant touches no substrate source

- **WHEN** the assistant the image provides is replaced or removed
- **THEN** no substrate source file changes
- **AND** an agent provisioned from the image still boots and takes a turn

### Requirement: The image is the project's to replace

The image the substrate provides SHALL be a starting point rather than a fixture. A project SHALL be able to extend it or replace it entirely with an environment of its own, and an agent record naming that environment SHALL be provisioned from it without the substrate treating it differently.

Defining the toolchain an agent works with is the project's job. An agent doing Go work needs a Go toolchain and an agent doing data work needs something else, and neither is a question the substrate can answer. The substrate's image is what makes the substrate runnable out of the box, not what makes it opinionated about the work.

#### Scenario: A project's own environment is provisioned identically

- **WHEN** a record names an environment the project defined rather than the substrate's
- **THEN** the sandbox is created from it by the same path
- **AND** nothing in the substrate branches on which environment was named
