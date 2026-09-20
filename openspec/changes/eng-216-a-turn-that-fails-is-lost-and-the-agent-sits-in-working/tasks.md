## 1. The runtime stops on a turn it cannot complete

- [x] 1.1 In `agent/runtime/main.ts`, extract one exit path — write the reason to standard error, set `process.exitCode = 1`, destroy standard input — and make it idempotent with a flag. Both the outer `catch` and `take`'s `catch` go through it. The outer one keeps the behaviour it has today; the flag is what makes the second call a no-op.
- [x] 1.2 **The order inside it is the whole task, and getting it wrong silently loses the diagnosis.** Destroying standard input while the `for await` over it is running makes that loop reject with `ERR_STREAM_PREMATURE_CLOSE` — verified, not assumed. That rejection reaches the outer `catch`, so a path that destroys first and reports afterwards prints *"Premature close"* where *"Connection error."* belonged, and the parent is handed an account of how the process closed its own input instead of why the agent stopped. Write the reason **before** destroying, and let the idempotence swallow what the destroy raises.
- [x] 1.3 Replace `take`'s `catch` body with a call to that path. Delete the `failure` variable, the `if (failure !== undefined) return;` guard in `take`, the `if (failure !== undefined) break;` at the top of the stdin loop, and the `if (failure !== undefined) throw failure;` after `await turns`. All four exist to carry a failure to a reader that cannot be reached.
- [x] 1.4 Confirm by reading that `dispatch` converts every capability failure into an `ok: false` result rather than throwing, so what escapes `run()` is the model client — which is the 429/5xx trigger this task is about, and now the thing 1.3 catches.

## 2. Delivery gives a body to an agent that has none

- [x] 2.1 In `#deliver`, take the mailbox read above the state guard, and return early when there is nothing pending. Mail is what triggers a revival and the supervisor revives nothing it was not asked to — an agent whose body ended and that nobody has addressed stays as it is.
- [x] 2.2 Add the branch: an agent that is `working` **and holds no body** is booted with `owed: true`, and `#deliver` returns without touching the mailbox or the stored state. The message stays queued for the boundary that agent reaches, and the ordinary settle delivers it there.
- [x] 2.3 Restate the remaining guard as what it always meant: do not deliver to an agent that is working **in a body**, because that is the in-flight turn a message's arrival must not interrupt. The `waiting` path below it is unchanged.
- [x] 2.4 Check that the new branch needs no restore on failure and say so where it is. The `waiting` path has to restore because it drains the mailbox before booting; this one writes nothing before `#boot`, so an `UnprovisionedError` leaves the store exactly as it found it and `#settle`'s existing handling reports it.
- [x] 2.5 Confirm there is no double boot: `#settle` visits each id once per pass, and a revived agent has a body by the time anything looks again.
- [x] 2.6 Check `#unprovisioned`'s wording against this new caller. It says the agent "has not started and has not ended", which was true of its only previous caller and is false of an agent whose body ended. Reword so it is true of both, or say what it is for each.

## 3. The ending report says what is now true

- [x] 3.1 Reword `#ended`'s message. `terminated` overstates once the agent can be continued, and a parent reading it as a death replaces a child whose work is sitting intact. Say the body ended, carry what it said, and say the work is kept and the agent can be told to carry on.
- [x] 3.2 Keep `substrate: true` and keep the reason appended rather than substituted — the ending is the fact and what the body said is the account of it, and both rules survive the rewording.
- [x] 3.3 Update the comment above it. Its current text explains why the stored state is deliberately left alone; that reasoning is unchanged but its consequence is not, and the paragraph should say that the decision the parent owns is now one the parent can carry out.

## 4. The stall read and its report

- [x] 4.1 Rewrite the predicate in `stalled` as one condition: an agent cannot move when it has nothing to act on — an empty mailbox, or mail that cannot be delivered — **and** it is not working in a body. That covers the suspended agent, the unreachable one and the bodiless one together, rather than as three clauses.
- [x] 4.2 Check the pairs that predicate has to get right, and write a test for each rather than trusting the read: `working` with a body counts as able to move; `working` with no body and mail counts as able to move, because 2.2 will revive it on the next pass; `working` with no body and nothing pending counts as stopped.
- [x] 4.3 Note the one window where `working` with no body is transient rather than terminal: `#deliver` saves `working` before `#boot` on the `waiting` path. It cannot produce a false report, because `stalled` is read from `#settle` on the serial queue after every `#deliver` has returned — but `stalled` is a public getter and a test reading it mid-delivery would see it. Say so where the getter is.
- [x] 4.4 Change `onStalled` to `(stalled: { waiting: readonly string[]; stopped: readonly string[] }) => void`, and compute both lists at the call site in `#settle`.
- [x] 4.5 Update the supervisor's own default handler to name both, and keep it on standard error for the reason it is there now.
- [x] 4.6 Update `agent/operator.ts`'s line to the human. It currently says "every agent in {run} is waiting and nothing is pending", which is false in exactly the case this change adds — say what stopped as well, and keep the sentence readable when nothing has.

