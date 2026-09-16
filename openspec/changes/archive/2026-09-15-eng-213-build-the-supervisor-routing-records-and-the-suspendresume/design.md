## Context

See `proposal.md` for why. The requirements are in `specs/`.

What ENG-196 and ENG-210 actually left behind, which is not quite what the epic says:

- `SandboxDriver` has `create` and `releaseWorkspace`. A `Sandbox` has `exec` and `destroy`. A `Process` has `stdout`, `stderr` and `exit`. `exec` takes `input?: string`, writes it once, and closes the pipe (`agent/sandbox/docker.ts:165`).
- **There is one driver.** The epic says ENG-196 left an in-process driver so the substrate could be tested without Docker. It did not. `DockerSandboxDriver` is the only one, and `agent-sandbox` closed the set at one.
- `Runtime` has `turn()`, `run()`, `events` and `request()`. Events go into a private array. Nothing leaves the process until `main.ts` prints `{ message, events }` and exits.
- `readBootFrame` reads one line and pushes the rest back, so the protocol can be read off the same pipe.
- `answerInterrupted` answers every `tool_call` that has no `tool_result` with a synthesized failure. On construction, every time.

That last one shapes most of this design.

## Goals / Non-Goals

**Goals**

- A protocol that takes new request kinds without the transport changing. ENG-197, ENG-198, ENG-211 and ENG-212 all add to it.
- A suspension the runtime cannot see, so "no code path means *was resumed*" holds by construction rather than by care.
- Supervisor logic testable with no container runtime and no model.

**Non-Goals**

- The `spawn`, `send`, `await`, `stop` and `read` capability objects. ENG-197 and ENG-198.
- A second production sandbox driver. A test double implementing the interface is not one.
- Any human interface beyond the root's messages reaching a person and back. ENG-199.

## Decisions

### An agent's life, and its body's

Two lifetimes, and only one of them is what residency is about.

The **agent** exists because its record exists. It starts at spawn and ends only at `stop`. There is no completed state — a child that reports is dormant, not finished.

Its **body** is a container. It exists only while the agent is thinking, and is created and destroyed many times over one agent's life. None of that appears in the agent's transcript.

```
  spawn ──▶ WORKING ──── await(n) ───▶ WAITING
              ▲                          │
              │                    ┌─────┴─────┐
              │          message   │           │  n elapses
              │          first     │           ▼
              └──────────────────┬─┘      body destroyed
                                 │        (state unchanged)
                                 │             │
                                 └─────────────┘
                                   message arrives: answer
                                   written to log, fresh body
```

Both paths back to `WORKING` are the same event to the agent — `await` returned. The only difference is whether a container had to be started, and the agent cannot tell.

Two things that look like states and are not. **A turn ending** is not one: the agent produced content with no calls outstanding, the message goes to its parent's mailbox, and it is at a turn boundary. That is the same `WAITING`, reached without an explicit `await`, which is why the runtime supplies residency 0 there. **Dying** is not a transition the agent makes: the body vanishes while the state still says `WORKING`, and that is what the supervisor detects.

### `await` is an ordinary request, so suspension is invisible

Every runtime-to-supervisor request carries an id, and the supervisor answers with that id. `await` is one of them. Suspension is just what the supervisor does while an `await` is outstanding: it may destroy the container and boot a new one to deliver the answer.

The alternative was a separate `suspend` frame the runtime raises and waits on. Rejected because it gives the runtime a suspend path, and then a resume path, and "nothing distinguishes a resumed agent" turns into something maintained by care instead of something with nowhere to fail.

The residency number rides as a field on the `await` request, not as a frame of its own.

### The answer is written to the log before the agent boots

This is the one to get right, and `answerInterrupted` is why.

A suspended `await` and a process killed mid-`spawn` leave the same thing in the log: a `tool_call` with no `tool_result`. `answerInterrupted` runs on construction and cannot tell them apart. So a resumed agent has its `await` answered with *"This call was interrupted by a restart before its result was recorded"* instead of with its message. It then reasons about a failure that never happened. Nothing errors, and the transcript looks fine.

