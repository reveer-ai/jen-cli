## Why

The sandbox holds an agent and the runtime is the agent, and nothing connects one to another. ENG-196 built the body, ENG-210 built the mind, and both were deliberately built as if the thing that starts them did not exist yet. It does not. This change builds it.

Spawning, routing and sandbox lifecycle have to live somewhere, and there are three places they could go. The supervisor is the third, and it is worth writing down why the other two lose, because only one of the arguments is about homogeneity and the proposal is weaker if it rests on that one alone.

**A parent could service its children's spawn calls.** A child raises `spawn`, the request goes up, and the parent's runtime creates the container. Then ask who services the *root's* spawn: the root has no parent, so its runtime needs a path none of the others use. That is the agent nobody spawned holding something a spawned agent lacks, and "sub-agent" has become a kind rather than a relationship — which is the one thing ENG-194 says any design must not do.

**Every runtime could hold the container socket and provision its own children.** This one is homogeneous. Root and depth-three would create sandboxes by identical code, with no broker anywhere, and ENG-194 is explicit that it was a real alternative and not obviously wrong. It loses on two counts that have nothing to do with symmetry. Mounting the container socket into every sandbox hands every agent at every depth trivial host root, which is strictly worse than mounting a host directory — and the threat model here is not a hostile agent but a *confused* one, for whom a sandbox that can be stepped out of is decorative. And it forecloses suspension outright: if a parent owns its children's lifecycle, the parent's container must stay alive as long as any descendant might still run, so nothing can ever go dormant and the economics this change exists for evaporate.

**So the capabilities live outside every agent, and every runtime only ever asks** — raises a request on a pipe and blocks, with every piece of machinery that could honour it on the other side of a boundary the agent cannot reach across. The supervisor is that somewhere. It costs one non-homogeneous component, paid deliberately, and it is the component to keep smallest — which is why it holds no reasoning and why every trace of judgment is kept out of it.

It is also where the epic is proven or broken. Suspend and resume is the decision the whole economic argument rests on: in a tree, every ancestor of every working agent is idle by construction, so a substrate that keeps idle agents resident scales containers with the shape of the org chart rather than with the work. If that mechanism feels right here, the rest is plumbing.

## What Changes

- **A new top-level `agent/supervisor/`**, a host process outside every sandbox. It holds no reasoning: it starts containers, moves messages, and writes things down.

- **The supervisor protocol** — JSON lines over the runtime's standard input and output, the channel `runtime/boot.ts` already leaves open after reading its boot frame. The runtime raises a request and blocks; the supervisor answers on the same channel. The request kinds themselves (`spawn`, `send`, `await`, `stop`, `read`) are handled here; the agent-facing capability objects that raise them are ENG-197's and ENG-198's.

- **Mailboxes and routing.** One mailbox per agent, addressed by id, parent↔child only. Routing is a parent pointer and a child list — there is no graph, so there is no router.

- **The record and transcript store**, durable and outside the container. Events are appended **as they happen** rather than collected and written at the end, because the transcript is what a reboot reads and an agent that died mid-turn must not lose the steps it took.

- **The suspend/resume loop.** A suspended agent's container may exit; when a message lands in its mailbox the supervisor boots a fresh container from the record and the stored log, and the agent continues as though the call returned. The runtime already makes this possible — `agent-runtime` requires a resumed agent to be byte-identical to an uninterrupted one — and this is the change that exercises it.

- **Residency is named by the agent, in a duration.** A suspension carries how long the agent wants its body kept up before it is torn down; the supervisor holds no grace period, idle constant or heuristic of its own. A chief that just dispatched four fast children names sixty seconds and pays no container boot on the wake; a chief waiting on a day of work names zero and costs nothing meanwhile. The binary that ENG-213's description offered as one option is the two endpoints of this, which is why a duration is what is built: it covers both cases without the agent having to guess which one it is in, and *weights decide, code constrains* is satisfied either way only because the number is the agent's.

- **Termination synthesized into the parent's mailbox.** A child that dies produces nothing, so a parent suspended on a message that will never arrive waits forever and nothing notices. The supervisor detects exit-without-speaking and posts a message saying so. Failure becomes ordinary input the parent can reason about, which is the weights-native handling.

- **Orphan sweep by run.** Sandboxes are marked with their run at creation and swept by that marking, which covers the case that actually leaks: a supervisor killed with sandboxes live. The sweep ends bodies and never touches a workspace — it runs after a failure, which is precisely when every agent's work is sitting in one.

