## Context

ENG-194 needs an agent that can look at its own workspace, change it, and run programs in it — one of which may be a headless coding assistant. None of that is reachable today. The runtime exposes a record-selected `Capability` interface, but every capability in the production registry raises a request to the supervisor; the sandbox's own `exec` starts processes *for the supervisor* and is not a tool the reasoning loop can call.

The seams this needs already exist. `resolveCapabilities` (`agent/runtime/capability.ts:89`) builds a registry from the record's `tools`, `dispatch` invokes anything in it without knowing what it is, and the transcript records every call and result. The record already names a `workspace`, an `environment`, its tool grants, and its credential references. The Docker driver mounts that agent's volume and nothing else, sets the container's working directory to the workspace (`agent/sandbox/docker.ts:296–317`), and delivers resolved credentials over each process's standard input, where a shell prologue exports them and then `exec`s the real command (`docker.ts:89`). So the runtime process already holds the credentials in its own environment, and a child it spawns inherits them without a secret passing through an argument or a file.

The [proposal](proposal.md) also retires this change's original framing. Two existing spec statements describe reaching an assistant through an adapter — `agent-runtime`'s reasoning-loop rationale and `agent-supervisor`'s spawn-inheritance requirement — and the specs artifact must revise both at requirement granularity. The reasoning model remains the agent's decision maker. A headless assistant is a child process the agent may choose to start, and is not otherwise special.

## Goals / Non-Goals

**Goals:**

- Let a record grant `fs` and `exec` independently, each dispatched and recorded through the path every other capability already uses.
- Confine `fs` to the agent's mounted workspace, and bound what it returns.
- Run a command as a direct child of the runtime process, with the credentials the sandbox already delivered, and return its outcome as data the model can act on.
- Guarantee that no command can wedge an agent indefinitely.
- Give the agent enough guidance to use an installed assistant well, without any assistant appearing in the code.
- Prove all of it against a stub executable, spending nothing.

**Non-Goals:**

- An assistant adapter, an assistant-specific runtime API, an assistant selection policy, or an assistant field in the record.
- An image, a Dockerfile, or any live credential verification. That moved to ENG-199 with the real Claude Code pass; this change is complete and testable with no Docker build.
- A new supervisor request, a new sandbox driver operation, a change to the protocol, or a change to the loop's turn boundary.
- External cancellation of a running call. See Decision 5.
- A durable background job. A command belongs to the turn that started it.

## Decisions

### 1. Local capabilities join the registry beside supervised ones

Add a module under `agent/runtime/` exporting a factory that takes the record and returns the local `Capability` implementations. `main.ts` composes the registry from both sources — `[...SUPERVISED.map((d) => supervised(d, raise)), ...local(frame.record)]` — and `resolveCapabilities` selects from it by the record's `tools` exactly as before, still failing construction on a name it cannot resolve.

Nothing else changes. `capability.ts`, `dispatch`, and the loop gain no branch, which is the property `capability.ts` was written to hold: an agent at depth four runs the same bytes as the agent nobody spawned. A local capability differs from a supervised one only in what its `invoke` does, and `dispatch` cannot tell.

The factory takes the record because `fs` needs `workspace` and both need it to be *this* agent's. Routing local work through the supervisor instead would add a request, a correlation, and an authority boundary for work already inside the agent's own container, and would make the supervisor the bottleneck for every file read in the tree.

**One file-level doc comment becomes false and must be corrected in the same change.** `capability.ts` currently says every capability that ships is a supervised one, and that the interface's other half is exercised only by the test suite. That was accurate when written and stops being accurate here.

### 2. `fs` is one grant with three operations

Expose a single `fs` capability whose input names an operation — list a directory, read a file, write a file — with paths relative to `record.workspace` and `.` for the root. One capability rather than three named grants, because the grant is the unit of authority and `fs` without `exec` is the configuration worth having: an agent that can read and cannot run.

Return listings and file content as bounded text in `CapabilityResult.content`. Invalid input, a missing file, and an OS error are all `ok: false` results the model can read and react to, never throws — `dispatch` would convert them anyway, and a capability that reports its own failures says something more useful than a stringified exception.

Validate paths at invocation despite the JSON Schema, which is a guide to the model and not a trust boundary. Reject absolute paths and parent traversal, resolve the path, and require the result to remain under the workspace so a symlink cannot lead out of it. For a write, validate the parent, refuse an existing symlink at the target, write a temporary file in the same directory and rename it into place, so an interrupted write leaves either the old file or the new one and never half of either.

A write replaces a whole file. Patching, searching and bulk edits are what `exec` and the installed command-line tools are for; re-implementing them here would make this task an editor.

**`fs` is not a narrower `exec`, and the specs must not imply it is.** For an agent holding both, `exec` is the wider authority and `fs`'s path confinement constrains nothing — the value of `fs` to that agent is bounded output and structured failures, not containment.

