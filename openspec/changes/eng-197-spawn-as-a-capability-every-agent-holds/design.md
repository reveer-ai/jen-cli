## Context

ENG-196 supplies isolated sandboxes, ENG-210 supplies one `AgentRecord` and a runtime whose tools are selected from that record, and ENG-213 supplies the supervisor, durable store, request channel, and a preliminary `spawn`/`stop` handler. The runtime entry point still registers no supervised capabilities, so a real agent cannot call either handler. The supervisor's current spawn accepts a name and charter, copies the parent's model and credential references, assigns a child id, and boots on an opening message. It also accepts arbitrary child tool names, filters malformed tool entries silently, and ignores model selection. Those are the gaps this design closes.

The substrate remains separate from `cli/`, with no `jen run` wiring in this change. The real runtime, scripted protocol peer, and sandbox double are enough to test the capability boundary without creating a new launcher. ENG-194's invariant is stronger than a recursive test alone: the root and every descendant must have the same record shape, runtime code, and supervisor request path.

## Goals / Non-Goals

**Goals:**

- Expose `spawn` and `stop` as ordinary supervised capabilities, selected only when named by an agent's record.
- Give an agent control over a child's purpose, permitted tools, and model while keeping credentials inert and inherited, and preventing capability escalation.
- Make spawn acknowledgement mean that the child id, record, parentage, and opening message are stored and any requested boot has been initiated, not that the child has finished or succeeded.
- Demonstrate recursive spawning and several children in flight with no root-specific path.
- Expose the existing subtree dismissal through `stop` without discarding workspaces.

**Non-Goals:**

- A new agent record type, a special root capability, a parent-owned sandbox, or changes to the runtime's reasoning loop.
- `send`/`await` and child completion/result handling (ENG-198 and ENG-212), or the full acceptance run (ENG-199).
- Depth, fan-out, or spend limits; a scheduler, workflow engine, network policy, or context-management policy.
- Wiring the substrate into jen's current CLI, published package, or CI.

## Decisions

### 1. Register declarations, not spawn logic, in the runtime

Add `spawn` and `stop` declarations to the existing `SUPERVISED` registry in `agent/runtime/main.ts`, using `supervised()` to raise the named request over the correlated JSON-lines channel. Their JSON Schemas describe the inputs to the model; the runtime's generic registry still determines availability from `record.tools`. Neither `Runtime`, its dispatch loop, nor the protocol gains a spawn branch. A record without `spawn` cannot call it through the model tool surface; a descendant explicitly granted `spawn` uses the same declaration as its parent.

Alternative: put a spawn method on `Runtime` or have a parent service the child's request. Both make the root structurally special or move sandbox authority inside the tree, undoing ENG-194. Merely describing spawn in a charter also fails: it does not make the capability available or constrain it.

### 2. Treat the agent-facing input as a requested child configuration, not a second record