## 5. Tests

- [x] 5.1 `agent/runtime/entry.test.ts` — the regression this task asks for, at the `main.ts` level. Boot the real entry point with `owed: true` against a `baseURL` nothing listens on, and assert the process **exits** and that standard error carries the provider's reason — **without the supervisor's half sending anything further**. That last clause is the whole test: the bug was that one more inbound frame released the diagnosis, so a test that sends one passes against the broken code.
- [x] 5.2 `agent/runtime/entry.test.ts` — assert standard error carries the model failure and not `ERR_STREAM_PREMATURE_CLOSE`. This is the 1.2 landmine, and it is invisible to a test that only checks the exit code.
- [x] 5.3 `agent/supervisor/routing.test.ts` — a child whose body ended is given a new one when its parent addresses it, continues from its stored transcript, and receives the message at the boundary it reaches. Kill the body by the path `#ended` takes rather than hand-writing the store, so the test exercises the real state.
- [x] 5.4 `agent/supervisor/routing.test.ts` — an agent whose body ended and that nobody addresses is not revived by a settle.
- [x] 5.5 `agent/supervisor/failure.test.ts` — a turn that fails reaches the parent as an ending report, and the parent can then continue the child rather than only replace it. This is the end-to-end of both halves and is the test that would have caught the original bug.
- [x] 5.6 `agent/supervisor/failure.test.ts` — a revival that cannot be provisioned reports to the parent and leaves the message pending and the agent unchanged.
- [x] 5.7 The three pairs from 4.2, and that the report names the stopped agent distinguishably from the waiting ones — in `agent/supervisor/failure.test.ts` rather than `policy.test.ts`. That file reads the supervisor's source rather than running it, which is its whole premise; every behavioural test about the stall read is already beside these, under `a stalled tree is surfaced and never resolved`.
- [x] 5.8 `agent/supervisor/double.ts` and `agent/acceptance.test.ts` — update the `onStalled` recorders for the widened argument.
- [x] 5.9 Run the whole substrate suite. `containers.test.ts` and `sandbox/docker.test.ts` need a running container runtime; the rest need only node.

## 6. Notes

- [x] 6.1 Add the row this change makes true to the state table in `agent/supervisor/AGENTS.md`: `working` with no body, what it means, and that mail is what resolves it. The table is that file's centre and the new delivery branch is unreadable without it.
- [x] 6.2 Record in `agent/supervisor/AGENTS.md` that revival is triggered by mail and never by a settle's own walk, and why — it is the question the next reader will ask of the branch, and the answer is a judgment about where judgment belongs rather than anything the code shows.
- [x] 6.3 Record the `ERR_STREAM_PREMATURE_CLOSE` ordering in a note nearest the code it applies to. It cost a verified probe to find and it is invisible in review: the wrong order still exits, still reports, and reports the wrong thing.

## 7. The bound on revival, from review

Review found that the revival branch as landed is unbounded: the message that triggers it is
never consumed, so it is still at the head of the mailbox when the new body dies and is
re-read as a fresh instruction. One parent message buys bodies without limit — measured at
284 in three seconds on the double — and `stalled` stays silent, because the message driving
the loop reads as work about to happen. The rule and the subtraction it bought both stand;
this is the bound their own reasoning assumed.

- [x] 7.1 Add `#revived` to the supervisor: the agents already given a body for the mail they
  are still holding. An id goes in when a body is successfully provisioned for a bodiless
  agent — not when the provisioning failed, because no body was made and `#unprovisioned` has
  just promised the parent a retry.
- [x] 7.2 Take the mark in `#deliver`'s revival branch and return early where it is already
  held. No counter and no timer, and the message stays pending: the bound is on how many
  bodies one message buys.
- [x] 7.3 Clear it in `#post` — a second decision buys a second body, and `#post` is the one
  place anything reaches an agent's mailbox — and in `#turn`, where a revived body has reached
  a boundary and so got somewhere.
- [x] 7.4 Teach `#cannotMove` about it, or the bound leaves a bodiless agent holding mail
  forever and invisible to the backstop. Read the mark against the `working` status it always
  describes, so a mark that outlives its agent's state cannot make a reachable agent look
  stuck.
