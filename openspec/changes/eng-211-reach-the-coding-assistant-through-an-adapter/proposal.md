## Why

The agent runtime has a capability interface but no workspace-local `fs` or `exec` capability, so an agent cannot inspect files, change code, or run a program in its own sandbox. The sandbox driver can start processes for the supervisor, but that operation is not available to the agent's reasoning loop. ENG-194's recursive run needs ordinary local work, including the option to invoke a headless coding assistant already installed in the agent image.

## What Changes

- Add record-selected `fs` and `exec` capabilities for work in the agent's own sandbox and workspace. Their invocations and results go through the runtime's existing capability path and transcript.
- Make coding assistants available as installed command-line programs in a reproducible agent image recipe. Start with Claude Code and Codex; the project-owned Dockerfile remains the source of truth for the image an agent runs.
- Let an agent invoke an installed assistant headlessly through `exec`, using assistant credentials the sandbox already delivers by reference. Assistant selection and command construction belong to the agent, not to a provider-specific runtime adapter.
- Exercise local file work, command execution, and headless assistant invocation in substrate tests, using a stub executable where a real assistant would spend tokens.

## Capabilities

### New Capabilities

- `agent-workspace-tools`: Record-selected `fs` and `exec` operations inside the agent's sandbox, with observable results and failures.
- `agent-assistant-toolchain`: A reproducible agent image recipe containing supported headless assistant CLIs that agents can call through `exec`.

### Modified Capabilities

None. The existing runtime capability interface and sandbox process primitive remain the mechanism these new capabilities use.

## Impact

- New local capability implementations and tests under `agent/`; the runtime's reasoning loop and supervisor routing do not gain assistant-specific paths.
- An agent image recipe and checks for installed assistant commands. Projects continue to choose their image through the agent record and can build their own Dockerfile.
- Existing credential references remain the source of assistant tokens; no token value is persisted in an agent record or passed in command arguments.
- ENG-199's acceptance run can use a stub command for repeatable tests and a real installed assistant for its separate live pass.
