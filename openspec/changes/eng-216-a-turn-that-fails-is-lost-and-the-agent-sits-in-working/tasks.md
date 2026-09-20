## 1. The frame

- [ ] 1.1 Add `FailedFrame` to `agent/protocol.ts` — `{ t: 'failed'; reason: string; residency: number }` — and add it to the `FromAgent` union and to `parseFromAgent`'s branches. Document it beside `TurnFrame`: it is the other way a turn ends, and it is reported rather than signalled by exiting for the same reasons `TurnFrame` is.
- [ ] 1.2 Carry `residency` on it and write zero, always, for the reason `TurnFrame` does: an agent whose turn failed has asked for nothing about its body, and expressing that here rather than leaving the field off is what keeps the supervisor from having a default to supply.

## 2. The runtime

- [ ] 2.1 In `agent/runtime/main.ts`, replace `take`'s `catch` with `say({ t: 'failed', reason, residency: 0 })`. The reason is the message and not the stack, matching the file's existing rule and for the same reason: every failure that reaches here already names what it could not reach, and a stack buries that.
- [ ] 2.2 Delete the `failure` variable, the `if (failure !== undefined) return;` guard in `take`, the `if (failure !== undefined) break;` at the top of the stdin loop, and the `if (failure !== undefined) throw failure;` after `await turns`. All four exist to carry a failure to a reader that cannot be reached; none has anything left to carry. **Removing the guard is deliberate** — a turn queued behind a failed one must still run, because the agent is addressable again the moment the failure is reported.
- [ ] 2.3 Leave the `catch` at the bottom of the file exactly as it is. A body that cannot read its boot frame has no channel on which to say anything, so dying with the reason on stderr remains the only thing it can do — and `#ended` is still what turns that into something a parent can act on.
- [ ] 2.4 Confirm by reading that nothing else can now reach that outer `catch` from inside a turn: `dispatch` converts every capability failure into an `ok: false` result rather than throwing, so what escapes `run()` is the model client, and that is what 2.1 now catches.

## 3. The supervisor

- [ ] 3.1 Add a `frame.t === 'failed'` branch to `#frame`, routing to a handler beside `#turn`.
- [ ] 3.2 Write that handler on `#turn`'s shape: save the agent `{ status: 'waiting', request: null }`, `#post` to `agent.parent`, arm residency if the mailbox is empty, `#settle`. The two differences from `#turn` are that the posted message carries `substrate: true`, and that its content is the substrate's account rather than the agent's words.
- [ ] 3.3 Word the report against both misreadings, as `#unprovisioned`'s comment does for its own. It must not read as a death — the agent has not ended, still holds its transcript and workspace, and can be addressed again — and it must not read as the agent's own account of what went wrong. Name the agent, say the turn could not be completed, carry the reason, and say it is still addressable.
- [ ] 3.4 Check the null-parent path needs nothing: `#post(null, …)` already carries a root's message to the human, so the agent nobody spawned needs no branch of its own. Add a test rather than a comment.

## 4. The stall read and its report

- [ ] 4.1 Widen the `stalled` getter so an agent counts as immobile when it is `waiting` with an empty or unreachable mailbox **or** when it is `working` with no entry in `#bodies`. Keep `dismissed` filtered out as now.
- [ ] 4.2 Write the comment this needs. The existing one explains why held mail for an unreachable agent is not progress; this is the same argument for the same reason, and the paragraph should say so rather than repeating it — a `working` agent with no body is one `#deliver` will never serve, because delivery reaches agents at a turn boundary.
- [ ] 4.3 Note the one window where `working` with no body is transient rather than terminal: `#deliver` saves `working` before `#boot`. It cannot produce a false report, because `stalled` is read from `#settle` on the serial queue after every `#deliver` has returned — but `stalled` is a public getter and a test reading it mid-delivery would see it. Say so where the getter is, not here.
- [ ] 4.4 Change `onStalled` to `(stalled: { waiting: readonly string[]; stopped: readonly string[] }) => void`, and compute both lists at the call site in `#settle`.
- [ ] 4.5 Update the supervisor's own default handler to name both, and keep it on stderr for the reason it is there now.
- [ ] 4.6 Update `agent/operator.ts`'s line to the human. It currently says "every agent in {run} is waiting and nothing is pending", which is false in exactly the case this change adds — say what stopped as well, and keep the sentence readable when nothing has.

## 5. Tests

- [ ] 5.1 `agent/runtime/entry.test.ts` — the regression the task asks for, at the `main.ts` level. Boot the real entry point with `owed: true` against a `baseURL` nothing listens on, and assert a `failed` frame arrives on stdout **without the supervisor's half sending anything further**. That last clause is the whole test: the bug was that one more inbound frame released the diagnosis, so a test that sends one passes against the broken code.
- [ ] 5.2 `agent/runtime/entry.test.ts` — after the failure, send a message and assert the process takes a turn on it. This is what distinguishes the chosen fix from exiting, and nothing else covers it.
- [ ] 5.3 `agent/supervisor/double.ts` — add `failed(reason)` to `Peer`, beside `answered()`, and update `aRun`'s `onStalled` recorder to the widened argument.
- [ ] 5.4 `agent/supervisor/failure.test.ts` — a peer that fails a turn: the parent receives the report, it is marked `substrate`, the agent is left `waiting`, and a message sent afterwards reaches it and begins a turn.
- [ ] 5.5 `agent/supervisor/failure.test.ts` — a root whose turn fails reports to the human rather than being dropped.
- [ ] 5.6 `agent/supervisor/policy.test.ts` — a tree whose every other agent is waiting and which holds one `working` agent with no body is reported stalled, and the report names that agent as stopped. Kill the body by the path `#ended` takes so the test exercises the real tombstone rather than a hand-written store.
- [ ] 5.7 `agent/acceptance.test.ts` — update its `onStalled` recorder for the widened argument.
- [ ] 5.8 Run the whole substrate suite. `containers.test.ts` and `sandbox/docker.test.ts` need a running container runtime; the rest need only node.

## 6. Notes

- [ ] 6.1 Add the row this change makes true to the state table in `agent/supervisor/AGENTS.md`: `working` with no body, meaning an agent that stopped, and what reads it. The table is the file's centre and the new stall clause is unreadable without it.
- [ ] 6.2 Record in `agent/supervisor/AGENTS.md` why a failed turn is not a death, in a sentence or two. It is the question the next reader will ask of the `failed` handler sitting beside `#ended`, and the answer is not derivable from either.

## 7. Verification beyond the tier

- [ ] 7.1 One live pass at the fixed commit, at fan-out wide enough to provoke a provider error. Neither scripted tier caught this across two live passes, so the tier passing is not what confirms it. Follow `agent/LIVE-PASS.md`.
- [ ] 7.2 In that pass, confirm the thing the bug made impossible: a tree that hits a provider error keeps going, or says why it cannot. Record what happened on the task either way — a pass that provoked no provider error has not exercised this and should say so rather than be reported as confirmation.
