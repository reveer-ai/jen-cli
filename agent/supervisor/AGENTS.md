# The supervisor

The host process outside every sandbox, and the substrate's one non-homogeneous component.
It starts sandboxes, moves messages, and writes things down. It holds no reasoning, and
every behaviour it grows that an agent could have expressed instead is a policy moved out of
the weights and into code, where no charter can reach it. **It is the component to keep
smallest**, and the pressure to grow it will always look reasonable.

Run its tests with the rest of the substrate's — see [`../AGENTS.md`](../AGENTS.md). Most of
them need nothing but node. `containers.test.ts` is the exception and needs a running
container runtime, the same as `sandbox/docker.test.ts` and for the same reason.

### Four things `containers.test.ts` will catch you on

The first three cost a debugging session the first time this tier was run for real and the
fourth cost a false alarm later, and none of them announces itself — each one produces a
tree that looks like it is working, or a change that looks like it is broken.

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
- **The transcript says an agent was woken, never what it was told.** The bullet above sends
  you to the transcript, and for "it continued" that is right — but `SHELL_PEER` answers a
  message with a fixed `charter` and `usage` event and never echoes the content it received,
  so two different messages are indistinguishable there and a delivered report is not in it
  at all. Asserting a particular message arrived — its wording, its recipient, that it
  arrived once — means reading `store.agent(id).mailbox`, and reading it *while it is there*:
  delivery drains the mailbox, so poll for it with `until` rather than looking afterward.
  Searching a transcript for the wording finds nothing and reads as a message that was never
  sent, which is the wrong bug to go looking for.

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
  | working, no body | either | its body ended and nobody has addressed it | given a body, `owed`, the moment anything is pending for it |

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

**Which outstanding call, though, is `at(-1)` — and that is a guess that is right once.**
`#answerInLog` answers the *last* unanswered `tool_call` in the log. For the first attempt at
a delivery that is not a guess at all: the agent suspended on the call it raised last, so the
last outstanding call is the one being answered.

The retry path is where it stops being true. A step that raised two calls — a `send` and then
an `await` — and was torn down before the `send`'s result was stored leaves *two* outstanding,
and a boot that failed and is being retried answers `at(-1)`, which is the `await`, with
whatever the retry is delivering. Delivered-once survives, because the restore is exact. Which
call was answered does not, and the log stays well-formed, so nothing complains and no test
fails. Three things have to stack to reach it — two calls in one step, a tear-down between
them, and a failed boot — which is why it was left rather than fixed.

**If a step is ever allowed to raise two supervisor-backed calls as an ordinary thing, this
stops being a corner.** The fix is to answer the call the stored state names rather than the
last one in the log, which means `state.json` carrying the request it suspended on — the same
answer as everything else here: store it, do not infer it.

## A request is answered by its own outcome, and a missing body is the parent's news

**Everything about this hangs on `#settle` being what every request ends with.** Eight call
sites reach it — `add`, `tell`, `resume`, a turn, `#awaiting`, `#sending`, `#spawning`,
`#stopping` — and it walks every agent. So anything that loop does to one agent, it does
inside every other agent's request.

`#deliver` rethrows when it cannot boot a body. **That is load-bearing and it stays**: the
message leaves the mailbox before the boot and the boot is what consumes it, so it puts the
mailbox back exactly and rethrows, and without that a daemon that blinked would cost a
human's instruction or a child's whole turn. What ENG-214 changed is the caller, not that.

Three rules, and each of them is a trap if you only remember the first:

- **The walk catches per agent and finishes.** One agent that cannot be provisioned costs
  that agent's delivery and nothing else. It used to throw out of the loop, which failed
  whichever request was in flight — a parent was told its `a-2` spawn failed because `a-1`
  had no body — and abandoned delivery to every agent ordered after the failing one in
  `ids()`.

- **A request is answered by what it asked for.** `spawn` answers with the child's id
  because the record and the parent link are written; `send` answers `delivered` because the
  message is in the mailbox. Neither ever claimed a body existed, so neither becomes a
  refusal when settling could not provide one. With `#settle` no longer throwing,
  `#listen`'s `ok: false` path is reached only by a request that was itself bad, which is
  what it was written for.

