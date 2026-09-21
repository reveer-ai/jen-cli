## MODIFIED Requirements

### Requirement: Containers are ephemeral and workspaces outlive them

A sandbox SHALL exist only while its agent is actively working, and creation and destruction SHALL therefore be treated as a hot path rather than a once-per-agent operation. An agent that suspends and resumes many times causes many create/destroy cycles.

The workspace SHALL outlive the sandbox that mounted it. It SHALL be destroyed with the agent, never with a single period of the agent's activity, so that a resumed agent finds its files as it left them.

**A workspace SHALL belong to one agent of one run.** Two runs carrying the same agent record SHALL NOT share a workspace: the agent of the second run SHALL begin with a workspace holding nothing, not the first run's files. An agent's identity is unique within its run and is not claimed to be unique beyond it — two runs of one record carry the same ids by construction, and their stored transcripts are already held apart by the run. A workspace identified by the agent alone therefore contradicts the stored state it accompanies, and the agent begins its first turn among files its own transcript has no account of. That is a wrong answer rather than an error: nothing fails, and the work of one run is read as the work of another.

The identity a workspace is reached by SHALL be stable for the life of its run, so that a run whose supervisor is replaced reaches every workspace it left. Recovery keeps the run's identity, and this requirement SHALL NOT be satisfied by any identity that a recovery would change.

A process started in a sandbox without being told where to run SHALL start in that agent's workspace. The place a process starts and the place that persists SHALL be the same place: an agent writes without naming an absolute path, so a default location outside the workspace would let ordinary work be discarded at the next suspension while every observable sign — the location the process reports, the success of the write — looked correct.

#### Scenario: A workspace survives its sandbox

- **WHEN** a sandbox writes a file to its workspace and is then destroyed
- **AND** a new sandbox is created for the same agent
- **THEN** the file is present in the new sandbox's workspace

#### Scenario: What a process writes where it starts is what survives

- **WHEN** a process is started in a sandbox without being told where to run, and writes a file without naming an absolute path
- **AND** the sandbox is destroyed and a new one is created for the same agent
- **THEN** the file is present in the new sandbox

#### Scenario: A workspace is released with its agent

- **WHEN** an agent's workspace is released
- **THEN** the storage it occupied is reclaimed

#### Scenario: Two runs of the same record do not share a workspace

- **WHEN** an agent of one run writes a file to its workspace
- **AND** a second run is started from the same record, under a different run, and its agent of the same id is provisioned
- **THEN** that agent's workspace holds nothing, and the file is not readable from it
- **AND** the file is still present in the first run's workspace

#### Scenario: A run that is taken over reaches the workspace it left

- **WHEN** an agent has written to its workspace and its run is provisioned again under the same run by a different supervisor
- **THEN** the agent is given the workspace it had, with its files as it left them
