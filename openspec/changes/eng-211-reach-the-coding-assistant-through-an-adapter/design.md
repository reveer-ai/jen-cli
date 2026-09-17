## Context

ENG-194 needs an agent to inspect and change its own workspace, run local programs, and optionally ask a coding assistant for help. The runtime already exposes a record-selected `Capability` interface, but its production registry contains only capabilities that raise requests to the supervisor. The sandbox's `exec` primitive starts processes *for the supervisor*; it is not an agent-facing tool. An agent record already names an image, workspace, tool grants, and credential references. The Docker driver mounts only that agent's volume and delivers resolved credentials to the runtime process through a pipe, where they become environment variables.

The [proposal](proposal.md) uses those existing seams. It also supersedes two older spec statements that describe a separate coding-assistant adapter or configuration: `agent-runtime`'s reasoning-loop rationale and `agent-supervisor`'s spawn-inheritance requirement. The next specs artifact must update both requirements at requirement granularity. The reasoning model remains the agent's decision maker; a headless assistant is a child process the agent may choose to invoke.

## Goals / Non-Goals

**Goals:**

- Let a record grant `fs` and `exec` independently, with calls and outcomes recorded by the existing runtime transcript path.
- Make workspace file operations predictable and confined to the agent's mounted workspace; make command execution work in the same container as the runtime.
- Provide a reproducible reference image recipe with Claude Code and Codex installed, plus accurate agent-facing guidance for using those commands through `exec`.
- Use the record's existing credential references and process environment, with no assistant token in an image, agent record, command argument, or new credential store.
- Test the boundary with a stub assistant executable without spending assistant tokens.

**Non-Goals:**

- A provider-specific assistant adapter, assistant-specific runtime API, assistant selection policy, or a separate assistant field in the agent record.
- A new supervisor request, sandbox driver operation, long-running job manager, or change to the reasoning loop's turn boundary.
- Building or selecting a default project image on behalf of the project. The record's `environment` still selects the image that project built.
- Automatically discovering or granting credentials, or promising that every authentication mode of every CLI works from an environment variable alone.

## Decisions

### 1. Resolve local capabilities beside supervised ones

Create local `Capability` implementations under `agent/runtime/` (or a sibling local-capabilities module) and add them to the production registry assembled in `runtime/main.ts`. `resolveCapabilities` still selects only names present in the agent record and still fails on unknown names. `fs` and `exec` implement `invoke` directly in the runtime process. They emit no supervisor request; the existing dispatcher records their call, result, duration, and success. The supervisor's sandbox `exec` remains the way the supervisor starts the runtime, not a second path for agent tool calls.

This uses the interface already intended for sandbox-local work. Routing each file read or child process through the supervisor would add a request and authority path with no benefit for work already inside that agent's container. Putting assistant handling in the reasoning loop would make one tool special and couple it to a CLI provider.

### 2. Give `fs` a small, workspace-relative contract

Expose one `fs` capability with explicit operations to list a directory, read a file, and write a file. Inputs use paths relative to `record.workspace`; a root listing uses `.`. Return file content or entry metadata as bounded text in `CapabilityResult.content`, and report invalid input, missing files, and OS errors as failed results the agent can react to. A write replaces the requested file's contents; callers use `exec` for patching, search tools, or bulk changes. No implicit directory creation or host path selection is needed.

Validate the input at runtime despite the model-facing JSON Schema. Reject absolute paths, parent traversal, and paths whose existing components resolve through a symlink outside the workspace. For writes, validate the parent and refuse an existing symlink target; create the replacement in the same directory and rename it into place so an interrupted write does not leave a partial file. Keep file reads and directory listings bounded so a mistaken request does not fill a model context or runtime memory. Avoid making `fs` an allowlist for `exec`: it has a narrower path contract, while `exec` intentionally exposes the container's command environment.

The alternative was a broad filesystem API with patch and search operations. The three operations cover direct inspection and replacement; installed command-line tools cover the rest without making this task another editor implementation.

### 3. Execute argv in the current container and return bounded output

Expose one `exec` capability with an `argv` array, optional text `stdin`, and optional workspace-relative `cwd` (default: workspace root). Spawn the named executable directly without an implicit shell. If a shell is wanted, the agent explicitly supplies `sh`, `-lc`, and its command. Close stdin after the supplied input, drain stdout and stderr concurrently, and return exit code or signal plus separately identified, bounded stdout and stderr. A nonzero exit, signal, spawn failure, malformed input, or abort is an `ok: false` result rather than a fatal runtime error. Honor the capability's abort signal by terminating the child and its process group where the platform permits. A command runs within the current turn; it is not a durable background job and is lost if the container is destroyed.

The direct-child approach lets a headless CLI inherit the runtime process's credential environment without moving secrets through tool arguments or another supervisor request. Supplying prompts over `stdin` keeps large or sensitive prompts out of argv. An implicit shell would add quoting and injection hazards to every call. Arbitrary command execution is deliberately broad *inside the sandbox*: changing `cwd` does not confine commands to the workspace, and a tool grant must be treated accordingly.