- **Reports are posted after the walk and never during it**, and the walk runs again if any
  were. This is the part that looks like needless ceremony and is not: a report goes into a
  parent's mailbox, and a parent that comes *before* its failing child in `ids()` would take
  it into a mailbox the pass has already gone past — so it would sit there until some
  unrelated later request came along, or, in a run that then went quiet, forever.

### `#unreachable` is memory, and the stall read needs it as much as the report does

A `Set<string>` on the supervisor, not a field on the record. An id goes in when delivery to
it throws and comes out the moment `#deliver` returns without throwing — **including the
early return**, which means nothing is queued and so nothing is stuck.

In the store it would be a fourth status, which makes "unreachable" something an agent *is*
and needs a way back out that nothing has asked for. Here a restarted supervisor earns the
mark back by trying, which is right: its parent has just been rebooted along with everything
else.

It holds down noise — one message to a parent per outage rather than one per request that
settles during it — but **the stalled getter needs it for a separate reason**. "Has mail and
no body" describes every dormant agent settling is about to wake; only "we tried and it
failed" picks out a stuck one. So a marked agent's mailbox reads as empty there, and a tree
stopped by an agent nobody can provision says so instead of looking like a working one.

### `working` with no body, and the one thing that resolves it

The last two rows of that table say `working` and hold no body, and until ENG-216 that was a
state with no way out. `#deliver` returned early on anything that was not `waiting`, so no
message could ever be given to such an agent — and `#ended` leaves the stored state alone on
purpose, so that is exactly where a killed body leaves its agent. Its parent was told and
could replace it or give up; the obvious answer, telling the child to carry on from a
transcript and a workspace both sitting there intact, was the one answer unavailable.

**An agent with no body gets one when somebody addresses it.** That is `resume()`'s rule —
boot every `working` agent with `owed: true` and let it continue — applied at delivery
instead of at recovery. Nothing in that reasoning was ever peculiar to a supervisor starting
up: an agent recorded working is owed a step whether its body was lost to a restart, a
signal, an OOM, a daemon that went away, or a turn that failed inside it. The state stops
being reachable-only-at-recovery, and it stops being a tombstone for **every** cause rather
than for whichever one was last found.

What is pending stays pending. An agent continuing an unfinished turn is not at the boundary
where a message begins one, so the revival takes nothing out of the mailbox and writes
nothing to the store — which is also why that branch needs no restore where the `waiting`
path does: a failed provisioning leaves the store exactly as it found it.

**Mail is what triggers it, and nothing else does.** A settle does not walk the run reviving
what it finds, and this is a judgment rather than an optimisation. Whether to retry a child
that stopped is the parent's decision — it is why `#ended` reports the ending instead of
acting on it — and reviving unbidden would move that judgment into this file, where no
charter can reach it.

**Mail-triggering is not on its own what bounds it, and reading it as though it were is the
mistake this paragraph used to make.** What it rules out is a settle reviving an agent
nobody asked about. It does not rule out one instruction being re-read as a new one: the
revival leaves its message pending, so that message is still at the head of the mailbox when
the new body dies, and `#ended` → `#settle` → `#deliver` arrives back at the same branch and
boots again. An agent that dies whenever it is given a body is given one forever — with one
parent message standing behind all of them rather than nobody, which costs the same. Each
turn of it is a sandbox created, a boot, a model call, and another substrate report posted
into a parent that is awake and spending a turn on each one. And the stall read stays silent
throughout, because the message driving the loop reads as work about to happen. Measured on
the double before it was bounded: 284 bodies in three seconds from a single `Carry on.`

