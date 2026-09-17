## Why

An agent can reason and use supervisor capabilities, but it has no way to ask a coding assistant to work in its sandbox. ENG-194 needs that ability before its recursive acceptance run can exercise real code work; the assistant must remain a tool of the agent rather than take over the agent's reasoning loop.

## What Changes

- Define an assistant-neutral `start(request)` interface whose handle exposes progress, a final result with usage and a distinguishable failure, and a way to stop active work.
- Add a headless Claude Code adapter that translates the neutral request into its command and output protocol, runs inside the agent's sandbox, and passes the supplied assistant credential without persisting it.
- Add a non-Claude test double for substrate tests that need coding work without launching Claude Code or spending model tokens.
- Expose the adapter through the runtime's ordinary record-selected capability surface, leaving the runtime's own reasoning and dispatch loop unchanged.

## Capabilities

### New Capabilities

- `agent-assistant`: Starting, observing, completing, and stopping coding-assistant work through an implementation-independent interface and an ordinary agent capability.

### Modified Capabilities

None.

## Impact

- New adapter code and tests under `agent/`, with a capability declaration and construction at the runtime composition point.
- The existing `cli/exec.ts` Claude Code launcher is reference material; the current task pipeline and published CLI remain separate.
- The sandbox image must have Claude Code available for the real adapter; substrate tests can use the test double without it.
