## Why

The supervisor already routes messages: `#sending` validates that a target is the caller's parent or one of its children, `#awaiting` parks an agent and arms its residency, and `#deliver` chooses between answering an outstanding request and beginning a turn. Every one of those paths is tested and none of them is reachable by an agent, because `runtime/main.ts` declares `spawn` and `stop` to the model and nothing else. **An agent can create a child and dismiss it, and cannot say a word to it.** Delegation exists; conversation does not.

Two things that were deferred to this task come due with it.

**The grant gap.** `#spawning` and `#stopping` each read the caller's record; `#sending`, `#awaiting` and `#reading` do not. So an agent whose record names only `spawn` can put a raw `send` frame on the channel and have it delivered. `supervisor/AGENTS.md` records this as deliberate, names this task as where the decision belongs, and prescribes the shape: one check at the top of `#request` rather than a third copy of the same `if`.

**Nobody is told who spoke.** `render()` returns a message's content and nothing else, so an `await` answers with bare text and a turn-boundary message becomes `{role:'user', content}`. A parent holding four children has four conversations multiplexed onto one mailbox with nothing to tell them apart. That is not a polish item: it is what makes fan-out — the thing `spawn` returning immediately exists for — actually work, and ENG-199's acceptance run needs it.

## What Changes

- **`send` and `await` become agent-facing capabilities**, declared in `runtime/main.ts`'s `SUPERVISED` array beside `spawn` and `stop`. Two more declarations and no other change to the runtime, which is the property that array was built to hold.
- **`await` takes the agent's residency and nothing else.** It answers with the next message from anyone. The `agent_ids` filter and `timeout` sketched on the task are deliberately not built — see Decisions.
- **A delivered message names its sender.** An agent reading a message — as an `await` answer or as the message that begins its turn — learns which agent it is from, or that it is from the human.
- **Every request kind is checked against the caller's record** at the top of `#request`, replacing the two per-handler checks rather than joining them. `send`, `await` and `read` become grantable; `read` (ENG-212) and every kind added after arrive already covered.
- **`spawn`'s `tools` description tells a spawning model what withholding costs** — that a child without `send` still reports when its turn ends, and that "answer once and stop" belongs in a charter rather than in a grant.

### Decisions

**`await` waits on anyone.** A filter would hold matching messages back while an agent sleeps on an unmatched mailbox, and `stalled` — every live agent waiting *and* every mailbox empty — reads that tree as healthy forever. A parent that wanted a particular child reads the sender and decides, which is judgment in the weights rather than a filter in the code. Revisit when an agent must act on a message's *absence*, which is the case a deadline answers and reading the sender does not.

**No timeout.** It needs a second clock beside residency, one that must boot a dormant agent for the sole purpose of telling it nothing arrived. Same trigger condition as above.

**`send` and `await` are granted, not given.** Withholding either denies less than it appears to: reporting at turn end is ungateable, so a child with no `send` that needs something says so by ending its turn and is woken with the reply. What a grant buys is speaking mid-turn and speaking downward. Making them grantable keeps one rule with no exception in it, holds against the agent that hand-writes a raw frame, and hands the parent an expressive knob consistent with **weights decide, code constrains**.

## Capabilities

### New Capabilities

None. This completes capabilities both existing specs already describe.

### Modified Capabilities

- `agent-runtime`: `send` and `await` are declared through the same record-selected capability interface as `spawn` and `stop`, and `await` carries the residency its own input names.
- `agent-supervisor`: a request is refused unless the caller's record names its kind; a message carries its sender through delivery into what the receiving agent reads.

## Impact

- `agent/runtime/main.ts` — two entries in `SUPERVISED`, and a revision to `spawn`'s `tools` description.
- `agent/supervisor/index.ts` — the grant check at the top of `#request`; the per-handler checks in `#spawning` and `#stopping` deleted; `render()` and the delivery path carry the sender.
- `agent/supervisor/AGENTS.md` — the section recording the grant gap is resolved by this change and is replaced by what the rule now is.
- Whoever builds a root record — fixtures, harness, `agent/fixture.ts` — must name the capabilities the tree is to have. Under ENG-197's monotonicity rule no agent can grant what it does not hold, so a root that omits `send` mutes every agent beneath it.
- Tests asserting today's refusal wording for `spawn` and `stop`, and `routing.test.ts`'s bare-content `await` answers, change with the behaviour they describe.

## Out of scope

- `read` and turn-end completion — ENG-212, which inherits the same grant rule this change establishes.
- What a request owes its caller when `#settle` fails — ENG-214.
- Interrupting an in-flight turn. A message always waits for a turn boundary; `stop` is what exists for the case where waiting is not acceptable.