**A revival answers the message that caused it, so a further revival wants a further
message.** That is the bound, and it is `#revived` — a set of the agents already given a
body for the mail they are still holding. An id goes in when a body is actually provisioned
for a bodiless agent, and comes out when anything is posted to that agent, which is a second
decision buying a second body, or when the revived body reaches a turn boundary, having got
somewhere. A revival that could not be provisioned takes no mark: no body was made, and
`#unprovisioned` has just promised the parent the message will be delivered when the agent
can be provisioned again. There is no counter in it and no timer, and "what is pending stays
pending" is untouched — the bound is on how many bodies one message buys, not on the
message.

**The stall read has to agree, or the bound is the same silent stall in a different coat.**
An agent that will not be revived again is not made able to move by mail sitting in its box,
so `#cannotMove` reads a marked agent's mailbox as empty exactly as it does an unreachable
one's. The two marks stay separate because they mean different things to `#unprovisioned`:
`#unreachable` is "no body and no way to get one" and is cleared by `#settle` on any
delivery that does not throw, the refused revival included; `#revived` is "already answered
with a body", which that clearing is not about and must not clear.

### The report cannot be `#ended`'s wording, and cannot be `onFailure`

It goes to the agent's parent as a substrate-marked message through `#post`, so a root's
reaches the human with no special case. Two readings would each do harm and the wording
rules both out explicitly:

- **Not a death.** The agent is still addressable and whatever it has done is kept, and a
  parent that read it as an ending would replace a child that is about to wake up fine. It
  says only that much because it has two callers now: an agent being woken for the first
  time has indeed not started and not ended, and an agent whose *revival* could not be
  provisioned has done both.
- **Not a loss.** What was queued is still queued and will be retried. A parent that
  concluded its message had gone would send it again, waking the child to two copies of its
  instruction.

`onFailure` is for the supervisor's own trouble — a store that could not be written, a
channel that broke — which is to say what no agent can act on. A child with no body is
something its parent can act on, and choosing between retry, replace, escalate and give up
is the parent's, exactly as it already is for `#ended`.

### `resume` has the same shape and cannot borrow the retry

`#resume`'s boot loop catches per agent for the same reason, and reports by the same path.
But its agents are `working` rather than waiting on mail, so **nothing is queued for a later
settle to try again** — the recovery is repeated by calling `resume()` again, which is why a
failed agent's stored state is left exactly as it was.

Setting those agents back to `waiting` so ordinary delivery would retry them is the obvious
move and it is wrong: a `working` agent is owed a step, and the next message would reach it
as a fresh turn on a log that ends mid-step.

### There is no bound on the retry, deliberately

A dead daemon means one failing `create` per agent with mail, on every settle. A backoff, an
attempt ceiling, or an unreachable state to park an agent in would each be policy in code,
which is what this component exists to keep out. Whether the cost is real is a question for
ENG-199's run rather than for a constant in this file.

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

### `#shutdown` is on this queue, and the queue outlives it

Which is the part that catches you: **the ending is a task like any other, so everything
already queued behind it still runs afterwards, over a run that is finished.** A residency
timer that has fired is past `#disarm`; a frame read off a body's channel a moment before
that body was destroyed is already in the queue; `add()` and `tell()` queue from outside the
supervisor and know nothing about it. The shutdown's walk is a sync and a destroy per body —
seconds each against a real daemon — so the window is wide by construction rather than a
race you have to be unlucky to hit.

What those late tasks find is the shutdown's *own* work. Every message it put back is at the
head of a `waiting` agent's mailbox, so a settle from one of them reads a run with work to do
and boots a fresh sandbox for an agent nobody is coming back to — a container outliving its
run, through the action a person takes to stop for the day.

`#closing` is the bound and `#settle` is where it is spent, once, rather than at each of the
eight callers that end in one. **If you add a path that provisions without settling, it needs
its own** — `resume` is the only one today, and it is exempt because it is a caller
deliberately taking a run up rather than work arriving late. The corresponding trap when
writing a test: a body destroyed inside `beforeDestroy` holds the whole walk, which is how
both tests in `suspend.test.ts`'s closing-run block open this window on purpose instead of
racing for it.

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
nothing has asked for it. ENG-197 settled the question that used to be recorded here as open:
a dismissed agent keeps its workspace, because whatever it built may be exactly what its parent
dismissed it for, and a `stop` that deleted a subtree's work would be the one call whose purpose
is to end an agent doing something no request asked for.

