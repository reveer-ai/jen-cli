## MODIFIED Requirements

### Requirement: The failure modes are defined rather than incidental

The sandbox SHALL define its behaviour for the failures that arise from its own lifecycle:

- **Creation that fails partway.** Creation SHALL NOT leave a partially provisioned sandbox behind. Whatever was provisioned before the failure SHALL be released, and the failure SHALL be reported to the caller.
- **Destroying something already gone, or already going.** Destruction of a sandbox that no longer exists SHALL succeed rather than fail, and so SHALL destruction of one whose removal is already under way. A sweep and an ordinary teardown can both reach the same sandbox, and a teardown path that fails on an absent target turns cleanup into a source of errors. A removal in progress is the same fact observed a moment earlier, and a driver that tolerates only the completed one holds the property everywhere except the window it exists for — which is where a caller with nothing to distinguish the two reports a failure over a sandbox that is already going away.
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

#### Scenario: Destroying a sandbox whose removal is under way succeeds

- **WHEN** a sandbox is destroyed while a removal of it is already in progress
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