So when a message arrives for an agent suspended on `await`, the supervisor appends the answering `tool_result` to the stored log **first**, then boots. The runtime constructs on a complete log, `answerInterrupted` finds nothing to do, and the next step proceeds. The runtime knows none of this.

This is less clever than it first looks, and it should read as ordinary. For a supervisor-backed capability the supervisor *is* what produces the result — normally it sends it down the pipe and the runtime appends it. When there is no pipe, it appends the same value to the same place itself. Same result, same position, different delivery.

Telling the two cases apart needs the supervisor to know which one it is in. That is why state is stored rather than inferred — inferring it from the log is exactly what cannot work.

Rejected: put the answer on the boot frame and have the runtime splice it in. That moves resume-awareness into the runtime.

### State is stored, and is what separates suspension from death

Per agent: the record, the event log, and a small state file — working, waiting (and on which request), or dismissed, plus parent, children and pending mailbox.

Three files because there are three write patterns: the record is written once and never again, the log only ever grows, and the state is rewritten in place. Merging any two would mean rewriting an append-only file or appending to a mutable one.

A message is durable before its sender is told it landed. `send` is fire-and-forget to the agent that calls it, so an acknowledgement that outruns the write would be the substrate lying about the one thing the caller can check.

Three situations that are identical in the log alone:

| Stored state | Log ends in | Means | Action |
|---|---|---|---|
| waiting on `await` | unanswered `tool_call` | suspended on purpose | answer appended on delivery |
| working | unanswered `tool_call` | died mid-call | `answerInterrupted` does its job |
| working | a complete step | died between steps | resume, take the next step |

A supervisor that dies and restarts reads these back and is where it was. That is what the whole-tree survival scenario needs.

### The store: a directory per run, one append-only log per agent

```
.jen/runs/<run>/
  run.json                  # run id, created, root agent id
  agents/<id>/record.json   # written once
  agents/<id>/state.json    # rewritten on transition
  agents/<id>/events.ndjson # appended, never rewritten
```

**It sits in the project folder and is gitignored.** ENG-194's tenet is that a project is completely contained in its project folder, and this keeps that true in the way that matters: zip the folder and the runs come with it, so a project is still reconstructible from its folder alone. What it gives up is the tenet read literally — all of it versioned. Transcripts are large and append constantly, and committing them would make every agent-run commit a wall of transcript and bury the source changes that are the point. Records are small and inert and could be versioned on their own; splitting the two was considered and rejected as two stores to keep in step for a benefit nothing needs yet.

One JSON object per line. Appending is one write; a JSON array would mean removing `]`, adding the event and rewriting it — O(size) per event, with a window between truncate and write where a crash loses the whole transcript. Ranges are line ranges, stable because the file only grows. A kill mid-write costs the last line and nothing before it.

The events stored are the runtime's own event objects, unchanged. The supervisor parses only enough to route and answer. So the transcript a parent reads and the one an agent resumes from are the same bytes.

**Nothing about the sandbox is stored, and nothing needs to be.** The container name, the workspace volume and the labels all derive from the agent id (`workspaceName` at `agent/sandbox/docker.ts:528`), which is already the directory name — so there is no mapping table to keep in step. `releaseWorkspace(agentId)` takes only the id. The record holds `workspace`, the mount path *inside* the container. A host path could not be stored even if it were wanted: `agent-sandbox` keeps container ids, image references and host paths off the interface, so the supervisor never sees one.

That is also right rather than merely forced. The protocol rides the runtime's stdio, so a container that outlives its supervisor has dead pipes and is unusable. There is nothing to re-attach to. Sweeping by run label and resuming from the store is the only correct move, and it needs no stored handle.

### Flush before the container is allowed to end

Events are appended as frames arrive. Before destroying a container as part of a suspension, the supervisor flushes and syncs that agent's log, and destroys only after the sync returns.

What this prevents is worse than a lost transcript. An agent resumed from a log missing its last steps does not fail — it repeats work it already did, or reports on work that is no longer there, and the result is indistinguishable from an agent that behaved. A sync costs microseconds against a teardown measured in hundreds of milliseconds, so there is nothing to weigh.