### 3. `exec` runs argv in this container and bounds what comes back

Expose one `exec` capability taking an `argv` array, optional text `stdin`, and an optional workspace-relative `cwd` defaulting to the workspace root. Spawn the named executable directly with no implicit shell; an agent that wants a shell passes `sh`, `-lc` and its command, and says so in the transcript by doing it. Close stdin after the supplied input, drain stdout and stderr concurrently, and return the exit code or terminating signal with the two streams separately identified. A nonzero exit, a signal, a spawn failure, malformed input, or a deadline is `ok: false` with the output attached.

Two properties carry most of the value:

**Output is bounded by keeping both ends and dropping the middle**, per stream: a small fixed head buffer that stops accepting once full, and a ring buffer holding the tail. Neither end alone is right. The tail is what assistant output needs — `--output-format json` is a single closing object, `stream-json` ends with that same object, plain text ends with the closing summary — and it is what a failed build needs, since the error that stopped it is last. The head is what a compiler's error dump needs, where the first error is the cause and everything after it is cascade, and what `git log` or a stack trace needs, where the newest or innermost entry comes first. Keeping one end and not the other is wrong for half of what an agent runs.

The two buffers are also what bound memory: a process emitting gigabytes costs a constant, because the head stops filling and the tail drops what it has passed. A result that dropped anything says so and says how much, in place, rather than presenting a fragment as the whole — and the agent that needs more can redirect the command's output to a file and read it back through `fs` in pieces.

For ordinary work none of this engages. Sized in tens of kilobytes, the bound is above everything routine — a `git status`, a `git diff --stat`, a directory listing — which arrive whole and untouched. It is a backstop against the test suite, the verbose build and the large file, not a trimming every call pays.

**Credentials reach the child by inheritance and by nothing else.** The prologue has already exported them into the runtime process's environment, so an ordinary spawn is sufficient and no secret passes through `argv`, a file, or another request. Supplying a prompt on `stdin` keeps a large or sensitive prompt out of `argv` too, which is why `stdin` is part of the contract rather than an afterthought.

**`cwd` is a convenience, not a boundary.** It selects where the command starts; it does not confine it. `exec` is arbitrary execution inside the container and is designed as such — the container is the boundary, and a grant of `exec` must be read that way.

### 4. One fixed deadline, because nothing else will ever stop a command

`exec` enforces a single wall-clock deadline: a generous named constant in the capability module, not a parameter and not one of a pair of bounds. On expiry it signals the child's process group — `SIGTERM`, then `SIGKILL` after a short grace — and returns `ok: false` carrying the output captured so far and how it ended. It spawns the child into its own process group precisely so this works: a coding assistant starts children of its own, and signalling only the direct child leaves them running.

**Nothing else in the substrate would ever end a stuck call.** The supervisor arms a residency timer only at `#turn` (`agent/supervisor/index.ts:574`) and `#awaiting` (`:657`), both states an agent reaches by *finishing* something. A body blocked inside `dispatch` is `working` and has no timer at all, and the loop awaits each call in turn (`runtime/index.ts:166`), so one command that never returns is an agent that never returns.

**It bounds elapsed time rather than silence, because only that is complete.** Bounding silence catches a wedged process sooner, which is its whole advantage, and misses the process that emits forever without finishing — a watch-mode command, a build loop. Keeping the tail obliges `exec` to drain to the end, so an output cap cannot stop one either. That leaves the permanent wedge intact, which is the failure this exists to prevent. A second mechanism that covers the fast case and leaves the hole open is worse than one that closes it.

**It is fixed rather than named by the agent**, which is where it parts from `residency`. Residency is a cost-against-latency trade the agent alone can weigh, having just decided what it dispatched; `agent-supervisor` argues at length that a constant deciding it would be policy in code. A deadline is the opposite kind of thing — a liveness guarantee the substrate owes whatever the agent believes, and an agent that can name it can disable it. Set generously, no real assistant run is at risk, so the cost of the guarantee is wall-clock on an otherwise idle container.

`invoke`'s `signal` is honored as well, since doing so costs nothing and is the right home if suspension ever gains a graceful path. It is not the mechanism: nothing fires that signal today (`runtime/index.ts:132` constructs an `AbortController` and discards it).

### 5. External cancellation is deliberately absent

Every path that would stop a working agent already destroys its container — residency expiry, a parent dismissing a child, and shutdown all reach `#suspend` (`agent/supervisor/index.ts:507`), which syncs the log and calls `sandbox.destroy()`. The child dies with the container.

What the log then holds is a `tool_call` with no `tool_result`, and `answerInterrupted` (`runtime/events.ts:239`) already answers it on the next boot: a failed result saying the call was interrupted, that whether it took effect is unknown, and that it was not retried. The call is deliberately not re-executed. So an assistant run killed mid-flight is not silently paid for twice, and the agent is told enough to go and look.