- [x] 7.5 Check the mark against `#settle`'s `#unreachable.delete(id)`, which clears on every
  `#deliver` that returns without throwing — the refused revival included. The two marks stay
  separate: `#unreachable` means "no body and no way to get one" and that clearing is right
  for it; `#revived` means "already answered with a body" and must survive it. Say so where
  each is.
- [x] 7.6 Tests in `agent/supervisor/failure.test.ts`: one message buys one body however many
  die; a further message buys a further body, with both still pending in order; and a tree
  held only by an agent whose mail will not revive it is surfaced with that agent named as
  stopped.
- [x] 7.7 Confirm the two that should fail against the unbounded code do — an extra body, and
  no stall ever surfaced. The third passes either way and is there to hold the re-arm.
- [x] 7.8 Correct the three artifacts that assert the unbounded behaviour as intended:
  `agent/supervisor/AGENTS.md`'s claim that mail-triggering prevents the loop, the spec
  delta's SHALL, and the proposal's bullet making the same argument.

## 8. The document the live pass is sent to

**The `terminated` sweep in 6.x missed `agent/LIVE-PASS.md`**, which is the file 9.1 hands test-task. Two paragraphs there describe behaviour this change replaces, and a live pass that checks the guidance on seeing silence is told the silence is expected — recording this change's own failure mode as normal.

- [x] 8.1 `LIVE-PASS.md`'s "watch for a tree that has stopped without saying so": the substrate no longer reports a stall only when every agent is `waiting`, so say what it reports now and name the line it puts on the operator's standard error. The silence becomes the finding rather than the symptom.
- [x] 8.2 The same paragraph's "the cause found in the first pass is fixed; if you see the shape again it is something else" is stale by two causes. Name all three that a live pass has found, so a fourth reads as a fourth.
- [x] 8.3 `LIVE-PASS.md`'s "A body that dies": the report is `<id>'s body ended: …`, and the substantive half is that carrying on was not an available option before this change. Say what to watch for and that addressing the agent buys one body — which is 9.3 and 9.4 done by hand.
- [x] 8.4 Sweep the rest of `agent/` for the same staleness rather than only the two paragraphs named. `suspend.test.ts`'s comment on why a dead body's message is not put back states the parent's options as they were; the reasoning it records is still right and is now load-bearing for the bound.
- [x] 8.5 The PR description still argues that mail-triggering alone keeps a dying agent out of a loop, which is what the first review returned. It is the host's record of what this change does and what the merge commit carries, so 7.8's correction applies to it.

## 9. Verification beyond the tier

**Left for test-task, not skipped.** A live pass at fan-out is beyond unit scope and is what that stage is for; implement-task ran the scripted tiers instead — the whole substrate suite including both container-backed tiers, and the repository's own build, typecheck and tests. The lesson this task records is that the tier passing is not what confirms this.

- [ ] 9.1 One live pass at the fixed commit, at fan-out wide enough to provoke a provider error. Neither scripted tier caught this across two live passes, so the tier passing is not what confirms it. Follow `agent/LIVE-PASS.md`, which group 8 brought back into agreement with the code.
- [ ] 9.2 In that pass, confirm the thing the bug made impossible: a tree that hits a provider error keeps going, or says why it cannot. Record what happened on the task either way — a pass that provoked no provider error has not exercised this and should say so rather than be reported as confirmation.
- [ ] 9.3 If the pass produces an agent whose body ended, confirm by hand that addressing it continues it. That is the half no live pass has ever reached, because reaching it needs a parent that chooses to retry.
- [ ] 9.4 And confirm the bound the same way, which is the half that costs real money if it is wrong: a child that cannot be kept alive at all — a model id the provider does not have is the cheapest way to arrange one — is given one body per instruction its parent sends and not a stream of them, and the run says the tree has stopped rather than going quiet. Count containers created for that agent, not reports.

## 10. The container the new exit path orphans, from testing

Group 9.4's live pass found it by counting rather than reading: three instructions to an
agent whose provider call fails produced three bodies, three ending reports, and three
containers still `Up` after the operator exited `0` — `docker events` showing three
`exec_die` and no `die`, `kill` or `destroy`. `#ended` drops the body from `#bodies` and
never destroys its sandbox; `#shutdown` walks `#bodies`, from which `#ended` has already
removed it. Structurally it predates this change — `main`'s `#ended` has no destroy either —
but this change is what makes it reachable and then routine, because a turn that threw used
to leave the runtime alive-but-idle and the body tracked. One container leaked per provider
error, and `#revived` does not bound it: that bound is per message, not across a parent that
keeps answering.