### Residency: a timer armed with the agent's number

`await` carries how long to keep the container. The supervisor arms a timer for that duration. A message first cancels it and the agent is answered where it stands; expiry first syncs the log and destroys the container, leaving the agent's state untouched so a later message boots it fresh. Zero means destroy now, and the runtime supplies zero where the agent asked for nothing.

A timer is not the forbidden heuristic. The number arrives in the frame, and the supervisor holds no default, minimum, maximum or adjustment of its own — a source-level test keeps a duration constant out of it.

### Termination: detected from state plus exit, delivered as a message

A container exiting while its agent's state says `working` means the agent died without speaking. The supervisor writes a message into the parent's mailbox naming the child and what is known of the exit — status and signal, which `Process.exit` already carries.

The message is marked as the substrate's, not the child's. A parent must always be able to tell a report of a death from a report by the deceased.

Delivery uses the same two paths as any message, so a parent on `await` is answered and wakes, and a parent mid-turn gets it at its next boundary. Turning failure into ordinary input is what lets the parent's weights choose between retrying, replacing, escalating and giving up — none of which the substrate should be choosing.

### Deadlock: a predicate over stored state

Every agent waiting and every mailbox empty. Checked after each state transition rather than on a poll, since a transition is the only thing that can create the condition.

Residency is deliberately not part of the condition. A timer only decides whether a body stays up; it can never produce a message, so a stalled tree is stalled whether or not one is armed. Waiting for timers to expire before reporting would delay the diagnosis and change nothing about it.

It is reported and nothing else happens. Breaking a deadlock is a judgment about the work.

### The sweep needs a fifth operation, and it must not touch workspaces

`SandboxDriver` has `create` and `releaseWorkspace`, and a `Sandbox` has `destroy`. None of them can end the containers of a run whose supervisor is gone. ENG-196 laid the groundwork — everything is labelled `jen.run` and `jen.agent` at creation, and `docker.ts:194` says the labels exist so a sweep can find what a run left — but the operation was never exposed. The supervisor cannot rebuild a `Sandbox` to call `destroy` on, because a `Sandbox` is live pipes and closures rather than data.

So the driver gains `destroyAll()`: end every sandbox belonging to this driver's run. It takes no argument, since the driver already knows its run, and it names nothing driver-specific.

**It must never release a workspace, and the naming has to carry that.** A sweep runs after a crash, which is precisely when every agent's work is sitting in a volume waiting to be resumed from. "Release everything belonging to the run" read literally would delete all of it — the exact mistake `agent-sandbox` split `destroy` from `releaseWorkspace` to prevent, arriving by a different door. Bodies are disposable and workspaces are not, and a run-wide operation is where that distinction is easiest to lose.

This is a fifth operation on an interface whose requirement says four and nothing further, so that requirement is modified rather than worked around. Working around it would mean reaching past the interface to the driver, which is the thing the interface exists to stop.

### Sandbox input becomes a stream, keeping the credential block's single write

`ExecOptions.input` becomes the *first* thing written rather than the only thing, and `Process` gains a standard input that stays open.

The property `agent-sandbox` paid for stays exactly as it is: the credential block and the caller's first input are concatenated and written as **one** write, so nothing interleaves and nothing arrives early. What changes is that the pipe is not closed afterwards.

Every pipe still needs its `error` listener, and the reason gets sharper: the writer is now the supervisor, which holds every other agent in the run. An unhandled `EPIPE` on one agent's stdin would end the whole tree. A failed write is reported to the caller and does not end the caller.

### The entry point becomes a peer; the loop gains an event sink

`main.ts` stops printing a result. It reads the boot frame, constructs a `Runtime`, then reads and writes frames until told to stop.

`Runtime` gains one thing: a callback invoked as each event is appended. The loop, the projection, the record and the capability surface are untouched. `events` stays as it is — the array is still the truth, and the callback only decides when a copy leaves the process.

