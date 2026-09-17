## Why

The agent runtime has a capability interface, but every capability that ships raises a request to the supervisor. An agent cannot read a file, change code, or run a program in its own sandbox. The sandbox driver starts processes *for the supervisor*; that is not a tool the reasoning loop can reach. ENG-194's recursive run needs ordinary local work, and a headless coding assistant is one thing that local work can be.

This task was written around an assistant *adapter* — an interface returning a handle with progress, a result, and a stop, specified by what it must not contain, with a second implementation to prove it neutral. That interface already exists, at the command line, in more than one implementation. `claude -p --output-format json` returns a single object carrying the assistant's own closing summary, a `total_cost_usd` and full `usage`, and an `is_error` that distinguishes failure from success in the result itself. `codex exec --json` returns the same three things as JSONL. Those were the adapter's named requirements. Wrapping two programs that already agree on a result shape, in an interface whose whole purpose is to make them agree on a result shape, buys nothing and costs a provider-specific seam inside the runtime — precisely the branch `agent-runtime` forbids itself. So the agent reaches an assistant the way it reaches any other program: by running it.

## What Changes

- Add record-selected `fs` and `exec` capabilities for work inside the agent's own sandbox and workspace. They implement `invoke` in the runtime process, raise no supervisor request, and are recorded by the existing dispatcher and transcript like any other call.
- `exec` takes an `argv` array with no implicit shell, optional `stdin`, and an optional workspace-relative `cwd`. It returns exit code or signal with separately identified stdout and stderr, and a nonzero exit, spawn failure, or malformed input is a failed result the agent can read rather than a runtime error.
- **`exec` bounds its output by keeping the tail.** Every form of assistant output puts the payload last: Claude Code's single JSON object, Codex's `turn.completed`, plain text's closing summary. Truncating from the front discards exactly the part worth having.
- **`exec` enforces a deadline it is given, and this is the only cancellation this change builds.** On expiry it terminates the child's process group and returns a failed result carrying the output captured so far. The agent names the deadline, within a cap: only the agent knows whether it just dispatched a linter or a refactor, which is the argument `agent-supervisor` already makes for `residency`. The cap is where the two differ — an unbounded residency costs a sleeping container, an unbounded command wedges a working one.
- Let an agent invoke an installed assistant headlessly through `exec`, authenticated from the environment the sandbox already delivers by reference. Assistant choice and command construction are the agent's; no assistant routing rule enters the code.
- Give the agent guidance, in tool descriptions and charter context, on when `fs`/`exec` suffice, when an assistant helps, and **how to ask for an answer that is already small** — the assistant's own closing message rather than its event stream — with the workspace itself (`git diff --stat`) as the assistant-neutral account of what actually changed. Guidance also covers what to do when a call comes back interrupted: inspect the workspace before re-running, because the effect may already have landed.
- Exercise all of it against a stub executable standing in for an assistant, so no test spends a token.

## Capabilities

### New Capabilities

- `agent-workspace-tools`: Record-selected `fs` and `exec` operations inside the agent's sandbox — their contracts, path confinement, output bounds, deadline and termination behaviour, observable failures, and agent-facing descriptions.

### Modified Capabilities

- `agent-runtime`: Keep the reasoning loop and the rule that it is never delegated. Replace the rationale that reaches the assistant "through an adapter" with invocation as an ordinary local command, and state that a capability may impose its own deadline on work it starts.
- `agent-supervisor`: Keep model inheritance and tool subset rules, and remove the claim that a separately configured coding-assistant capability exists. A child inherits its parent's image and credential references and can invoke an installed assistant only if granted `exec`.

## Impact

- New local capability implementations and tests under `agent/`. Neither the reasoning loop nor supervisor routing gains an assistant-specific path.
- **No image work here.** A reproducible image with an assistant installed, and the live verification that it authenticates headlessly, moved to ENG-199, which is where the real Claude Code pass already lives and which needs real containers anyway. ENG-211 is complete and testable against the stub with no Docker build.
- **Codex is not part of the first image**, decided on evidence rather than preference: its only documented headless environment path is an API key, while subscription access authenticates through a refreshed `~/.codex/auth.json`, and `agent-sandbox` forbids a secret reaching a file inside the sandbox. Nothing here is Claude-specific, so adding Codex later is an image change and a line of guidance.
- **Granting `exec` is granting arbitrary execution inside that container**, including commands that print the environment. The sandbox's existing position stands — an agent holds its own credentials, restriction concerns egress, and that is acceptable while the substrate runs on its operator's machine. What is new is that a secret can now reach the *transcript*, which outlives the container; the specs artifact must say so rather than leave a reader to infer it from a prohibition scoped to what creation writes.
- **`fs` is kept for what it actually gives**, not for authority it does not: bounded reads the model cannot drown in, structured failures instead of parsed stderr, and a grant worth having on its own — an analysis agent holding `fs` without `exec` can read and cannot run. It is not an allowlist for `exec`, and the specs must not imply it narrows anything for an agent holding both.
- Existing credential references remain the source of assistant tokens. No token value is persisted in a record, written to a file, or passed in a command argument.
- Per-invocation spend is not reported. Claude Code's result envelope carries `total_cost_usd` and `--max-budget-usd` caps a single run, so a ceiling later is guidance and a flag rather than an interface change — which is why nothing is built for it now.
- External cancellation is deliberately not built. Container destruction already stops a running command on every path that has one — residency expiry, a parent dismissing a child, and shutdown — and `answerInterrupted` answers the orphaned call on the next boot with an explicit admission that the effect is unknown and was not retried. The `stop` frame the protocol defines has no sender today; giving it one means changing how the supervisor sequences a suspend, which belongs to `agent-supervisor` and buys only a recorded "aborted" in place of a recorded "interrupted".
