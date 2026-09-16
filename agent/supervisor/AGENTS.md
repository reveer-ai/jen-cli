# The supervisor

The host process outside every sandbox, and the substrate's one non-homogeneous component.
It starts sandboxes, moves messages, and writes things down. It holds no reasoning, and
every behaviour it grows that an agent could have expressed instead is a policy moved out of
the weights and into code, where no charter can reach it. **It is the component to keep
smallest**, and the pressure to grow it will always look reasonable.

Run its tests with the rest of the substrate's — see [`../AGENTS.md`](../AGENTS.md). Most of
them need nothing but node. `containers.test.ts` is the exception and needs a running
container runtime, the same as `sandbox/docker.test.ts` and for the same reason.

### Three things `containers.test.ts` will catch you on

All three cost a debugging session the first time this tier was run for real, and none of
them announces itself — each one produces a tree that looks like it is working.

- **`add(record)` with no opening message boots nothing.** The agent is created already
  `waiting` with an empty mailbox, which is a perfectly good state and never becomes a
  container. A test that then waits for "every agent waiting" is satisfied instantly by a
  tree in which nothing has ever run, and only the container count says otherwise. Pass the
  opening — `add(record, 'Begin.')` — and wait on something a body had to have produced.
- **`aRecord`'s credential has to resolve or nothing provisions.** The fixture names
  `env:JEN_MODEL_API_KEY`, an unresolvable credential fails creation by design, and
  `record.model.credential` must be among `record.credentials`, so it cannot simply be
  dropped. The test supplies its own value for it; the peer is `sh` and authenticates to
  nothing, so only that it resolves matters. It goes on `process.env` because `harness.ts`
  is a separate process building its own driver.
- **A whole tree is never `waiting` at one instant, so do not wait for that.** A child ends
  its turn by reporting to its parent, and a report to a parent at a turn boundary begins a
  new turn — so the parent settles and is immediately woken again by its own child. Waiting
  for every agent to be `waiting` together waits for something that does not happen. Wait on
  the transcript instead: the event the agent appended is what "it continued" actually means.

## The collision the whole design is built around

`answerInterrupted` answers every capability call a log left outstanding, on every
construction. It has to: a provider rejects a message array with an unanswered tool call, so
doing nothing is not available.

**A deliberately suspended `await` and a process killed mid-call leave the log in exactly the
same shape** — a `tool_call` with no `tool_result`. Nothing in the log separates them. So a
naively resumed agent is told *"This call was interrupted by a restart…"* instead of being
told what arrived. It then reasons about a failure that never happened. **Nothing errors, and
the transcript looks fine.**

Two things follow, and both are load-bearing:

- **State is stored, not inferred.** `state.json` is the third file in an agent's directory
  for this reason alone. Inferring what an agent was doing from its log is precisely what
  cannot work.

  | Stored state | Log ends in | Means | What happens |
  |---|---|---|---|
  | waiting on a request | unanswered call | suspended on purpose | the answer is appended on delivery |
  | working | unanswered call | died mid-call | `answerInterrupted` does its job |
  | working | a complete step | died between steps | resumed, takes the next step |

- **The third row of that table only works because the boot frame carries it.** Rows two and
  three both say `working`, and the body is told so as `owed` on its boot frame — `#boot`'s
  second argument. A log ending at a complete step is a log at a turn boundary *and* a log of
  a turn whose end nobody heard, and the entry point cannot tell them apart: it used to try,
  answering both "wait", and the second sat in a live container having emitted nothing while
  every message addressed to it was held for a boundary it would never reach. `stalled` could
  not see it either, because it is about agents that are *waiting*. A silent, permanent hang,
  in exactly the window a `kill -9` on a process group opens.

  What `owed` does *not* close is a message delivered as a frame rather than into the log: it
  has left the mailbox and lives only in a running process until the agent's own `message`
  event comes back and is stored. Kill both ends inside that window and it is gone. This is
  the frame path's property wherever it is used — a resident agent's messages take it too —
  rather than something the dormant wake introduced, which is why it is not narrowed here for
  one case and left in place for the other.

  `owed` is not a flag meaning "was resumed", and the requirement forbidding one still holds:
  it is set for an ordinary delivery to a dormant agent, unset for a dormant agent woken at a
  boundary, and unset for an agent's very first boot — so nothing a body receives tells it
  whether it was ever interrupted. What it says is where the conversation stands, which is
  the stored state, which is stored rather than inferred for this exact class of reason.

- **The answer is appended to the log *before* the body boots.** `#answerInLog`. The runtime
  then constructs on a complete log and `answerInterrupted` finds nothing to do. This should
  read as ordinary rather than clever: for a supervisor-backed capability the supervisor *is*
  what produces the result — normally it sends it down the pipe and the runtime appends it,
  and when there is no pipe it appends the same value to the same place itself.

**If suspension is ever made to work by writing to the log after booting, this comes back.**
The test that notices is `suspend.test.ts`, "sends the model the message, and not the text
for a call that was interrupted". Remove the write-before-boot and everything else in this
directory stays green: the supervisor still suspends, still resumes, still delivers.

The call that gets answered is found in the log, not from a request id. The id belongs to the
runtime that raised it, and that runtime is gone.

## The sweep ends bodies and must never take a workspace