Building a graceful stop would mean giving the `stop` frame a sender — `protocol.ts:107` defines it and `main.ts:316` handles it, but nothing in the supervisor emits it, and `main.ts:316`'s `break` only leaves the read loop before `await turns` blocks on the same call. Making it reachable is a supervisor sequencing change belonging to `agent-supervisor`, and it would buy a recorded "aborted" in place of a recorded "interrupted". Not worth it here.

### 6. Guidance goes where the agent will read it, and names no policy

The `fs` and `exec` descriptions state their scope, input shape, result shape, and when a direct call is enough. The `exec` description adds that a headless coding assistant may be installed and worth using for substantial work; that its availability should be checked rather than assumed, since the image is the project's choice; that the way to ask for an answer that is already small is a single-object output form such as `claude -p --output-format json`, whose closing summary, usage and error flag are the whole of what an agent needs; and that the assistant-neutral account of what actually changed is the workspace itself, through `git diff --stat`, rather than any CLI's event stream.

Ship a short charter template beside the capability, for whoever constructs an agent to say which assistant their image holds and which credentials the environment supplies. It is a template for the caller, not a hidden system prompt and not a routing rule — assistant choice stays the agent's judgment, and the transcript records the `argv`, so which assistant was chosen and whether one was chosen at all is auditable afterwards. That auditability is what makes guidance an acceptable substitute for a rule in code.

Guidance also covers the interrupted result from Decision 5: inspect the workspace before re-running, because the effect may already have landed.

### 7. Test each boundary at the level that can prove it

Unit tests cover grant selection for `fs` and `exec` independently; `fs` path validation including a symlink leading out of the workspace, atomic replacement, and read bounds; `exec` argv without a shell, `stdin` delivery, `cwd`, separate stream capture, nonzero exit, spawn failure, and the output bound — that output under the bound arrives byte-for-byte untouched, that output over it keeps both ends, and that what was dropped is reported.

The deadline gets its own tests, because it is the one guarantee here: a child that ignores `SIGTERM` is still gone after the grace, a child that has forked grandchildren leaves none behind, and the result reports the deadline with the output captured up to it.

A runtime-level test asserts that a local capability's result reaches the transcript and that no supervisor request is emitted for it — the property Decision 1 rests on.

A stub executable stands in for an assistant: it records the prompt it received on `stdin` and prints a canned single-object result, which is enough to exercise the whole path. No test starts a real assistant, needs an account, or needs Docker.

## Risks / Trade-offs

- **`exec` is arbitrary execution inside the container, including commands that print the environment.** → The sandbox's existing position stands and should be cited rather than re-litigated: an agent holds its own credentials, restriction concerns egress, and that is acceptable while the substrate runs on its operator's own machine (`openspec/specs/agent-sandbox/spec.md:232`). What is new is that a secret can now reach the **transcript**, which outlives the container. The sandbox's prohibition is scoped to what creation writes, so nothing breaks, but the specs artifact must say this rather than leave it to be inferred. Grant `exec` deliberately, and never write guidance that asks an agent to echo its environment.
- **A generous deadline means a wedged command holds a container for a long time.** → Accepted, and the alternative is worse in both directions: a short deadline kills real assistant work, and a second silence-based bound leaves the permanent wedge open. The cost is wall-clock on an idle container, not tokens.
- **The output bound can still drop something the agent needed** — a middle section, or a long first error that overruns the head. → Report what was dropped and how much, so the model knows it is reading around a gap rather than the whole; size the bound above everything routine so it engages rarely; and say in the guidance that output too large to return can be redirected to a file and read back through `fs`.
- **`fs` path validation races with the filesystem.** → Resolve and check immediately before each operation and refuse symlinked targets, and state plainly that the container is the security boundary — path validation does not defend against a hostile process that already holds `exec`.
- **A broad `exec` grant can bypass any narrower tool added later.** → Treat it as broad when ENG-203 designs git policy, and do not claim a narrower file or git policy for an agent that holds `exec`.

## Migration Plan

1. Add the local capability module, register it in `main.ts`, and correct `capability.ts`'s file comment. Records that name neither `fs` nor `exec` are unaffected; an agent's offered tools change only when its record does.
2. Grant `fs` and/or `exec` in a record and supply the charter guidance. Rollback is removing the grant — no record migration, no protocol change, no supervisor change.
3. ENG-199 supplies the image with an assistant installed and verifies headless authentication live. Until then the stub is the only assistant this change is tested against, which is sufficient for everything it specifies.

## Open Questions

- **What deadline, and what output caps?** Both are single constants and implementation should choose them, test them explicitly, and write the reasoning beside them. The deadline wants to sit comfortably above a substantial assistant run; the caps want to hold a single-object assistant result with room to spare, and the head's share wants to hold a compiler's first several errors. Neither is a parameter, so getting them wrong is a one-line change with evidence behind it rather than an interface revision.
