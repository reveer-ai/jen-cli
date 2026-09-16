## 1. Declare the two capabilities

- [ ] 1.1 Add `send` to `runtime/main.ts`'s `SUPERVISED`: `to` and `content`, both required, `additionalProperties: false`. The description says who an agent may address — its parent or one of its own children — and that this is fire-and-forget: it returns once the message is stored, not once anyone reads it, and it does not wait for a reply.
- [ ] 1.2 Add `await` to `SUPERVISED` with the single optional `keep`, an integer of milliseconds, and a `residency` hook reading it from the input (`(input) => input.keep ?? 0`). No other property.
- [ ] 1.3 Write `await`'s description to teach what a model cannot infer: `keep` holds the *container*, not the memory. Say that a dormant agent resumes holding everything it knew and only loses what was running, so a long wait should name nothing and a quick round trip should name a small number.
- [ ] 1.4 Extend `spawn`'s `tools` description with what withholding costs — a child with no `send` still reports when its turn ends — and that "answer once and stop" belongs in the child's charter rather than in its grant.
- [ ] 1.5 Confirm no other file in `runtime/` changed. Two declarations and one revised description is the whole of the runtime's part; anything else means a capability-specific path got in.

## 2. Attribution

- [ ] 2.1 Give `render()` the sender: `[from <id>] …` for an agent, `[from the human] …` for `from: null`, `[substrate] …` unchanged.
- [ ] 2.2 Escape the mark position — a leading `[` in agent-authored content becomes `\[` before the mark is prepended. Applies to what an agent wrote, not to the substrate's own reports.
- [ ] 2.3 Verify both delivery paths render identically: the resident path through `#say`, and the dormant path through `#answerInLog`. Both already call `render()`; the task is a test that pins it rather than a change.
- [ ] 2.4 Leave the `message` event's `from: 'parent' | 'self'` alone. It answers "were these my own words", which is a different question from which agent spoke, and ENG-212 should find it already meaning one thing.

## 3. The grant check

- [ ] 3.1 Add a set of routable kinds and check it at the top of `#request`, keeping today's "There is no capability named …" answer for anything outside it.
- [ ] 3.2 Add the grant check immediately below it: refuse where `record.tools` does not include `frame.kind`, answering the caller. It must come second — a record never names a kind that does not exist, so checking the grant first answers a typo by sending an agent to fix a grant.
- [ ] 3.3 Delete the per-handler checks in `#spawning` and `#stopping`. Both are now the generic one; leaving either is the third-copy drift `supervisor/AGENTS.md` warns about.
- [ ] 3.4 Confirm the refusal still precedes any write — the guarantee `spawn`'s "so nothing was spawned" tail used to carry now rests on the check's position, and a test should hold it there.

## 4. Records that name what they use

- [ ] 4.1 Update `supervisor/routing.test.ts` — its records name `['spawn', 'stop']` and it exercises `send` and `await` throughout, so every one of those calls is refused until the records name them.
- [ ] 4.2 Update `suspend.test.ts` and `failure.test.ts`, whose records take `aRecord`'s default `tools: []` and drive `await`.
- [ ] 4.3 Update `read.test.ts` for the same reason. `read` is ENG-212's capability, but the generic check gates it from this change onward — that is the check working, not scope creep.
- [ ] 4.4 Decide and apply `aRecord`'s default. Leaving `tools: []` means every new test names what it uses, which is the honest default; changing it to the full set would make a test pass without saying what authority it needed.
- [ ] 4.5 Check `containers.test.ts` and `harness.ts` for records that must name the full set, since the real-container tier is the one that would fail last and slowest.

## 5. Tests

- [ ] 5.1 A parent and a child exchange messages through `send`, and the parent reads which child sent each one.
- [ ] 5.2 Two children of one parent report; the parent's two messages are distinguishable by sender.
- [ ] 5.3 An `await` answered after the agent's container went dormant carries the same mark it would have carried resident.
- [ ] 5.4 A message from the human is read as from the human, not from an agent.
- [ ] 5.5 A child whose report begins with `[substrate]` is read as that child's words, and the mark identifying it is still the one in mark position.
- [ ] 5.6 A raw `send` frame from an agent whose record omits `send` is refused and delivers nothing.
- [ ] 5.7 An unknown kind still answers "There is no capability named …" rather than a grant refusal.
- [ ] 5.8 An agent granted neither `send` nor `await` still reports at turn end and still receives a message at a turn boundary.
- [ ] 5.9 `await` raises the residency named in `keep`, and raises zero where `keep` is absent.
- [ ] 5.10 Confirm each new guard fails when its source is mutated — the grant check, the kind check, and the escape. A source-level guard that no mutation can break is not being tested.

## 6. Notes and checks

- [ ] 6.1 Rewrite `supervisor/AGENTS.md`'s "Two of the five request kinds read the caller's record" section to say what the rule now is, since this change resolves it.
- [ ] 6.2 Add a short note there on the mark: what occupies mark position, that agent-authored content is escaped into it, and that a mid-message mark is deliberately not escaped.
- [ ] 6.3 `npx tsc -p agent/tsconfig.json` and `npx vitest run --config agent/vitest.config.ts` — both clean. Nothing in CI covers `agent/`, so this is the only thing that will catch a regression.
- [ ] 6.4 Run the container tier with Docker up, since `containers.test.ts` is where a record missing a capability surfaces as a hang rather than a failure.
- [ ] 6.5 `openspec validate eng-198-build-the-inter-agent-communication-channel --strict`.
