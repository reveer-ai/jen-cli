## Why

A turn that throws is recorded and said to nobody, and the runtime then waits on a frame that
only a turn report could cause the supervisor to send. The agent is stored `working`, so
`#deliver` holds every message addressed to it for a turn boundary the failed turn will never
reach. The process stays alive on an open pipe with nothing pending, nothing on stderr, and a
correct diagnosis sitting in a variable that has no way out.

The trigger is ordinary. A 429 or a 5xx past the SDK's `maxRetries: 2` is unremarkable at
ten-plus concurrent containers, and it costs the whole tree rather than the one agent.
`STEP_DEADLINE_MS` is thirty minutes with two retries, so even the timeout path arrives at the
same trap ninety minutes later.

**But the failed turn is one way into a state the substrate cannot get out of, and closing
only that way leaves the state.** An agent recorded `working` with no body is unreachable:
`#deliver` returns early on anything that is not `waiting`, so no message can ever be given to
it. That is where a killed body leaves its agent too — `#ended` reports the ending to the
parent and deliberately leaves the stored state alone, so the parent owns the decision. The
decision it owns is one it cannot act on. It can replace the child or give up; it cannot do
the obvious thing, which is tell the child to carry on from the transcript and workspace that
are both still sitting there intact.

And `stalled` requires every live agent to be `waiting`, so one such agent makes `onStalled`
unable to fire for the rest of the session — disabling the backstop for every cause of this
class, including ones not yet found. The tombstone was observed live (`live-chief-2-5`,
`working` with no body); the consequence was not exercised only because that run never reached
a state where everything else was waiting.

This is the third cause of the silent-stall class found by ENG-199's live passes and the first
that is not in the supervisor. It is the shape `agent/AGENTS.md` names as the one failure the
substrate must not be able to produce quietly, and the two scripted tiers were green through
both live passes that found it.

## What Changes

**One rule, in the supervisor: an agent with no body gets one when somebody addresses it.**
That is already what `resume()` does for every `working` agent — it boots each one with
`owed: true` and lets it continue from its stored transcript. This applies the same rule at
delivery instead of at recovery, and with it the unreachable state stops existing for every
cause rather than for the one this task found.

Everything else follows from that, and most of it is subtraction:

- **The runtime exits on a turn it cannot complete**, with the reason on standard error. No
  new frame, no new supervisor handler. `#ended` already turns a body's exit into a message
  the parent can act on, and `#overhear` already keeps the reason to put in it — the entire
  reporting path exists and the defect is only that nothing reaches it.
- **`#deliver` learns a third case.** A `working` agent with mail is given a body when it has
  none, with `owed: true`; its mail stays queued for the turn boundary it will reach. The
  guard becomes what it always meant: do not deliver to an agent that is *working in a body*,
  because that is the in-flight turn a message must not interrupt.
- **Revival is triggered by mail and by nothing else.** A settle does not walk the run
  reviving anything it finds — a child that died and that nobody has addressed stays as it is.
  Addressing it is the parent's decision and the substrate carries it out; making it automatic
  would put the retry judgment in code, where no charter can reach it, and would turn an agent
  that fails on boot into a loop.
- **`#ended`'s report becomes true and actionable.** It says `terminated` today, which will
  overstate once the agent can be continued. It should say the body ended, carry what the body
  said, and say the work is kept and the agent can be told to carry on.
- **`stalled` counts an agent that cannot be reached at all.** An agent is unable to move when
  it has nothing to act on *and* is not working in a body — one predicate covering the
  suspended agent, the unreachable one and the bodiless one together.
- **BREAKING: `onStalled` is handed the stopped agents as well as the waiting ones.** A stall
  caused by a body that ended otherwise reports the agents that are behaving.

**What this replaces.** An earlier draft of this change added a `failed` frame to the protocol
and a supervisor handler beside `#turn`, keeping the runtime alive and returning the agent to
`waiting`. It closed the failed turn and left the tombstone: a body killed by a signal, an OOM
or a daemon death still left its agent unreachable forever, so the substrate had two different
answers to "your child stopped" and only one of them could be retried. Exiting is better once
delivery can revive, and it is better *because* delivery can revive — the two halves are one
mechanism, and the frame was the price of not having it.

## Capabilities

### New Capabilities

None. Both halves are existing behaviour that does not hold in a case it must.

### Modified Capabilities

- `agent-runtime`: what the entry point owes on a turn it cannot complete. The peer
  requirement says a turn's *end* is reported on the channel and is silent on a turn that has
  no end; the code implemented that silence correctly. Adds that such a turn ends the process
  with the reason on standard error, and that the runtime never goes on waiting while holding
  a failure it has not surfaced.
- `agent-supervisor`: an agent whose body ended is given a new one when it is addressed;
  the ending report reworded to say so; and the stall read counting an agent that cannot be
  reached, with the report naming it.

## Impact

- `agent/runtime/main.ts` — one shared exit path used by the boot failure and the failed turn.
  The `failure` variable and its two reads go.
- `agent/supervisor/index.ts` — `#deliver`'s guard and its new branch; `#ended`'s wording;
  the `stalled` getter; the `onStalled` type, its default, and the call site in `#settle`.
- `agent/runtime/entry.test.ts` — the `main.ts`-level regression.
- `agent/supervisor/failure.test.ts`, `agent/supervisor/policy.test.ts`,
  `agent/supervisor/routing.test.ts` — revival, the reworded report, and the stall read.
- `agent/supervisor/double.ts` — `aRun`'s `onStalled` recorder takes the widened argument.
- Callers of `onStalled`: `agent/operator.ts`'s line to the human, the supervisor's own
  default handler, and `agent/acceptance.test.ts`'s recorder.
- **No protocol change.** `agent/protocol.ts` is untouched, and so is every frame.
- No change to records, transcripts, the event log, workspaces, or the sandbox driver.
  `answerInterrupted` has nothing new to do: a model call that throws appends no `tool_call`,
  so nothing is left outstanding by it, and a revived agent boots on a log whose shape the
  `owed` mechanism already covers.

## Artifacts

Proposal, specs, tasks. **No design.md, deliberately** — the decisions this change turns on
were settled before it was written, and the rejected alternative and the reason it was
rejected are recorded above, which is where someone asking "why not keep the agent alive and
report on the channel?" will look. A design artifact would restate that and decide nothing.

The specs deltas are the artifact this change could least afford to skip. The requirements it
touches *permit* the defect rather than forbidding it — `agent-runtime` is silent on a turn
that has no end, and `agent-supervisor` describes an ending reported to a parent without
saying that the parent can then do anything about it. Fixing the code without the deltas
leaves a spec that still permits the deadlock for the next reader to implement against.
