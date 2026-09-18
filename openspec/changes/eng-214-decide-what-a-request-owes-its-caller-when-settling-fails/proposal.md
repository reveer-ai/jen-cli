## Why

Every request the supervisor serves ends in `#settle()`, a bare loop over every agent with no
try/catch in it. `#deliver` rethrows when it cannot boot a body — deliberately, because it
restores the mailbox exactly first, so a daemon that went away costs nobody their message. But
that throw leaves through a loop eight call sites share, and two things follow that nobody chose.

**One agent that cannot be provisioned fails every other agent's requests.** A parent spawns
`a-2`; the record and parent link are written exactly as asked; the loop then reaches `a-1`,
bodiless since the daemon blinked, and throws — so the parent is told its `a-2` spawn failed. It
never clears. Every later request is refused the same way, while the parent accumulates children
it believes do not exist.

**And delivery stops for every agent after the failing one.** A healthy agent with a message
waiting does not get it, because an unrelated agent elsewhere could not boot.

Now, because ENG-197 made `spawn` reachable by an agent, and ENG-199's acceptance run is the
first thing that will drive a real daemon long enough to blink.

## What Changes

- **Settling attempts every agent and never abandons the pass.** A failure is caught per agent
  and the walk continues. One agent without a body does not change what is deliverable elsewhere.

- **A request is answered by what it asked for, not by what settling did.** `spawn` answers with
  the child's id because the record was written; `send` answers `delivered` because the message
  is in the mailbox. Neither ever claimed a body existed. The same rule for `send`, `tell`,
  `spawn`, `resume` and an ordinary turn — which is why it could not land in ENG-197, where
  deciding it for `spawn` alone would have made the five disagree.

- **A body that cannot be provisioned is reported to the parent, exactly as a body that died
  already is.** `#ended` posts `<id> terminated: <how>` into the parent's mailbox; a failed boot
  is the same fact from the parent's side, so it takes the same path. Retry, replace, escalate or
  give up is then the parent's call, the one `#ended` already declines to make for it. The root's
  parent is the human, so a root that cannot boot reaches a person with no special case.

  Not `onFailure`, which is for the supervisor's own trouble — what no agent can act on. A child
  with no body is something its parent can act on.

- **Delivery retries on every settle; the report happens once.** The message is still in the
  mailbox, so a daemon that comes back delivers it with nothing lost. A backoff, an attempt
  ceiling, or an unreachable state to park an agent in would each be policy in code, which
  *weights decide, code constrains* forbids. Only the noise is held down: an agent whose delivery
  just failed is remembered until one succeeds, so an outage is one message to the parent rather
  than one per request.

- **Undeliverable mail no longer counts as work pending, for the stall check.** `stalled` reads a
  non-empty mailbox as "delivery will wake an agent." Where delivery is what failed, that turns a
  stopped tree into a working-looking one.

- **`resume()`'s boot loop comes under the same rule.** It has the same bare shape, so today one
  agent that cannot be provisioned aborts the recovery of every agent after it.

Unchanged, because each reads like scope: `#deliver`'s restore-then-rethrow (load-bearing; only
its caller changes), `onFailure`'s meaning, and how long a body is kept.

## Capabilities

### New Capabilities

None. This is a decision about behavior the `agent-supervisor` capability already describes.

### Modified Capabilities

- `agent-supervisor`: delivery to one agent failing does not stop delivery to the others and does
  not fail a request made by a different agent; an agent whose body cannot be provisioned is
  reported to its parent as a message, on the same terms as an agent that ended without speaking;
  a message pending for an agent that cannot be reached does not hold off the stalled-tree report.

## Impact

- `agent/supervisor/index.ts` — `#settle`, `#resume`, and the `stalled` getter. `#deliver` is
  untouched.
- `agent/supervisor/spawn.test.ts` — the final `describe` pins today's behavior so a deliberate
  change fails rather than passes quietly. This is that change; it is rewritten to state what a
  spawn now owes its caller.
- `agent/supervisor/AGENTS.md` — "A spawn that cannot provision a body is refused, and the child
  exists anyway" describes what is being replaced, and goes with it.
- A parent can now receive a substrate message about a child it never asked about. No charter in
  the repo says anything about that yet.
- No change to the protocol, the record, the store's shape, or anything inside a sandbox.
