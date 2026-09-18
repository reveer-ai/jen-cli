## Context

See `proposal.md` — Why. The mechanics that shape the approach:

- `#settle()` walks `store.ids()` calling `#deliver(id)`, then reads `stalled` and reports it. Eight
  call sites end in it: `add`, `tell`, `resume`, a turn, `#awaiting`, `#sending`, `#spawning`,
  `#stopping`.
- `#deliver(id)` does nothing unless the agent is `waiting` with a message queued. If it acts and the
  agent has no body, it boots one; if that boot throws, it puts the mailbox back exactly as it found
  it and rethrows. **The restore is load-bearing and stays** — without it the message is in no
  mailbox, no log and no process.
- `#ended` already turns a lost body into a message in the parent's mailbox. The substrate can
  already say *your child is not going to speak*, and already leaves what to do about it to the
  parent.
- `#post(null, …)` is the human: the root's parent, reached by the ordinary path.
- All of it runs inside `#serial`, one at a time.

## Goals / Non-Goals

**Goals:**

- One agent's failure to get a body costs that agent's delivery and nothing else.
- Every failure to provision reaches someone who can act on it, once per outage.
- A tree that has stopped because of one says so.

**Non-Goals:**

- Changing `#deliver`, the protocol, the record, or the store's shape.
- Telling kinds of provisioning failure apart. A dead daemon, a missing image and an exhausted quota
  are one thing here: no body.
- Any retry schedule. Attempts happen when settling happens, which is when there is a reason to try.

## Decisions

### Collect failures during the walk, report after it

`#settle` catches per agent, records the failure, and carries on. Reports are posted once the walk
has finished, and the walk runs again if any were.

Posting during the walk is simpler and wrong: a parent that comes before its failing child in
`ids()` would take the report into a mailbox the walk has already passed. Nothing would deliver it
until some unrelated request came along — or, if the run went quiet, at all.

Running again terminates, because a marked agent produces no second report. Each pass after the
first has fewer agents left that can produce one, and the run is finite.

*Alternative — one extra pass instead of a loop.* Slightly easier to read, and it drops a report
when delivering that report is itself what fails. A loop costs a `while` and handles the cascade.

### A request is answered by its own outcome

Nothing settling does reaches the answer. `#spawning` answers with the child's id once `#add` has
written the record and the parent link; `#sending` answers `delivered` once the message is in the
mailbox; a turn ends because the turn ended.

That is what retires the proposal's first consequence rather than handling it: with `#settle` no
longer throwing, `#listen`'s `ok: false` path is reached only by a request that was itself bad,
which is what it was written for.

*Alternative — answer the caller and append the trouble.* Rejected. `spawn` answers with an id the
caller will use as one and `send` with a confirmation; appending news of an unrelated agent puts
trouble in front of someone who cannot act on it, in a field meant to hold one thing.

### The parent is told, on the same terms as a death

A substrate-marked message in the parent's mailbox, naming the agent and what went wrong — the
destination and shape `#ended` already uses. The root's parent is the human, so `#post(null, …)`
carries it out of the substrate with no special case.

It also says the queued messages are still queued and that delivery will be retried. Without that,
the parent's fair reading is that its child's opening was lost, and the fair response to that is to
send it again — so the child wakes to two copies of its instruction.

*Alternative — `onFailure` only.* That hook is for what no agent can act on: a store that could not
be written, a channel that broke. A child with no body is the parent's business — retry, replace,
escalate, give up — so sending it to the operator instead would be the substrate deciding the parent
has nothing to decide. It also loses the root case, where the parent *is* the human.

*Alternative — reuse `#ended`'s wording, for one report path and no new vocabulary.* Leaner, and
untrue: the agent did not terminate, it never started, and it is still queued and addressable. A
parent that believed "terminated" would replace a child that is about to wake up fine.

### The mark is memory, not state

`#unreachable: Set<string>` on the supervisor — the agents whose last delivery attempt threw. Added
on a failure, removed whenever `#deliver` returns without throwing, including the early return,
which means nothing is queued and so nothing is stuck.

It is not in the store and not in `StoredAgent.state`. Nothing branches on it but the report and the
stall read, and a supervisor that restarts earns it back by trying. In the record it would be a
fourth status, making "unreachable" something an agent *is* — and that needs a way back out that
nothing has asked for.

It is also what the stall read needs, independently of the report: "has mail and no body" describes
every dormant agent settling is about to wake, so only "we tried and it failed" picks out a stuck
one.

### Undeliverable mail does not hold off the stall report

`stalled` treats a non-empty mailbox as work pending, on the grounds that delivery will wake
someone. Where delivery is what failed, that is untrue — so a mailbox belonging to a marked agent is
read as empty for that check.

This is the backstop for a parent that was told and did nothing: the human hears that the tree has
stopped, by the path that already exists for it.

### `resume()` reports and stays re-runnable

`#resume`'s boot loop has the same bare shape, so one agent that cannot be provisioned aborts the
rescue of everything after it. Same fix: catch, carry on, report to the parent.

It cannot borrow the retry, because its agents are `working` rather than waiting on mail — nothing
queued means nothing for a later settle to try again. So their stored state is left untouched, which
makes `resume()` idempotent over them: fix the daemon, call it again, and it boots what it could
not. The parent has been told meanwhile, and can `stop` an agent whose work is not worth rescuing.

*Alternative — set them back to `waiting` so ordinary delivery retries them.* Rejected: a `working`
agent is owed a step, and the next message would reach it as a fresh turn on a log that ends
mid-step.

## Risks / Trade-offs

- **A dead daemon means one failing create per agent with mail, on every settle.** → Bounded by
  agents with something queued, and each attempt fails fast at the socket. A ceiling or a backoff
  would be policy in code. ENG-199 is the first run that will show whether the cost is real.

- **A parent may read "could not be provisioned" as "my child is dead"** and spawn a replacement,
  leaving the original queued and addressable. → The message says otherwise in as many words, and
  `stop` is the parent's to call. Past that it is the parent's judgment, which is where this
  substrate puts it.

- **An agent that flaps produces a report per episode.** → Each one is a real transition; the mark
  only stops repeats within a single episode.

- **The mark is per-supervisor**, so a restart while an agent is unreachable re-reports it once. →
  Right for a parent that has just been rebooted along with everything else, and the alternative is
  durable state this deliberately does not have.

## Migration Plan

None. No stored shape changes, nothing new persists, and the supervisor has no consumers outside its
own tests yet.

`spawn.test.ts`'s final `describe` and the matching section of `agent/supervisor/AGENTS.md` state
today's behavior so a deliberate change fails rather than passes quietly. This is that change: both
are rewritten rather than deleted, so the record of what was chosen stays where the next reader of
that code will find it.

## Open Questions

- Whether the per-settle retry needs a bound at all under a daemon that stays gone. Deferred to what
  ENG-199's run shows; it changes no requirement here and no task below, only whether a later change
  adds one.