The grant that permits a `stop` is read at `#request` rather than here — see below, where the
rule that covers every kind is.

A dismissed agent is left in its parent's `children`, which is why `#sending` checks for
dismissal itself: routing passes for a dismissed child, and `#post` would drop the message
while the sender was told it was delivered.

## Every request kind reads the caller's record, once, at the channel

`#request` refuses any frame whose kind the caller's record does not name, above every
handler and above anything that writes. There is no per-handler copy of it and there must not
be one: a rule enforced in some handlers and not others is reachable by exactly the actor it
was written for, since an agent hand-writing a raw frame only has to find the handler that
forgot. `read` is gated by this although ENG-212 declares it — that is the rule doing what it
was written generically for, not scope creep.

**The check is second, and the order is the part to get right.** Above it sits `ROUTABLE`,
which asks whether anything routes this kind at all. A record never names a kind that does not
exist, so a grant check placed first answers a typo with "your record does not grant `sned`",
which sends an agent to fix a grant when what it has is a spelling mistake.

`ROUTED` is one list and the switch below is typed from it, so a name added without a case
fails the typecheck and a case for a name that is not in the list cannot be written. Adding a
kind is that one name, one case, and no check.

**This is the second of two places a grant is read, and both stay.** The runtime offers an
agent only what its record names; the supervisor reads the record again here, because only one
of the two is on the path a raw frame takes.

What a refusal no longer says is "so nothing was spawned". The guarantee it carried is held by
the check's *position* instead — nothing is written above it — and `spawn.test.ts` pins that
by asserting no record, no parent link, no mailbox and no body after a refused spawn. Do not
move the check below anything that writes to recover the wording.

Withholding narrows an agent rather than silencing it, which is what `spawn`'s tool
description promises the model choosing a child's grant: an agent with no `send` still reports
to its parent when its turn ends, because reporting at a turn boundary is not a capability and
cannot be withheld. A change that made turn-end reporting require a grant would make that
description a lie told to the party making the decision.

## The mark position belongs to the substrate

`render()` puts one mark at the front of every delivered message: `[from <id>]` for an agent,
`[from the human]` for a message with no sender, `[substrate]` for the substrate's own report
of an agent's ending. A parent holding four children has four conversations in one mailbox,
and the mark is the whole of what tells them apart.

**Agent-authored content is escaped into that position**: a leading `[` becomes `\[` before
the mark is prepended. A child that opens its report with `[substrate] ...` — quoting a message
it was itself sent, which is how a confused agent reaches this rather than a hostile one —
would otherwise be read by its parent as a death. The substrate's own report is not escaped,
which is why the escape is applied at `render()` rather than wherever a message is posted.

**What makes that safe is the position, not the authorship.** A termination report carries the
tail of the ended body's standard error, so part of it *is* agent-authored — but always behind
`<id>'s body ended: `, and `unmarked` guards position 0 alone. Widening the escape past that
position would have to revisit the unescaped branch in `render()` rather than keep it.

**A mark-shaped string in the middle of a message is deliberately not escaped.** Escaping every
occurrence mangles any message that legitimately discusses the substrate's output, including a
parent asking a child about a report it received, and a model is a reader rather than a parser
— so a determined child could still mislead a careless parent. The threat model this epic
states is a confused agent, and the confused case is the leading-quote one. If that ever stops
being the threat model, the answer is not a wider escape at this seam.

Attribution is rendered here and carried nowhere else. `MessageFrame` and `AnswerFrame` do not
grow a `from`, and the `message` event in a transcript keeps `from: 'parent' | 'self'` — which
answers "were these my own words", a different question from which agent spoke. The model reads
text at the end either way, so carrying it structurally buys no integrity and puts message
formatting inside the runtime, whose whole property is being byte-identical everywhere.