- **Deadlock detection.** Every agent suspended with nothing pending is a stalled tree. It is a read of the mailbox state, and it is surfaced to the human rather than resolved — resolving it would be the supervisor exercising judgment.

- **Serving transcript reads.** The supervisor holds every transcript, so `read` is a query against the store plus one authorization rule — the target must be a descendant of the caller — and it pages rather than returning all or nothing.

- **BREAKING — the sandbox gains a fifth operation: end every sandbox of a run.** ENG-196 marks everything with its run at creation and says in source that the marking exists so a sweep can find what a run left, but never exposed the operation, and a supervisor that was killed holds no handle to destroy anything with. The sweep ends bodies and leaves every workspace — it runs when an agent's work is least recoverable, and "release everything belonging to the run" taken literally would delete all of it.

- **BREAKING — a process's standard input stays open for the life of the process.** `agent-sandbox`'s `exec` writes the caller's input once and closes it (`docker.ts:165`), which was right when the only thing to say was a boot frame. A protocol is a conversation, and there is no supervisor at all if the supervisor cannot answer. `Process` gains a writable standard input; the credential block and its ordering guarantee are unchanged.

- **BREAKING — the runtime's entry point speaks the protocol rather than printing a result.** `runtime/main.ts` today runs one turn and writes `{ message, events }` on exit. That shape cannot append a transcript as it happens, cannot raise a request mid-turn, and cannot suspend without ending the agent. It becomes a protocol peer.

## Capabilities

### New Capabilities

- `agent-supervisor`: The host process outside every sandbox — the line protocol it answers on, mailboxes and parent↔child routing, the durable record and transcript store, the suspend/resume loop with residency named by the agent, synthesized termination, orphan sweep by run label, deadlock surfaced rather than resolved, and authorized ranged transcript reads.

### Modified Capabilities

- `agent-runtime`: The entry point becomes a peer on the supervisor's protocol instead of a program that prints a result and exits. Events are emitted as they occur rather than at the end of the turn, and a turn's end and a suspension are frames on that channel rather than process exit. The reasoning loop, the projection, the record and the capability surface are untouched.
- `agent-sandbox`: A process's standard input stays open for the life of the process, so a caller can converse with it rather than send one thing. Everything the existing credential requirement establishes — nothing on a command line, nothing written to disk, the block arriving first and intact — is preserved. The interface also gains a fifth operation, ending every sandbox of a run without a handle on any of them, which is what an orphan sweep needs and what the existing four cannot express; the requirement holding the interface to four operations is modified rather than worked around.

## Impact

**Code.** New `agent/supervisor/`. `agent/sandbox/index.ts` and `agent/sandbox/docker.ts` change `exec`'s contract from a one-shot `input` string to an input that stays writable and gain the run-wide sandbox release; `agent/runtime/main.ts` is rewritten as a protocol peer. `agent/runtime/index.ts` gains a way to emit events as they are appended — the loop and the projection are not otherwise touched.

**Dependencies.** None. The supervisor drives the container runtime through the existing sandbox driver and speaks its own protocol over pipes; a broker, a port, a daemon or a message bus would each be the heavy fabric ENG-194 rules out for a project with tens of agents rather than thousands.

**Scope, and why the tests can still run.** The agent-facing capability objects belong to ENG-197 (`spawn`) and ENG-198 (`send`/`await`), both of which are blocked by this change. So the supervisor's protocol is driven in test by a scripted peer standing in for a runtime — the same instrument ENG-210 used for the model client, and the thing that lets this change's own acceptance tests run here rather than waiting for ENG-199. The sandbox is reached through its interface, so the supervisor's own logic is driven against a test-double driver defined in the suite and needs neither a container runtime nor a model — which also gives `agent-sandbox`'s interface the independent exercise it has never had, exactly one driver having existed until now. The assertions that are about real containers — that a dormant tree holds none, that a killed run resumes — are integration tests against the container driver, and the epic's claim that ENG-196 left an in-process driver behind is stale: it shipped one driver, and the spec closed the set at one.

**Downstream.** ENG-197 and ENG-198 add request kinds' agent-facing halves to a protocol this defines. ENG-212 reads transcripts through the `read` this serves. ENG-199 is the acceptance run over all of it.

**Not here.** No capability implementations, no recursion bounds, no network policy, no context management, and no wiring into jen's dispatcher or CI — `agent-substrate` keeps the substrate outside the repository's checks, and this change does not make anything depend on it.
