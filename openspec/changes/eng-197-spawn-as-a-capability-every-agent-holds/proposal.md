## Why

ENG-213 can already honor a `spawn` request, but no agent can make one: the runtime's supervised-capability registry is intentionally empty. The substrate therefore has records, sandboxes, and a supervisor that can construct a child, but not the agent-facing capability that proves ENG-194's central claim — that the agent nobody spawned and an agent at any depth create descendants through the same path.

This change closes that seam now that its dependencies are merged. It also settles the capability boundary before later work relies on it: a parent may shape a child's charter, model, and tools, but may not create authority it does not itself hold.

## What Changes

- Add `spawn` as an ordinary supervisor-backed capability available to every runtime implementation and offered to an agent when its record names it. It declares an agent-facing schema, forwards over the existing correlated request channel, and returns the supervisor-assigned child id without waiting for the child to work.
- Construct roots and descendants from the same `AgentRecord` and the same supervisor path. A child receives `parent: <caller>`; no branch, flag, record variant, or runtime path distinguishes a root from a spawned agent.
- Let a parent compose the child's name, charter, tools, and optional model configuration at spawn time. The sandbox environment, workspace location, and credential references inherit from the parent; an overridden model must name one of those inherited credentials.
- Constrain a child's tools to a subset of its parent's tools. A request to grant a capability the parent lacks is refused observably rather than widened, silently reduced, or left to a prompt. Omitting tools grants none, preserving least authority while allowing recursive spawning when the parent explicitly grants `spawn`.
- Keep child identifiers under supervisor control, persist the child's record and parentage before acknowledging the spawn, and deliver any opening message through the same turn path used for every later parent-to-child message.
- Add `stop` as the paired agent-facing lifecycle capability over the supervisor behavior ENG-213 already supplies. It can dismiss only a direct child, dismisses that child's whole descendant subtree, and keeps every workspace because deletion is irreversible and was not requested.
- Prove non-special recursion and immediate return: an agent spawned by another agent can itself spawn through the identical capability, and several spawn calls can be outstanding so multiple children are running before the parent takes its next turn.
- Leave recursion bounds, fan-out limits, spend limits, network policy, inter-agent messaging, and result/completion semantics out of scope. Those remain where ENG-194 placed them; this change adds no scheduler, workflow engine, or privileged result channel.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-runtime`: Supply the `spawn` and `stop` supervised-capability declarations to the existing runtime registry, with assistant-facing schemas and no capability-specific branch in the reasoning loop. Records continue to select which declared capabilities an individual agent is offered.
- `agent-supervisor`: Complete the spawn and dismissal contract: homogeneous child construction, supervisor-owned ids, durable parentage before acknowledgement, optional model selection over inherited credentials, non-widening tool grants, immediate return, recursive use, direct-child dismissal, subtree teardown, and workspace preservation.

## Impact

**Code.** `agent/runtime/` gains the concrete `spawn` and `stop` declarations and registers them through the existing supervised-capability seam. `agent/supervisor/index.ts` tightens the already-present request handlers around validated input, model selection, tool non-escalation, and acknowledgement ordering. Tests extend the runtime's real entry-point coverage and the supervisor's scripted tree coverage; no new transport or process abstraction is introduced.

**Public agent-facing API.** `spawn(name, charter, tools?, model?, opening?) -> agent_id` returns as soon as the child has been durably created and started when an opening message is supplied. `stop(agent_id) -> ok` dismisses a direct child's subtree without deleting its workspaces. Both failures are ordinary capability results the calling model can reason about.

**Dependencies.** None. This uses `AgentRecord`, the generic capability interface, the JSON-lines request channel, the durable store, and the sandbox driver already delivered by ENG-196, ENG-210, and ENG-213.

**Downstream.** ENG-198 can build `send` and `await` on a tree agents can now create. ENG-199 can exercise depth-two recursion and parallel fan-out. ENG-211 and ENG-212 remain independent except that their capabilities will later use the same registry.

**Compatibility and scope.** No existing published jen API changes; `agent/` remains outside jen's build, CI, and package. No capability is granted merely because its implementation exists: the record remains the authority boundary.
