## 1. The sandbox's two new seams

- [x] 1.1 Change `ExecOptions.input` from the only thing written to the first thing written: `Process` gains a standard input that stays open, and `exec` no longer closes the pipe. The credential block and the caller's first input stay a single concatenated write.
- [x] 1.2 Add the fifth operation to `SandboxDriver`: end every sandbox belonging to this driver's run, taking no argument and naming nothing driver-specific. Implement it in the container driver over the marking it already applies at creation.
- [x] 1.3 Make the run-wide release leave workspaces alone. This is the one line in this change that destroys a day of work if it is wrong.
- [x] 1.4 Test that a caller sends twice and the process receives both in order, that credentials still arrive first and uninterleaved, and that ending the input is observed by the process.
- [x] 1.5 Test that a failed send is reported to the caller and does not end the caller's process — the caller is the supervisor, and one broken pipe must not take the tree with it.
- [x] 1.6 Test the run-wide release with every sandbox handle discarded, that it leaves every workspace with its contents, and that it does not reach another run.
- [x] 1.7 Update `sandbox/index.test.ts`'s reading of the interface for the fifth operation, keeping the declarations free of any driver's vocabulary.

## 2. The runtime as a protocol peer

- [x] 2.1 Give `Runtime` a callback invoked as each event is appended. The loop, the projection, the record and the capability surface are untouched, and `events` still returns the array.
- [x] 2.2 Rewrite `runtime/main.ts` to read the boot frame, construct a `Runtime`, then read and write frames until told to stop — instead of running one turn and printing a result.
- [x] 2.3 Emit each event on the channel as it is appended, before the next step begins.
- [x] 2.4 Report the end of a turn as a frame carrying the agent's message and its residency instruction, supplying zero where the agent expressed none.
- [x] 2.5 Build the helper that turns a supervisor-backed request into an ordinary `Capability` — `invoke` writes a request frame and awaits its answer. Register none of them; the set stays empty, as ENG-210 left it.
- [x] 2.6 Test that an agent killed mid-turn has already emitted the events for its completed steps.
- [x] 2.7 Test that the events emitted across a run, collected in order, are the transcript that run produced.
- [x] 2.8 Test that the boot frame's remainder is readable as the conversation, with nothing consumed by reading the frame.

## 3. The store

- [x] 3.1 Lay out `.jen/runs/<run>/` with `run.json`, and per agent a write-once `record.json`, a rewritten `state.json`, and an appended `events.ndjson`.
- [x] 3.2 Add the `.gitignore` rule for the store, narrow enough that nothing else under the project is caught by it.
- [x] 3.3 Append events as frames arrive, one JSON object per line, never rewriting the file.
- [x] 3.4 Read a transcript in line ranges, and serve a range without parsing the rest of the file.
- [x] 3.5 Store state transitions: working, waiting and on which request, or dismissed, plus parent, children and pending mailbox.
- [x] 3.6 Flush and sync an agent's log before its container is destroyed, and destroy only after the sync returns.
- [x] 3.7 Test that a transcript truncated mid-write loses the last line and nothing before it.
- [x] 3.8 Test that a supervisor constructed over an existing store reads back every agent's state, parentage and mailbox.

## 4. The protocol and routing

- [x] 4.1 Define the frames: a request carrying an id and a kind, an answer carrying that id, and the runtime's event and turn-end frames. Adding a kind must not reshape the transport.
- [x] 4.2 Read and write frames over each agent's standard streams, correlating answers to outstanding requests by id.
- [x] 4.3 Report a frame that cannot be read to the agent that sent it, leaving its other outstanding requests alone.
- [x] 4.4 Hold one mailbox per agent and route parent-to-child only, refusing anything else observably rather than dropping it.
- [x] 4.5 Make a message durable before acknowledging it to its sender.
- [x] 4.6 Deliver by the two paths: a message for an agent with an outstanding `await` answers it; a message for an agent at a turn boundary begins a new turn. Hold a message for a working agent until it reaches one of the two.
- [x] 4.7 Surface a message the root addresses to its parent to the human, and deliver a human's message to the root by the same path a parent's takes.
- [x] 4.8 Build the scripted protocol peer: emits frames from a script, records what it receives, makes no model calls.
- [x] 4.9 Build the `SandboxDriver` double: containers as objects, `exec` returning pipes the test holds both ends of, destruction observable.
- [x] 4.10 Test that concurrent requests are told apart, and that a sibling cannot be addressed.

## 5. Suspend and resume

