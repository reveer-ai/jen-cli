## Context

The supervisor has routed messages since ENG-213 and nothing declares them to a model. `runtime/main.ts`'s `SUPERVISED` array holds `spawn` and `stop`; `#sending`, `#awaiting` and `#deliver` sit behind it, complete and tested and unreachable by any agent.

That array was built for exactly this. `supervised.ts` already carries the `residency` hook, and its comment names `await` as the caller it was shaped for — "the shape held for five capabilities written against it after the first two, rather than being settled by whichever of them was written first." So the declarations themselves are small. What this change actually decides is the two things around them that `supervisor/AGENTS.md` deferred here by name, plus one the task's own description implies and does not state: that a message currently arrives with no sender on it.

## Goals / Non-Goals

**Goals:**

- `send` and `await` reachable by a model, as ordinary record-selected capabilities.
- One grant rule at the channel, covering every request kind including the ones ENG-212 adds.
- An agent that reads a message knows who sent it.
- A mark the substrate applies cannot be produced by an agent writing text.

**Non-Goals:**

- `read` and turn-end completion — ENG-212, which inherits this change's grant rule rather than restating it.
- What a request owes its caller when `#settle` fails — ENG-214. This change adds two more callers to the loop that problem lives in and does not touch it.
- Waiting for a particular sender, and waiting with a deadline. Both are refused in the specs with their trigger condition recorded, not left unmentioned.
- Interrupting an in-flight turn.

## Decisions

### Attribution is rendered by the supervisor, and the protocol does not change

`render()` is already the one place a message becomes text an agent reads, and it already applies one mark. It gains a second:

| Sender | What the recipient reads |
|---|---|
| an agent | `[from a-1] Two files, both clean.` |
| the human | `[from the human] Look at the tree.` |
| the substrate | `[substrate] a-1 ended without speaking (exit 137).` |

The substrate's mark is unchanged, because the existing requirement it satisfies — a parent is never misled about who spoke — is about that mark specifically and its content already names the agent it concerns.

**Alternative considered: carry `from` structurally**, on `MessageFrame` and `AnswerFrame`, and let the runtime render it. Rejected on two counts. The model reads text at the end either way, so the forgery surface is identical and nothing is gained where it matters. And it would put message formatting inside the runtime — the component whose whole property is being byte-identical everywhere — to no purpose, when the supervisor already owns the one function that does it. Rendering at the supervisor also means **attribution costs the runtime nothing at all**, which is the right shape for a change whose other half is two declarations.

A consequence worth stating: the `message` event in an agent's transcript keeps `from: 'parent' | 'self'`. That field distinguishes the agent's own words from what it was told, which is a different question from which agent spoke, and the sender's id lives in the content where the model reads it. ENG-212 reads transcripts and should find this already true rather than inherit a field that means two things.

### The mark position is escaped, not the whole message

A mark is text, and the message beside it is text an agent wrote. A child that opens its report with `[substrate] ...` — quoting a message it was itself sent, which is how a confused agent gets here rather than a hostile one — would otherwise be read by its parent as a death report.

So: **before the supervisor prepends its own mark, a leading `[` in agent-authored content is escaped to `\[`.** The mark position is the start of the string, one character decides whether something can occupy it, and everything else in the message is untouched.

This is proportionate rather than complete, and the residual is worth naming: a mark-shaped string *in the middle* of a message is not escaped, and a model is a reader rather than a parser, so a sufficiently determined child could still mislead a careless parent. Closing that means escaping every occurrence, which mangles any message that legitimately discusses the substrate's own output — including a parent asking a child about a report it received. The threat model this epic states is a confused agent, not a hostile one, and the confused case is precisely the leading-quote one.

### The grant check goes at the top of `#request`, after the kind is known

`supervisor/AGENTS.md` prescribes the shape and one detail has to be got right around it:

```ts
if (!ROUTED.has(frame.kind)) return /* "There is no capability named …" */;
if (!this.#store.record(id).tools.includes(frame.kind)) return /* "Your record does not grant …" */;
switch (frame.kind) { … }
```

The order is the part that isn't obvious. A record never names a kind that does not exist, so a grant check placed first answers a typo with "your record does not grant `sned`" — which sends an agent to fix a grant when it has a spelling mistake. Establishing that the kind is routable first keeps the existing unknown-kind answer meaning what it says.

The per-handler checks in `#spawning` and `#stopping` are deleted rather than left as a second line of defence. Two copies of one rule drift, and the reason for the double-check that *does* remain is structural — the runtime's registry and the supervisor's channel are different paths, and only one of them a raw frame takes.

Refusal wording becomes uniform, so `spawn`'s and `stop`'s "…, so nothing was spawned" tails are lost. That is a real if minor cost: those tails told a caller that the refusal happened before anything was written. It is recovered where it matters by the position of the check — nothing is written before it — rather than by each message saying so.

### `await` takes one field, and it is the residency

```
await({ keep?: 60000 }) -> the next message, whoever sent it
```

`keep` is milliseconds and is the agent's instruction about its own container. Absent means keep nothing, which is the absence of a request rather than a default.

The description has to teach a model a thing it cannot infer: that letting its container go is *cheap*, because it resumes holding everything it knew, and costs only whatever was running inside it. A model that reads `keep` as "stay alive so I don't lose my work" will name a large number every time and the dormancy the epic's economics rest on never happens.

### `send` takes `to` and `content`

Both required, no other properties. The supervisor already validates all of it — parent-or-child, not dismissed — so the schema's job is to tell a model what it can address and that this is fire-and-forget: it returns when the message is stored, not when anyone reads it, and it does not wait for a reply. Waiting for one is `await`, and the two being separate calls is what lets a parent send four messages before collecting any of them.

### `spawn`'s tool description says what withholding costs

The one place a parent decides a child's authority is the description it reads while choosing `tools`. It currently explains the subset rule. It gains what withholding actually does — a child with no `send` still reports when its turn ends — and where a one-shot interaction belongs, which is the charter.

This is the change's one piece of pure prose, and it is load-bearing in the way this epic means: the decision is a model's, so the quality of the decision is the quality of what the model was told.

## Risks / Trade-offs

**A root record that omits a capability mutes the tree below it** → Under ENG-197's monotonicity rule no agent can grant what it does not hold, so a root without `send` makes `send` unreachable at every depth, and the failure is silent — children simply never see the tool. Every record built in `fixture.ts` and the harness names the full set, and ENG-199's acceptance run is where a root built wrong would actually show up.

**Escaping changes text an agent wrote** → A message beginning with `[` reads as beginning with `\[`. Visible, harmless, and confined to the one position where the alternative is a parent misreading who spoke.

**Two more callers on the `#settle` path** → `send` and `await` join the eight call sites ENG-214 is about, so a tree with one unprovisionable agent now has two more ways to feel it. This change makes the existing problem more reachable and does not deepen it; fixing it here would settle ENG-214's question inside one handler, which is the thing that issue exists to prevent.

**`await` without `send` is a coherent but odd grant** → An agent that can wait and cannot speak can still be woken by its children and can still report at turn end, so nothing breaks. It is simply a combination no charter is likely to want, and the substrate does not police combinations.

## Migration Plan

Nothing deployed and nothing to roll back — `agent/` is outside the build, the published package and CI, and has no consumers. The tests that assert today's behaviour change with it: `routing.test.ts`'s bare-content answers gain their marks, and the refusal strings in `spawn.test.ts` become the uniform one.

## Open Questions

None. The three that shaped this change — `await`'s signature, whether `send` and `await` are grantable, and whether attribution belongs here — were settled before it was written, and the reasoning is in the proposal's Decisions.