The `spawn` input is an object with required non-empty `name` and `charter`, optional `tools` (array of capability names), optional `model` (the same configuration shape as the record's model), and optional `opening` (the first parent message). The caller cannot supply `id`, `parent`, `credentials`, `environment`, or `workspace`. The supervisor constructs the sole `AgentRecord`: assigns an id, sets `parent` to the caller, copies the parent's environment, workspace *path inside its own isolated volume*, and credential references, and uses the parent's model unless the request names another.

An override model is accepted only if it has the record's complete model shape and its `credential` names one of the inherited credential references. The supervisor validates the resulting record before storing or provisioning it. Thus model choice is a value, not a credential-minting path. A child may later pass that same inherited reference further down the tree; no credential value enters a request, record, transcript, or command line.

Alternative: accept a whole `AgentRecord` from the caller and overwrite `id`/`parent`. That invites caller-controlled fields the supervisor does not intend to grant, duplicates construction policy on both sides of the channel, and weakens the guarantee that parentage and credentials are supervisor-derived.

### 3. Enforce non-widening tools where records are constructed

The supervisor requires every requested tool to be a string present in the parent's `tools`. A missing list means `[]`, not inheritance. A malformed list, duplicate, or unknown-to-parent name is refused before the child is stored, with an ordinary `ok: false` answer naming the problem. The child can receive `spawn` only if the parent has it and explicitly includes it. The parent can therefore create a narrower agent or one equally capable, never a wider one.

This is capability physics, not a role policy: it says what a record can authorize, not what a reviewer or accountant should decide. It is checked at the supervisor even though the runtime offers only registered tools, because the request boundary is where the new record is made and a record that silently drops or widens tools would lie to the parent about what it created. The supervisor also validates the requested model and other fields rather than relying on model-facing JSON Schema alone; schema is a guide to the model, not a trust boundary.

Alternative: inherit all tools by default, which makes every new child as powerful as its parent without the parent choosing that. Alternative: silently intersect the requested list with the parent's, which acknowledges an agent that cannot do what its parent asked. Both make delegation less legible.

### 4. Keep acknowledgement separate from child completion

`spawn` calls the supervisor's existing add path. The supervisor allocates the id from the parent's persisted child count, stores the child's record and parentage, posts the optional opening into its mailbox, and settles delivery/boot before sending the answer carrying the id. It does **not** wait for a model step, a child report, or a descendant to finish. A child without an opening remains a valid dormant agent; the parent can address it later when ENG-198 supplies `send`.

The existing per-run serial queue protects id allocation and state writes from competing requests. It also means four spawn requests may be handled in sequence, but each returns after construction rather than after child work; all four bodies can run concurrently before the parent's next model step. This is parallelism without a scheduler. Tests must assert that property, not claim that four records are written simultaneously.

Alternative: await the child's first answer before returning its id. That turns spawn into an implicit join and prevents the fan-out ENG-194 requires. Returning before persistence would make a successful answer vulnerable to a supervisor crash that loses the child it promised.

### 5. Expose `stop` without inventing a new lifecycle

The `stop` declaration takes a direct child's id and forwards it to ENG-213's existing handler. That handler refuses non-children, dismisses the selected child's entire subtree deepest first, and leaves workspaces intact. A report does not stop an agent: a child is dormant until its parent continues or dismisses it. `stop` receives the same ordinary success or refusal result as any supervised capability.

Alternative: stop only the named child. Its descendants would continue addressing a dismissed parent, leaking live bodies and undeliverable reports. Alternative: release workspaces at stop. That would delete committed-or-uncommitted work without an explicit request and conflict with the supervisor's recoverable lifecycle.

## Risks / Trade-offs

- **A malformed spawn silently creates a weaker child** → Validate every field at the supervisor and refuse rather than filter unknown tools or substitute a model. Test that a refusal leaves no record, child link, or sandbox.
- **A model override names a credential the parent did not carry** → Validate against inherited references before writing; keep the values outside records and messages.
- **Spawn acknowledged before durable parentage** → Keep the existing serialized add path and answer only after store writes and settlement; test a reopened store sees the child and its parent link.
- **Four spawns accidentally become four serial child turns** → Assert the parent receives ids while all children remain in flight, before any of them report; no child completion is awaited.
- **The runtime registry grows into capability-specific control flow** → Register declarations through `supervised()` and keep dispatch generic, with a test that the real entry point emits an ordinary `spawn` request and uses its answer as a tool result.
- **No recursion bounds yet** → ENG-194 explicitly defers them. Test recursion with a finite scripted tree; do not add a hidden depth or fan-out policy to this change.
- **The substrate has no CI coverage** → Run its own typecheck and unit suite during implementation, plus the real-container tiers when a runtime is available; this design adds no new external dependency.

## Migration Plan

There is no published API or stored-record migration. Add the runtime declarations and tighten supervisor validation in the task branch; existing roots and children whose records do not name `spawn` or `stop` behave as before. A rollback removes the new declarations and validation without rewriting the durable store. The one behavioral tightening is intentional: a request that previously widened or silently filtered a child's tools will be refused instead of creating a misleading record.

## Open Questions

None for this change. Recursion bounds, assistant usage accounting, and user-facing lifecycle controls remain assigned to later work by ENG-194.
