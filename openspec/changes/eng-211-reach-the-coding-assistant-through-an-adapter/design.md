## Context

`agent/runtime` owns the reasoning loop and dispatches every tool call through `Capability`. `runtime/main.ts` currently composes only supervisor-backed capabilities. The sandbox starts that runtime with the record's credential references resolved into its process environment; the agent record and transcript persist without credential values. `cli/exec.ts` demonstrates the Claude Code flags and JSON event stream, but belongs to the separate current pipeline and is not imported by `agent/`.

ENG-211 adds coding work as one capability. The adapter contract must be useful to another assistant implementation, and the substrate's test double must prove it without a Claude Code executable. The adapter operates in the same sandbox and workspace as its caller.

## Goals / Non-Goals

**Goals:**

- An assistant-neutral request, progress stream, result with usage and explicit success or failure, and idempotent stop.
- A Claude Code process adapter and a deterministic non-Claude adapter used by substrate tests.
- A record-selected `assistant` capability composed at runtime boot, with no branch in the reasoning loop or dispatcher.
- Credential values only in the process environment; no value in the record, argv, adapter result, or transcript.

**Non-Goals:**

- Replacing `cli/exec.ts`, adding a second sandbox, or changing supervisor routing.
- A spend ceiling, assistant session resume protocol, or a second long-running agent loop inside the assistant.
- Arbitrary remote MCP servers or an adapter registry. The first request tool set is the abstract workspace operations the coding task needs.

## Decisions

### 1. Keep the assistant handle separate from the agent capability

Define `AssistantAdapter.start(request): Promise<AssistantHandle>`. A request carries the task text, workspace, and an abstract set of allowed operations such as reading files, editing files, and running commands. The handle exposes an async progress stream, one final result promise, and `stop()`. The result is a discriminated success/failure value with usage fields, including available token counts and cost. Neither the request nor any returned value contains CLI flags, MCP configuration, provider events, or session IDs.

The `assistant` capability calls `start`, drains progress, and awaits the result, returning a normal `CapabilityResult`. It forwards its invocation's abort signal to `stop`. The existing dispatcher remains responsible for recording duration and success in the agent transcript. The capability's own progress hook is currently unread; the wrapper must drain adapter progress now so a child process cannot block on an unread stream, while exposing it through that hook when ENG-212 gives it a reader.

Alternative: make Claude Code's JSON stream the capability contract. That would make both the runtime and test double depend on Claude's output format and make replacing it an API migration.

### 2. Translate neutral operations at the Claude boundary

The first operation vocabulary is limited to workspace read, workspace write, and command execution. The Claude adapter maps these to its allowed built-in tools, scopes the process working directory to the agent workspace, and builds the headless invocation with `-p`, `--output-format stream-json`, and `--verbose`. It parses events into bounded text progress and a single result; unexpected output, a missing final result, nonzero exit, and a reported assistant error produce a failure result. Capture a bounded stderr tail for diagnosis, without echoing environment values.

No MCP server is needed for these built-in operations. Future custom tools can extend the neutral vocabulary and gain an adapter translation when they are needed; their design must not expose MCP to callers. The adapter makes no attempt to dispatch the agent's supervisor capabilities on the assistant's behalf.

Alternative: pass the agent's whole capability list into Claude as MCP tools. That creates another request bridge and grants a subprocess tools whose authority was intended for the agent's reasoning loop. It is outside this task's scope.

### 3. Launch the assistant as a child of the runtime inside its sandbox

`runtime/main.ts` composes the local assistant capability alongside the supervised declarations. `resolveCapabilities` still selects only names in the record. A spawned child uses the same runtime code and may receive `assistant` only when its parent grants that tool. Adapter selection is a construction dependency: the production composition supplies the Claude adapter; tests supply the double. It is not a new agent kind or root-only path.

The Claude child inherits the already delivered assistant credential under `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Its environment should include only the needed credential and ordinary execution variables. The record continues to carry references, and the supervisor's spawn path continues to copy them without values. The reasoning model's credential may be different and does not select the coding assistant.

Alternative: run Claude Code in a second container. That breaks the epic's chosen arrangement and duplicates sandbox and workspace lifecycle.

### 4. Stop owns process cleanup and a settled result

`stop()` is idempotent, terminates the active process tree, waits for exit, and settles the result as a stopped failure. The progress iterator ends. A stop racing with natural completion cannot change an already settled result. Adapter tests use a child that holds an observable resource to prove termination actually releases it, rather than checking only a flag.

The runtime's current dispatcher supplies an abort signal that it does not fire; this task does not add agent cancellation policy. The handle's stop behavior is independently testable and ready for a caller that does abort.

## Risks / Trade-offs

- **Claude stream format changes** → Keep parsing and CLI vocabulary inside the adapter; test init, progress, error, missing-result, and exit cases against representative stream events.
- **A stopped child leaves descendants or pipes live** → Kill the process group, await exit, close both output readers, and test resource release.
- **The assistant gets more authority than requested** → Map only the three abstract operations to an explicit allowed-tool set and verify the command arguments. The sandbox remains the filesystem boundary.
- **Usage fields vary by provider or event** → Keep fields optional inside a required usage object; report observed values only, and never infer zero from absence.

## Migration Plan

Add the adapter and capability in `agent/` only. Existing agent records without `assistant` continue to resolve the same capability set. Tests switch to the double by injection; a separate real-adapter check exercises Claude Code where it is installed. Rollback removes the new capability and adapter without changing persisted records that did not grant it.

## Open Questions

None for this change. A future arbitrary tool bridge and cost enforcement need their own tasks if the substrate requires them.