### 4. Ship a reference image recipe, not an image selector

Add an `agent/` image recipe and build instructions based on a pinned Node 22.18+ image. Install the agent runtime's dependencies and pinned releases of `@anthropic-ai/claude-code` and `@openai/codex` in that image, verify both executable names during build, and make no network authentication call at build time. Projects can extend or replace this Dockerfile and put their resulting image reference in `AgentRecord.environment`; the Docker driver continues to build nothing and choose no default. Pinning the CLI versions makes a rebuilt reference image reviewable. Updating them is an explicit project/image change.

The official CLIs expose noninteractive entry points: [Claude Code `claude -p`](https://code.claude.com/docs/en/headless) and [Codex `codex exec`](https://learn.chatgpt.com/codex/non-interactive-mode). Their [installation instructions](https://code.claude.com/docs/en/setup) and [Codex repository](https://github.com/openai/codex/blob/main/README.md) support npm installation. The design does not invent an assistant protocol: commands and flags stay owned by each CLI.

### 5. Put practical guidance where the agent can read it

The `fs` and `exec` tool descriptions explain their scope, syntax, result shape, and when a direct tool call is sufficient. The `exec` description says an installed headless assistant can be called for substantial coding work, shows `claude -p` and `codex exec -` with the prompt supplied on stdin, and tells the agent to check command availability and inspect the resulting changes. Keep this description conditional in wording: the reference image contains both CLIs, but a custom image may not. Ship a short charter guidance example alongside the image recipe so whoever constructs an agent can state which assistants are available, when to use one, and which credentials the environment supplies. That example is a template for the caller, not a hidden system instruction or automatic routing rule. Existing charters remain the first system context; record tool grants remain the authority boundary.

Assistant authentication comes from the existing environment names supplied by credential references. For example, Claude can consume `ANTHROPIC_API_KEY` or a supported Claude OAuth token; Codex's documented noninteractive API-key path uses `CODEX_API_KEY`. [Codex authentication documentation](https://learn.chatgpt.com/docs/auth) describes a separate login flow for a ChatGPT access token, so this design does not claim direct `codex exec` OAuth-token environment support. A live check must confirm each configured credential mode against the pinned CLI version before it is offered as a supported image configuration.

### 6. Test each boundary at the level that can prove it

Unit tests exercise grant selection, `fs` path validation including symlink escape, atomic replacement, `exec` argv/stdin/cwd behavior, output bounds, nonzero exits, and a fake `claude` or `codex` executable that records the intended stdin while returning deterministic output. A runtime entry test verifies the local tool result appears in the transcript and does not emit a supervisor request. A reference-image smoke check builds the image and checks the installed command versions; a separate credentialed live pass can run an actual headless assistant when ENG-199 exercises end-to-end acceptance. No unit test needs a real assistant account.

## Risks / Trade-offs

- **Generic `exec` can run any command inside the container, including commands that print environment variables.** → Grant it only to agents that need it; retain the sandbox's isolated volume and absence of host mounts or daemon socket; keep credentials as references in records. Tool results and transcripts are not a secret-redaction boundary, so agent guidance must not ask for `env` dumps or echo tokens.
- **A local process can hang or produce unbounded output.** → Drain both streams, cap returned and buffered output, honor abort, and make interruption visible as a failed result. The current runtime does not actively abort ordinary tool calls; container teardown remains the final stop for a stuck process until a later task adds stronger turn-level cancellation.
- **`fs` path checks race with filesystem changes.** → Resolve and validate immediately before each operation and reject symlink targets; document that the container boundary, not path validation, is the security boundary against a malicious process already holding `exec`.
- **CLI versions, flags, and auth modes can change.** → Pin versions, keep invocations in versioned image guidance, smoke-test executable presence, and check live auth modes against those versions. Rebuilds require deliberate version bumps.
- **Broad `exec` authority can bypass future narrow git tools inside the container.** → Treat `exec` as a broad grant when designing ENG-203's git policy; do not claim a narrower file or git policy for an agent granted `exec`.

## Migration Plan

1. Add the local registry entries and tests without changing existing records. Agents without `fs` or `exec` continue to see their current tools.
2. Add the pinned reference Dockerfile and guidance. Build it, check `claude --version` and `codex --version`, and run the stub invocation test. Projects opt in by building an image and naming it in the agent record.
3. Grant `fs` and/or `exec` in records and, where assistant use is intended, provide the appropriate credential references and charter. Confirm a live headless call separately before treating an auth mode as supported.
4. In the specs artifact, update the two stale adapter/configuration statements named above. Rollback is to remove the grants or select the prior image; neither records nor supervisor protocol require migration.

## Open Questions

- Which Codex OAuth token form, if any, can run fully headlessly with the pinned CLI without writing a login file? Until verified, the supported Codex path is `CODEX_API_KEY`; the design does not block API-key use or Claude OAuth use on this question.
- What output and file-size caps best balance useful coding output with the reasoning model's context? Implementation should choose explicit, tested limits and report truncation rather than silently clipping.