## Only a request has somewhere to fail into

A request frame that fails is answered to the agent that made it — a result it can read and act
on. **An event or a turn frame has no such answer**: there is no id to attach a refusal to, and
the agent asked for nothing. What reaches there from one is the supervisor's own trouble, so it
goes to `onFailure` (standard error by default) and the channel carries on.

**Narrower than it used to be, and narrower by exactly one class.** A body that could not be
provisioned reached here too, and no longer does — it is the agent's parent's business now,
and settling catches it before it gets this far. What is left is a store that could not be
written and a channel that broke: the things no agent can act on, which is what this
destination was always for.

**That sentence is only true because the catch is typed.** `#settle` catches
`UnprovisionedError` and rethrows everything else, and `#boot` constructs one around the
driver's own two calls and nothing else — so the `#store.transcript` read between them, and
the `#store.save` that `#deliver` makes before it ever reaches a boot, still arrive here. A
catch written as a bare `catch` in that loop reads as the same change and is not: a failed
write would come out of it as `<id> could not be given a body: …`, posted to a parent that
has no reach into the machine, marked unreachable so the stall read discounts its mail, and
never heard by this hook at all. If the typed catch ever goes, this paragraph goes with it.

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

**`ENOENT` is not the only code a thing that is not an agent answers with, and the other one
is reachable by accident on this platform.** The skip above tests for absence. An entry under
`agents/` that is present but is not a directory — a `.DS_Store`, which macOS writes into any
folder someone opens in Finder — makes `readdir` return its name and the read of
`agents/.DS_Store/record.json` fail with `ENOTDIR`, not `ENOENT`. That throws, and the outcome
is the one this whole section exists to prevent: the run is unopenable and every intact
transcript goes with it. Confirmed by reproduction, not reasoning.

So the door this closes is the one a killed supervisor opens, and there is a second door next
to it that a file browser opens. Widening the skip to cover a non-directory entry is the
narrow fix; iterating only the entries that are directories is the better one, because it
stops asking what went wrong and starts asking what an agent is.

## The human is a participant, not an exception, and `human` is the name

The root's parent is the human. A message the root addresses upward reaches `onMessage`; a
message from the human comes back through `tell` and takes **the same path** a parent's
message takes, into the same position in the conversation. There is no separate human
channel, and adding one would make the root structurally different from every other agent —
which is the thing the whole substrate is arranged to avoid.

**Upward from the root needs a name, because a human has no agent id.** `#sending` routes on
a parent pointer and a list of children; the root's pointer is `null` and no string is equal
to `null`, so until this was resolved, a root granted `send` could reach its children and
nothing else — and was told so in the words *"is neither your parent nor one of your
children"*, the substrate contradicting the paragraph above. The name is `HUMAN`, exported
from `index.ts`, and it is **vocabulary rather than topology**: `#sending` turns it into the
`null` that `#post` has always taken, so nothing below the request boundary learns a second
way to say who the human is.

Only the root can mean it. For any other agent `human` is a string matching no relation it
holds and is refused like any other stranger, and a child's id is its parent's plus a `-`, so
no agent can be addressed by that name either. Two things follow for anything changing this:
the refusal a root gets must keep naming `human` — a root that cannot find the word is a
chief that cannot say anything to a person until its turn ends — and the resolution stays
above `#post`, not inside it, because `#post`'s other caller is a termination report whose
`null` is the tree's and not an agent's word.