Supervisor-backed capabilities are registered by `main.ts` as ordinary `Capability` objects whose `invoke` writes a request frame and awaits its answer. `dispatch` cannot tell them from a local one, which is what `capability.ts` was written to hold. This change registers none of them — it defines how one is built and leaves the set empty, as ENG-210 left the capability surface empty.

### Tests: a double driver and a scripted peer, plus a thin integration tier

Most of this is a state machine over stored data. It is driven with:

- **A `SandboxDriver` double** in the suite. Containers are objects, `exec` returns pipes the test holds both ends of, destruction is observable. No daemon, no images.
- **A scripted protocol peer** standing in for a runtime: emits frames from a script, records what it receives. No model calls. This is ENG-210's scripted model client, one layer out.

Together they cover routing, the store, the suspension state machine, the `answerInterrupted` collision, termination, deadlock and read authorization.

Two assertions are about real containers and cannot be faked, so they run against `DockerSandboxDriver` beside `sandbox/docker.test.ts` and inherit its need for a running runtime: that a fully dormant tree leaves no container running, and that a killed tree resumes from the store. The `docker ps` one is meaningless against a double, since the double decides what `docker ps` would have said.

A side benefit: the double is the first thing to exercise `sandbox/index.ts` as an interface. `agent-sandbox` notes that with one driver nothing can reveal an assumption that leaked through the seam, and holds it open by reading. A second implementor is better evidence than a careful reading.

## Risks / Trade-offs

**`answerInterrupted` quietly corrupting a resumed agent** → The sharpest failure here: wrong, silent, and plausible. Mitigated by stored state rather than inference, and by a test that suspends on `await`, resumes, and asserts the next request carries the delivered message and not the interruption text. For whoever changes this next: if suspension is ever made to work by writing to the log *after* booting, this comes back.

**The supervisor accreting judgment** → This is where "just add a small rule" will keep looking reasonable — a retry, a backoff, a default timeout, a cap. Each one moves policy somewhere no charter can reach. Mitigated by requirements written as prohibitions and by the source-level test for a duration constant. Not fully mitigable; the next few are prose and review.

**One writer per agent, assumed and unenforced** → `agent-sandbox` records that two concurrent `create` calls for one agent would each believe they made the workspace, and a failure then deletes the other's work. The supervisor is the caller that assumption is about. Provisioning follows state transitions and an agent is working or waiting, never both, so nothing holds two in flight — but nothing detects it either. Worth a note in `agent/supervisor/AGENTS.md` where the invariant is relied on.

**A context window fills and the parent is told the wrong thing** → Nothing here bounds a transcript's growth; ENG-194 puts context management out of scope, and the intended answer is that a parent dismisses a long-lived child and spawns a fresh one that reads the repo instead. Until a charter does that, an agent grows until the model refuses. The failure then walks a path worth knowing: the model call throws, nothing catches it, the runtime exits, and the supervisor reports exit-without-speaking to the parent. That degrades into a termination message the parent can reason about, which is the right shape — but it says `exit 1`, which is a poor diagnosis for what will be a common death. Distinguishing it is cheap and belongs with whoever next touches the model client.

**Line ranges as the read interface** → Simple and stable against an append-only log, but it leaks an implementation fact — that events are lines — to a caller that only wanted events. Accepted: the alternative is an index, and an index over an append-only file is a second thing to keep consistent at a scale that does not need it.

**Nothing automated covers any of this** → `agent-substrate` keeps the substrate out of CI, and this change makes nothing depend on it, so that still holds. The supervisor is the largest thing built there yet, and the integration tier additionally needs a running container runtime. Mitigated only by `agent/AGENTS.md` saying so, and by running both suites before merge.

## Open Questions

- **What "surfaced to the human" looks like for a stalled tree**, beyond a reported condition — a log line, an exit, something the eventual interface renders. It changes neither the specs, the state machine nor the task breakdown, and the interface that would consume it does not exist.
- **Whether a dismissed agent's workspace is released or kept.** `stop` is ENG-197's and `releaseWorkspace` already exists. Keeping it is the safe default until something asks otherwise, and the call belongs with whoever builds dismissal.
