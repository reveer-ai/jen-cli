## Why

A turn that throws inside a living body is recorded and said to nobody, and the runtime then
waits on a frame that only a turn report could cause the supervisor to send. The agent is
stored `working`, so `#deliver` holds every message addressed to it for a turn boundary the
failed turn will never reach. The process stays alive on an open pipe with nothing pending,
nothing on stderr, and a correct diagnosis sitting in a variable that has no way out.

The trigger is ordinary. A 429 or a 5xx past the SDK's `maxRetries: 2` is unremarkable at
ten-plus concurrent containers, and it costs the whole tree rather than the one agent: every
ancestor is waiting on a child that will never speak. `STEP_DEADLINE_MS` is thirty minutes
with two retries, so even the timeout path arrives at the same trap ninety minutes later.

This is the third cause of the silent-stall class found in ENG-199's live passes and the
first that is not in the supervisor. It is the shape `agent/AGENTS.md` names as the one
failure the substrate must not be able to produce quietly, and the two scripted tiers were
green through both live passes that found it.

The second half is the same class. `#ended` deliberately leaves a killed agent's stored state
at `working`, because the parent is told and owns the decision. But `stalled` requires every
live agent to be `waiting`, so **one dead body whose parent does not happen to `stop` it makes
`onStalled` unable to fire for the rest of the session** — disabling the backstop for every
cause of this class, including ones not yet found. The tombstone was observed live
(`live-chief-2-5`, `working` with no body); the consequence was not exercised only because
that run never reached a state where everything else was waiting.

## What Changes

**A failed turn is reported on the channel, and the agent stays addressable.** The runtime
gains no new state: where it recorded `failure` and went quiet, it now says the failure and
carries on reading. The supervisor turns that into the same fact `#turn` produces — the agent
returns to `waiting` at a turn boundary — with the report posted to the parent marked
`substrate: true`, so a parent is never misled about who spoke.

This is chosen over exiting on a failed turn, which was the obvious candidate. Exiting works
for the reporting half — `#ended` already turns a body's exit into a parent-actionable
message, and stderr already carries the reason — but it leaves the agent `working` with no
body, which `#deliver` will never serve. The parent would be told its child failed and then
be unable to do the first thing the report invites: try again. A transient provider blip would
permanently cost an agent whose conversation and workspace are both intact.

- **New `failed` frame on the runtime→supervisor channel**, carrying the reason. The protocol
  grows one frame kind and nothing else; a request is still an id, an open-string kind and an
  input the protocol never looks inside.
- **The runtime can no longer hold an unsaid failure.** Saying it *is* the handling, so the
  recorded-but-unsendable state stops existing rather than being made rarer. The boot-failure
  path at the bottom of `main.ts` is unchanged: a body that cannot boot still dies, because
  there is no channel on which to say anything.
- **`stalled` reads a `working` agent with no body as immobile.** Nothing will boot it —
  `#deliver` serves only `waiting` agents — so it is exactly as incapable of producing a
  message as a `waiting` one, and counting it as a tree still moving is the same lie the
  `#unreachable` clause was added to stop. This is the backstop, and it is the only part of
  the change that does not depend on knowing why an agent stopped.
- **BREAKING: `onStalled` is handed the stopped agents as well as the waiting ones.** A stall
  caused by a tombstone otherwise reports the agents that are merely waiting, pointing the
  human at everything except the cause.

## Capabilities

### New Capabilities

None. Both halves are existing behaviour that does not hold in a case it must.

### Modified Capabilities

- `agent-runtime`: the entry point's obligation on a turn that cannot be completed. Today the
  peer requirement says a turn's end is reported on the channel and says nothing about a turn
  that has no end to report; the gap is the defect. Adds that a failure is reported on the
  same channel and that the runtime never holds one it has not said.
- `agent-supervisor`: the `failed` frame and what it does to stored state and the parent's
  mailbox; the stall read counting a bodiless `working` agent as unable to move; and the
  stall report naming what is stopped alongside what is waiting.

## Impact

- `agent/protocol.ts` — one frame interface, one union arm, one parse branch.
- `agent/runtime/main.ts` — `take`'s catch; the `failure` variable and both of its reads go.
- `agent/supervisor/index.ts` — a `#frame` branch and a handler beside `#turn`; the `stalled`
  getter; the `onStalled` type, its default, and the call site in `#settle`.
- `agent/runtime/entry.test.ts` — the `main.ts`-level regression: a turn whose model call
  throws must produce something the supervisor can see, rather than an idle process.
- `agent/supervisor/failure.test.ts`, `agent/supervisor/policy.test.ts` — the supervisor's
  half, and a tree with a stopped agent reported rather than silent.
- `agent/supervisor/double.ts` — the scripted peer needs a `failed(reason)` beside `answered()`,
  and `aRun`'s `onStalled` recorder takes the widened argument.
- Callers of `onStalled`: `agent/operator.ts`'s line to the human, the supervisor's own default
  handler, and `agent/acceptance.test.ts`'s recorder.
- No change to records, transcripts, the event log, workspaces, or the sandbox driver. An
  agent's log shape is untouched, and `answerInterrupted` has nothing new to do: a model call
  that throws appends no `tool_call`, so nothing is left outstanding by it.

## Artifacts

Proposal, specs, tasks. **No design.md, deliberately** — both forks this change turns on were
settled before the proposal was written (report on the channel rather than exit; widen
`onStalled`), and the rejected option and the reason it was rejected are recorded above, which
is where someone asking "why not just exit?" will look. A design artifact here would restate
that and decide nothing.

The specs deltas are the artifact this change could least afford to skip. Both requirements it
touches *permit* the defect rather than forbidding it — `agent-runtime` says a turn's end is
reported and is silent on a turn that has no end, and `agent-supervisor`'s stall read
contemplates `waiting` agents and unprovisionable ones but not a bodiless `working` one. The
code implemented that silence correctly. Fixing it without the deltas leaves a spec that still
permits the deadlock for the next reader to implement against.