`destroyAll` runs after a failure, which is **exactly** the moment every agent's work is
sitting in its workspace waiting to be resumed from. Workspaces carry the same `jen.run`
label the sweep queries by, so the query that finds what to end is one word away from the
query that would find a day of every agent's work and delete it — through a call whose
purpose reads as tidying up.

Nothing in `index.ts` calls `releaseWorkspace`, including dismissal, where keeping the
workspace is the reversible choice and releasing it is not. `policy.test.ts` reads the source
for that, because a sweep that released workspaces would pass every assertion about ending
bodies.

## No period of the supervisor's own

Residency is the agent's number, carried on the frame it suspends with. **There is no
default, minimum, maximum, clamp or adaptive heuristic here and there must never be one** —
only the agent can know whether it is about to be woken in seconds or in a day, because it
has just decided what it dispatched.

A behavioural test cannot hold this: every test names its own number, so a default added here
would only ever apply where no test looked. `policy.test.ts` reads the source instead — no
binding that could be a duration, no number that could be one, exactly one `setTimeout`, and
its delay is the name the frame arrived under. All four were confirmed to fail by mutating
the source, which is the only way to know a source-level test is doing anything.

## Everything that changes state runs one at a time

`#serial`. **This is correctness, not throughput.** Every transition here is read the stored
value, change it, write it back — and each of those spans an `await`. Two interleaved on one
agent lose whichever wrote first: two messages posted to the same mailbox become one, and
nothing reports anything anywhere.

This was found by a test rather than by reasoning about it. Two `tell()` calls in flight
raced `state.json`'s write-and-rename and the second rename failed with `ENOENT` — which is
the *visible* half. The lost message is the half that would never have surfaced.

Only the outermost entry points queue, which is why the public calls are thin wrappers over
private ones: `add`/`#add`, `tell`/`#tell`, `resume`/`#resume`, `shutdown`/`#shutdown`.
**Anything reached from inside a queued task that queues again deadlocks** — `#spawning`
calls `#add` and not `add` for exactly this reason.

The store assumes one writer per run as a consequence, and `state.json.writing` is a single
predictable name rather than a unique one because of it.

## One sandbox at a time per agent, assumed and unenforced

`agent/AGENTS.md` records that two `create` calls for the *same* agent would each believe
they made its workspace, after which a failure in either takes the other's work with it.
**The supervisor is the caller that assumption is about.** Provisioning follows state
transitions and an agent is working or waiting and never both, so nothing here holds two in
flight — but nothing in the real driver would notice if that stopped being true, and it fails
by deleting data rather than by erroring.

`TestDriver` refuses a second creation in flight for one agent, which is where a path that
grew the ability to do it would find out.

## `stop` ends a subtree, not an agent

`#stopping` dismisses the target **and everything below it**, deepest first. A dismissed
agent's mailbox is never read again, so a grandchild left running holds a body, keeps working,
and keeps addressing a parent that has gone — every report it makes dropped, every `send` it
makes refused. Without the cascade, the one call whose purpose is to end an agent is the call
that leaks containers, and it leaks more of them the deeper the subtree; `resident` and the
sweep would be the only things that ever cleaned them up.

Dismissal keeps every workspace it reaches, at every depth. Releasing one is irreversible and
nothing has asked for it — whether dismissing an agent should release its workspace is ENG-197's
question, and it is recorded in `design.md` as open rather than answered here.

A dismissed agent is left in its parent's `children`, which is why `#sending` checks for
dismissal itself: routing passes for a dismissed child, and `#post` would drop the message
while the sender was told it was delivered.

## Only a request has somewhere to fail into

A request frame that fails is answered to the agent that made it — a result it can read and act
on. **An event or a turn frame has no such answer**: there is no id to attach a refusal to, and
the agent asked for nothing. What reaches there from one is the supervisor's own trouble, so it
goes to `onFailure` (standard error by default) and the channel carries on.

It is not tidiness. `#listen` is started as `void`, so a rejection escaping it is an unhandled
rejection, and under Node's default that ends this process — the one process holding every
other agent in the run. The same argument narrowed `Input` away from a `Writable` in
`sandbox/index.ts`. Anything added here that is reached from a body's channel needs somewhere
to fail that is not a rethrow.

## A half-written agent is one lost agent, never a lost run

`Store.open` skips an agent directory missing its record or its state and says so on standard
error, rather than throwing. `add` creates the directory, writes the record, then writes the
state, so a supervisor killed inside that sequence leaves exactly that shape — and a throw
there does not lose one agent, it loses the whole run: every other agent's record, state and
transcript, intact on disk and unreachable. Only absence is skipped; a file that is present and
unreadable still throws, because state is written by rename and a torn one is not a shape this
produces.

## The human is a participant, not an exception

The root's parent is the human. A message the root addresses upward reaches `onMessage`; a
message from the human comes back through `tell` and takes **the same path** a parent's
message takes, into the same position in the conversation. There is no separate human
channel, and adding one would make the root structurally different from every other agent —
which is the thing the whole substrate is arranged to avoid.

## What "surfaced to the human" means for a stalled tree is still open

`onStalled` reports the condition and the supervisor does nothing else: it wakes nobody,
messages nobody, terminates nobody. Breaking a deadlock is a judgment about the work.

What a caller should *do* with that report — a log line, an exit, something an interface
renders — is genuinely undecided, and the interface that would consume it does not exist yet.
The callback is the smallest thing that does not pre-judge it.
