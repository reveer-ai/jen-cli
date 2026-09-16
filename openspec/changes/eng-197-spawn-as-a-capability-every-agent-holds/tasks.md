## 1. Agent-facing capability declarations

- [ ] 1.1 Declare `spawn` and `stop` with precise descriptions and JSON Schemas for their inputs; `spawn.model` is a non-empty reasoning-model identifier string, never a provider/endpoint/credential object.
- [ ] 1.2 Register both through `supervised()` in the runtime entry point, leaving the reasoning loop and request protocol generic and allowing `record.tools` to select availability.
- [ ] 1.3 Test the real runtime entry point against a local model-protocol stub: the model is offered only record-named tools, its `spawn` tool call becomes a supervisor request, and the correlated answer becomes an ordinary tool result on the next model step. Confirm no SDK automatic tool runner is used.

## 2. Supervisor spawn boundary

- [ ] 2.1 Require the caller's record to grant `spawn`, then validate required name/charter and optional opening, tools, and model identifier at the request boundary; refuse malformed inputs without creating a child.
- [ ] 2.2 Construct the child from the sole `AgentRecord` shape with supervisor-owned id and parentage, inherited environment, workspace path, credential references, provider, endpoint, and credential name, and only an optional replacement of `model.model`.
- [ ] 2.3 Require every child tool to be present in the parent's tools, default an omitted list to none, and refuse malformed, duplicate, or widening lists rather than filtering them silently.
- [ ] 2.4 Test inherited and overridden reasoning models, including refusal of empty identifiers and attempted provider/endpoint/credential overrides; verify model selection does not alter any separate coding-assistant capability or credential reference.
- [ ] 2.5 Test a rejected spawn through a raw protocol frame from a caller lacking `spawn`; confirm no child record, parent link, mailbox entry, or sandbox is created.

## 3. Recursion, fan-out, and durable acknowledgement

- [ ] 3.1 Test a root spawning a child that itself spawns a grandchild, using the same runtime declaration, record type, and supervisor path at both depths.
- [ ] 3.2 Test an opening message reaching the child's first turn by the ordinary parent-message path, and a child with no opening remaining valid and dormant.
- [ ] 3.3 Test four immediate spawn requests returning distinct ids while all four children remain in flight before the parent's next model step; do not wait for a child report to acknowledge any spawn.
- [ ] 3.4 Reopen the durable store after acknowledgement and verify each child's record, parent link, and opening mailbox entry survived.

## 4. Stop and handoff checks

- [ ] 4.1 Register and test `stop` through the same generic runtime path, with ordinary success and refusal results visible to the model.
- [ ] 4.2 Test the supervisor's grant and direct-child checks, full subtree dismissal, no live descendant bodies, and preserved records, transcripts, and workspaces; a child report alone must leave it available.
- [ ] 4.3 Run `npx tsc -p agent/tsconfig.json` and `npx vitest run --config agent/vitest.config.ts`; run the real-container tiers if a container runtime is available and explicitly report if it is not.
- [ ] 4.4 Run `openspec validate eng-197-spawn-as-a-capability-every-agent-holds --strict` and record any new convention or non-obvious gotcha in the nearest applicable `agent/AGENTS.md` only if one was actually learned.