- [x] 10.1 Destroy the sandbox in `#ended`, and put it **above** the early returns rather than
  beside the report. Three paths out never reach the report — an intended ending, a shutdown,
  and an agent that had already spoken and so is `waiting` — and each of those is a container.
  The `#bodies.delete` on the line above is what makes this the last place that can.
- [x] 10.2 Report that destroy's failure through `#failed`, unlike `#suspend`'s, which is
  swallowed. A suspension has a caller and an outcome; this has neither, so a failure here is
  a container held for the rest of the run with nobody in a position to say so — which is this
  task's own shape. `#failed` never rethrows, so the report to the parent still goes out.
- [x] 10.3 End `#shutdown` with a `destroyAll()` sweep, before `store.close()`. Walking
  `#bodies` can only ever find what nothing has already dropped, so the sweep is the backstop
  for 10.2's failure. Swallowed: a shutdown must not fail through the action a person takes to
  stop for the day, and what it cleans up was reported when its own destroy failed.
- [x] 10.4 Confirm the sweep's semantics are the ones wanted — `destroyAll` ends bodies and
  releases no workspace, which is the distinction `agent/sandbox/index.ts` holds and the one
  a shutdown would be worst to get wrong.
- [x] 10.5 `agent/supervisor/failure.test.ts` — three at the double tier: a body that died
  leaves nothing live and neither does the one revival buys, a body whose agent had already
  spoken is released on the path that reports nothing, and a destroy that fails reaches
  `onFailure` and is swept at shutdown. Confirm all three fail against the code without 10.1.
- [x] 10.6 `agent/supervisor/containers.test.ts` — the assertion only the real tier can make,
  since the double decides for itself what `docker ps` would have said. Add a `DIE` mode to
  `harness.ts`'s shell peer that ends the way the runtime now does, and assert from `docker ps`
  that nothing of the failed agent is left while its parent still holds its own body. Confirm
  it fails against the code without 10.1.
- [x] 10.7 Add the requirement to the `agent-supervisor` delta. The code alone is a fix that
  the next change can undo without noticing, and there is nothing in the main spec that says a
  body's ending releases its container.
- [x] 10.8 Record the rule in `agent/supervisor/AGENTS.md`: the two places a body leaves
  `#bodies` are the two places that destroy its sandbox, why the destroy is above `#ended`'s
  returns, why this one reports and the other swallows, and that a container whose exec died
  is still `Up` — which is why this was invisible to a green suite.
- [x] 10.9 The full-suite run of 10.1–10.8 surfaced its own defect, and it is the same class:
  `onFailure` reported *"the supervisor could not carry on … destroying the sandbox … failed:
  removal of container … is already in progress"* over a container that was already going
  away. `--force` makes destroying idempotent for a sandbox that is **gone** — it exits zero —
  and the daemon refuses one that is **going**, exit 1. So 10.2's report, which is right, is
  a false alarm in exactly the window 10.1 made routine. Tolerate it in
  `agent/sandbox/docker.ts`, where the string belongs, rather than in the supervisor: one
  `#remove` helper behind both `destroy` and `destroyAll`, tolerating the refusal only where
  **every** line of the complaint is that one, so a sweep passing several names cannot hide a
  real failure beside it. Amend the `agent-sandbox` delta's failure-modes requirement, which
  states the idempotence as gone-only.
- [x] 10.10 `agent/sandbox/docker.test.ts` — two destroys of a sandbox with a process running
  in it, concurrently, both resolving. A real race rather than a stubbed reply, so what is
  tolerated is what the daemon really says; confirmed red three times out of three against the
  driver without the tolerance.
- [x] 10.11 `agent/LIVE-PASS.md` sent the live pass at two credentials that do not exist on
  the machine it runs on: the records' `ref`s read `env:OPENROUTER_API_KEY` and
  `env:CLAUDE_CODE_OAUTH_TOKEN`, and what is set is `OPENROUTER_API_TOKEN` and
  `CLAUDE_OAUTH_TOKEN`. Same defect as the rest of group 8 — the document 8.1 hands
  test-task disagreeing with reality — and it predates this change only in the sense that
  nobody had run it from this environment. An unresolvable `ref` is refused at creation, in
  the credential prologue, so it does not degrade into a partial pass: it stops at the first
  record. Correct both `ref`s, keep both `name`s, since `claude` inside the sandbox requires
  `CLAUDE_CODE_OAUTH_TOKEN` exactly and the `name`/`ref` split is what expresses that — and
  say so where the two names sit next to each other, because that is the line a reader
  skims.