**The human's is the one path a message reaches by without passing through `render()`.**
`#deliver` renders for every agent recipient; `#post`'s `null` branch hands `onMessage` the
raw `Message`. So at that seam the sender's mark is absent and, more to the point,
`unmarked()` never runs — the escape that exists so a child opening its report with
`[substrate] ...` is not read as a death. A human interface that prints `message.content` is
a person reading a root's quoted `[substrate] a-1's body ended: exit 137` as the substrate
reporting one, which is the same forgery the escape prevents everywhere else, at the one
recipient who cannot ask the substrate a follow-up question. `render()` is exported and
getting it right is one call — so a consumer of `onMessage` renders what it is handed, and
the supervisor's own default does exactly that rather than printing the content bare.

## What "surfaced to the human" means for a stalled tree is still open

`onStalled` reports the condition and the supervisor does nothing else: it wakes nobody,
messages nobody, terminates nobody. Breaking a deadlock is a judgment about the work.

What a caller should *do* with that report — a log line, an exit, something an interface
renders — is genuinely undecided, and the interface that would consume it does not exist yet.
The callback is the smallest thing that does not pre-judge it.

**The read is one condition and covers three shapes.** An agent cannot move when it has
nothing to act on — an empty mailbox, or mail that cannot be delivered because nothing can be
provisioned for it — **and** it is not working in a body. That last clause is what counts an
agent whose body ended and that nobody has addressed, and it is the backstop for this whole
class: it holds whatever stopped that agent, including causes nobody has found yet. Before
it, `stalled` required every live agent to be `waiting`, so one body that died and whose
parent did not happen to `stop` it made `onStalled` unable to fire for the rest of the
session — the detector disabled by exactly the event it exists to catch.

**What is reported names the stopped agents apart from the waiting ones**, because the two
ask different things of the person reading. A tree of nothing but waiting agents is the
ordinary deadlock, usually a question somebody can answer. An agent whose body ended, or one
that cannot be provisioned at all, is the cause rather than a participant — and a report
that listed it among the waiting would name everything except the thing to look at.
`describeStall` is exported so the operator and the supervisor's own default say it the same
way.

**A root waiting on a person it has actually messaged reads as stalled, and that is new.**
`stalled` counts such a root as unable to move; a root that calls
`send(HUMAN, …)` and then `await()` is exactly that, because the message left the tree and the
reply — if one is coming — is a human's to send with `tell`. Before upward `send` existed no
agent could put a question where only a person could answer it mid-turn, so every stall was a
tree that could not move on its own. Now one shape of stall is a tree that is moving correctly
and waiting for the party it just addressed.

Do not "fix" this by excluding such a root from `stalled`. The condition is still reported
truthfully — nothing in the tree can produce that message — and suppressing it would hide a
root whose message went to an `onMessage` nobody is reading, which is the more likely failure
while the interface is a line on standard error. It is the *caller* that has to tell the two
apart, and it can: the report names who is waiting, and a root among them means ask the person.
Whoever builds the interface this section says is still undecided owns that distinction.

### What the unbounded retry costs, measured

The question the section above defers to ENG-199's run, answered by that run. Measured
against a driver pointed at a `docker` that does not exist, with every agent in the tree
holding mail it cannot be woken for:

| tree | attempts while building it | attempts idle for 3s | one settle afterwards |
|---|---|---|---|
| 10 agents | 110, over 1.4s | **0** | 10 attempts, 138ms |
| 30 agents | 930, over 11.4s | **0** | 30 attempts, 378ms |

**Nothing happens while nothing happens**, which is the half that decides it. There is no
timer anywhere here: `#settle` runs on `add`, `tell`, a turn ending, an `await`, a `send`, a
`stop`, a body ending, and `resume()`, and on nothing else. A tree that has stopped against a
dead daemon costs exactly zero until somebody does something. So there is no hot loop to
bound, and a backoff would be a constant slowing down a thing that is not running.

The cost per event is one failing `create` per agent with mail — about 13ms each, which is
what a process that cannot be started costs — and the one number worth knowing is the
**doubling**, which belongs to the settle loop rather than to the retry. A pass that produces
a new report walks the tree again after posting it, so a settle over a *newly* unreachable
tree costs two attempts per agent rather than one. Building a tree of 30 that way is
2 × (1+…+30) attempts, quadratic in the size of the tree, and it is paid while a person is
watching a tree fail to start rather than in the background.

None of that is a reason for an attempt ceiling or an unreachable state to park an agent in,
and both would still be policy in code. If this ever does need bounding, the thing to bound
is the second walk — which is a settle question and not a retry one.