- [x] 5.1 Provision from the record, boot a runtime with the stored transcript, and deliver the message so the agent continues as though its call returned.
- [x] 5.2 On a message for an agent suspended on `await`, append the answering `tool_result` to the stored log *before* booting.
- [x] 5.3 Test that a resumed agent's next request carries the delivered message and not `answerInterrupted`'s text. This is the test that catches the collision the design is built around.
- [x] 5.4 Test that an agent killed mid-call still gets `answerInterrupted`'s synthesized result, so fixing 5.2 has not disabled it.
- [x] 5.5 Test that a resumed agent's requests are byte-identical to an uninterrupted one's, and that its workspace still holds what it wrote.
- [x] 5.6 Arm a timer from the residency on the `await`: a message cancels it and answers in place, expiry syncs and destroys while leaving the agent's state untouched.
- [x] 5.7 Test that an agent asking to be kept is woken in its own container with nothing provisioned, and that one asking for nothing is torn down.
- [x] 5.8 Add the source-level test that no duration constant lives in the supervisor, in the spirit of the sandbox's no-`node:fs` guard.

## 6. Failure, and what the supervisor does with it

- [x] 6.1 Detect a container exiting while its agent's state says working, and deliver a message to the parent naming the child and what is known of the exit.
- [x] 6.2 Mark that message as the substrate's, so a parent can always tell a report of a death from a report by the deceased.
- [x] 6.3 Separate the two cases that look alike: a container lost while the supervisor is watching is a death to report, while a supervisor restarting over a store finds every agent bodiless and must sweep and resume rather than report the whole tree dead.
- [x] 6.4 Test that a killed child wakes a parent suspended on `await`, and that an agent which spoke before exiting produces no termination report.
- [x] 6.5 Test that a restart over a store of working agents resumes them and synthesizes no terminations.
- [x] 6.6 Detect the stalled tree — every agent waiting, every mailbox empty — after each state transition, and surface it without waking, messaging or dismissing anyone.
- [x] 6.7 Test that a run with a message still pending is not reported as stalled, and that residency timers do not affect the verdict.

## 7. Transcript reads

- [x] 7.1 Serve a read only where the target is a descendant of the caller, walking the stored parentage.
- [x] 7.2 Serve ranges, and report a refusal as a refusal rather than as an empty transcript.
- [x] 7.3 Test that a descendant's transcript is served, a non-descendant's is refused distinguishably, and a long one can be read in parts.

## 8. The whole thing, against real containers

> **Run, on a real runtime, by test-task.** Docker 29.4.1. Six defects surfaced on first
> contact, every one of them in test code and none in the supervisor or the driver, which
> behaved as their specs describe throughout. Three were in `sandbox/docker.test.ts`, where
> tests that pre-date this change still asserted the input closing when `exec` had written
> what the caller gave it — the contract task 1.1 deliberately removes — and hung against the
> implementation of it. Three were in this change's own `containers.test.ts`: agents added
> with no opening message so nothing ever booted, a record whose credential could not resolve
> so nothing could be provisioned, and a wait for a whole tree to be `waiting` at one instant,
> which this tree never is because a child's report wakes its parent again. The whole agent
> suite is now 296 across 20 files with a runtime present, and the container tier was repeated
> three times to confirm it is not flaky. Details are on PR #35 and the issue.

- [x] 8.1 Test that a fully dormant tree leaves no container running, and that an agent which asked to stay resident still holds its own — the assertion is that each was honoured, not that suspension always tears down.
- [x] 8.2 Test that a tree mid-flight survives killing the entire process group and resumes from records and transcripts alone, every agent continuing where it stopped.
- [x] 8.3 Test that a killed run is swept, leaves no container, keeps every workspace, and then resumes.

## 9. Notes and checks

- [x] 9.1 Write `agent/supervisor/AGENTS.md` for what a future session would otherwise rediscover: the `answerInterrupted` collision and why the answer is written before booting, the sweep that must never take a workspace, and the one-provisioning-at-a-time assumption the sandbox already records and this is the caller for.
- [x] 9.2 Note in `agent/AGENTS.md` that the supervisor's integration tier needs a running container runtime, alongside what is already said for the sandbox's.
- [x] 9.3 Run `npx tsc -p agent/tsconfig.json` and `npx vitest run --config agent/vitest.config.ts`. Nothing automated covers `agent/`, so this is the only thing that catches a break. — typecheck clean; 250 tests pass across 18 files, the ten added for review's findings included. The two files needing a container runtime fail in `beforeAll` for want of one and were excluded, which is the gap 8.1–8.3 record.
- [x] 9.4 Run `npx openspec validate eng-213-build-the-supervisor-routing-records-and-the-suspendresume --strict`.
