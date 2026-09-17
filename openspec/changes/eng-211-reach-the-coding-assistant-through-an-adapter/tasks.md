## 1. The local capability seam

- [ ] 1.1 Add a module under `agent/runtime/` exporting a factory that takes an `AgentRecord` and returns the local `Capability` implementations, and put the two constants at its top with their reasoning beside them: the output cap and the command deadline. Choose values rather than deferring — the cap conservative enough that a routine `git status`, `git diff --stat`, directory listing or single-object assistant result arrives whole and a verbose test run does not, the deadline comfortably above a substantial assistant run.
- [ ] 1.2 Compose the production registry in `runtime/main.ts` from the supervised declarations and the local factory together, leaving `resolveCapabilities` to select by `record.tools` as it already does. Add no branch to `capability.ts`, `dispatch`, the reasoning loop, or the protocol.
- [ ] 1.3 Correct the file comment in `runtime/capability.ts` that states every capability which ships is a supervised one and that the interface's other half is exercised only by the test suite. It was true when written and stops being true here.
- [ ] 1.4 Test that a record naming `fs` alone offers `fs` alone, that a record naming neither is valid and offers neither, and that an unresolvable name still fails construction.

## 2. `fs`

- [ ] 2.1 Implement path resolution against `record.workspace`, refusing absolute paths, parent traversal, and any path resolving outside the workspace through a symbolic link. Validate at invocation rather than trusting the declared schema, which is a guide to the model and not a trust boundary.
- [ ] 2.2 Implement list, read, and write, with write replacing the whole file by creating a temporary file in the same directory and renaming it into place, and refusing a target that is an existing symbolic link.
- [ ] 2.3 Return invalid input, a missing file, and an OS error as failed results describing what happened, never as throws.
- [ ] 2.4 Test the reason `fs` exists: a write whose content contains single and double quotes, a `$`, a backtick, and a line that would terminate a shell heredoc, round-tripping byte-for-byte through a read.
- [ ] 2.5 Test path refusals including a symlink inside the workspace pointing out of it, and test that an interrupted write leaves either the old file or the new one whole.

## 3. `exec`

- [ ] 3.1 Implement spawning the argument vector directly with no interposed shell, into its own process group, with the working directory resolved relative to the workspace and defaulting to its root.
- [ ] 3.2 Supply the optional input on standard input and close it; collect standard output and standard error separately and concurrently; return the exit code or terminating signal with both streams.
- [ ] 3.3 Return a nonzero exit, a terminating signal, a spawn failure, and malformed input as failed results carrying whatever output was collected.
- [ ] 3.4 Confirm by test that a child inherits the credentials the sandbox exported into the runtime process's environment, and that no secret is placed in an argument, a file, or a record to get there.
- [ ] 3.5 Test argv without shell interpretation, input delivery to a command that reads to end of input, working directory selection, separate stream capture, a nonzero exit, and a program that does not exist.

## 4. The two bounds

- [ ] 4.1 Implement one termination path used by both bounds: signal the child's process group, then force it after a short grace. It must end descendants, not only the process directly started.
- [ ] 4.2 Implement the output cap in `exec` and `fs` from the same constant: return content from its beginning up to the cap, state in the result that it was cut off, and in `exec` terminate the command at that point. Select no portion of the output as significant — no retained tail, no elided middle, no per-command rule.
- [ ] 4.3 Implement the deadline in `exec`: on expiry terminate and return a failed result carrying the output collected so far and saying the deadline was reached. Honour `invoke`'s `signal` as well, noting in a comment that nothing fires it today.
- [ ] 4.4 Test the cap: output under it arrives byte-for-byte with no truncation claimed; output over it is cut at the cap, declared, and the command terminated; a command emitting without stopping is ended rather than exhausting the runtime.
- [ ] 4.5 Test the deadline: a command that never finishes is ended and reported; a command that ignores the first signal is ended anyway; a command that forked children of its own leaves none running.

## 5. Agent-facing guidance

- [ ] 5.1 Write the `fs` and `exec` descriptions covering scope, inputs, result shape, and failure modes.
- [ ] 5.2 Make output management carry real weight in the `exec` description, since the capability deliberately decides nothing: that a tool result is carried again on every later model call, that large output is narrowed before running with `tail`, `grep` or a redirect rather than recovered after, the cap as a number and what happens at it, and that the only recovery is re-running the command — which for a test suite or build costs the whole run and may be unsafe to repeat.
- [ ] 5.3 Cover assistants in the `exec` description without naming one as required: check the command is present rather than assuming it, prefer an invocation whose output is already small such as a single-object output form, and establish what changed from the workspace with `git diff --stat` rather than from any assistant's output format. Encode no rule about when to use one.
- [ ] 5.4 Ship a short charter template beside the capability for whoever constructs an agent to state which assistant their image holds and which credentials the environment supplies, and to say that a result reporting an interrupted call means inspecting the workspace before re-running, because the effect may already have landed.

## 6. Verification

- [ ] 6.1 Add the stub executable standing in for an assistant: it records the prompt it received on standard input and prints a canned single-object result. No test starts a real assistant, needs an account, or needs Docker.
- [ ] 6.2 Test at the runtime entry that a local capability's result reaches the transcript with its duration and success, and that no supervisor request is emitted for it.
- [ ] 6.3 Run `npx tsc -p agent/tsconfig.json` and `npx vitest run --config agent/vitest.config.ts`, and report explicitly if any tier could not run.
- [ ] 6.4 Run `openspec validate eng-211-reach-the-coding-assistant-through-an-adapter --strict`, and record in `agent/AGENTS.md` — or a deeper one — any convention this change establishes or gotcha a future session would otherwise rediscover, only if one was actually learned.
