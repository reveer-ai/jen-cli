## 1. Settling survives an agent that cannot be provisioned

- [x] 1.1 Catch per agent inside `#settle`'s walk: record the agent and the error, carry on to the next id, and leave `#deliver` itself untouched — its restore-then-rethrow is what keeps the message from being lost.
- [x] 1.2 Add `#unreachable: Set<string>` to the supervisor. Add an id when its delivery throws; remove it whenever `#deliver` returns without throwing, the early return included, since that means nothing is queued and so nothing is stuck. It is not stored and is not part of `StoredAgent.state`.
- [x] 1.3 Post the collected reports after the walk has finished, never during it, and run the walk again if any were posted — a parent that comes before its failing child in `ids()` would otherwise take its report into a mailbox the walk has already passed.
- [x] 1.4 Confirm the repeat terminates: an agent already in `#unreachable` produces no second report, so each pass has fewer agents left that can produce one.

## 2. The report a parent receives

- [x] 2.1 Post a substrate-marked message to the agent's parent naming the agent and what is known about the failure, through `#post` — so the root's parent being the human needs no special case.
- [x] 2.2 Word it so it cannot be read as a death and cannot be read as a loss: the agent has not spoken, has not ended, is still addressable, and what was queued for it is still queued and will be tried again. Do not reuse `#ended`'s wording.
- [x] 2.3 Report once for as long as the condition lasts, and again if the agent is reached and later cannot be reached — which is what `#unreachable` is read for.

## 3. A stopped tree says so

- [x] 3.1 Read a mailbox belonging to an agent in `#unreachable` as empty in the `stalled` getter, so mail that cannot be delivered stops counting as work about to happen.
- [x] 3.2 Leave everything else about `stalled` and `onStalled` alone — what is surfaced, and that nothing is resolved.

## 4. Recovering a run

- [x] 4.1 Catch per agent in `#resume`'s boot loop, carry on to the next, and report each failure to that agent's parent by the same path as §2.
- [x] 4.2 Leave a failed agent's stored state exactly as it was, so a later `resume()` boots it with nothing lost or repeated. It has nothing queued, so no settle will retry it on its own.

## 5. Tests

- [x] 5.1 Rewrite `spawn.test.ts`'s final `describe` — it pins today's behaviour so this change fails a test rather than passing quietly. It now states what a spawn owes its caller: the spawn is answered with the child's id, and a child that cannot be provisioned neither refuses it nor any request after it.
- [x] 5.2 An agent that cannot be provisioned does not fail a request made by a different agent about a different agent.
- [x] 5.3 A healthy agent with a message waiting receives it while another agent in the same run cannot boot, whichever order `ids()` puts them in.
- [x] 5.4 A message that could not be handed over is delivered, exactly once, by the first attempt that succeeds.
- [x] 5.5 The parent receives a report naming the child and the failure, distinguishable both from the child's own words and from a termination report.
- [x] 5.6 An outage spanning several requests reports once; an agent that is reached and then fails again reports again.
- [x] 5.7 A root that cannot be provisioned is reported to the human through the hook that carries the root's own messages.
- [x] 5.8 A run in which the only pending message is for an agent that cannot be provisioned is reported as stalled; one pending for an agent that can be reached is still not.
- [x] 5.9 `resume()` over a run with one unprovisionable agent recovers every other agent, reports that one to its parent, and boots it when run again against a driver that has recovered.

## 6. Checks and notes

- [x] 6.1 Run the substrate's typecheck, lint and build, then the full suite as a regression net.
- [x] 6.2 Replace the `agent/supervisor/AGENTS.md` section "A spawn that cannot provision a body is refused, and the child exists anyway" with what is true after this change — rewritten rather than deleted, so the next reader of that code finds what was chosen and why.
