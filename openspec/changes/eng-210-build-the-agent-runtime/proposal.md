## Why

The sandbox exists and nothing runs inside it. ENG-196 built the primitive that isolates an agent; this change builds the process that *is* the agent — the thing the sandbox was built to hold.

It is also where the epic's load-bearing constraint stops being aspirational. ENG-194 requires that there be no type distinction between an agent and the agents it spawns, and the runtime is where that is either true or merely asserted: every container carries this same runtime, the root's included, so the root holds nothing a spawned agent lacks. A runtime that implemented the capabilities its children call would end homogeneity on its first line.

## What Changes

- **A single `AgentRecord`, declared once.** The record is the agent — id, name, charter, model, workspace, tools, parent, environment, credentials — fully serializable and inert, carrying credentials as `ref:` handles rather than values so it is safe to persist beside the project. The record used to construct the root is the same type an agent passes when it spawns one.
- **`agent/sandbox` stops declaring a record of its own.** It currently exports an `AgentRecord` with a different field set, written to exercise the container lifecycle before a real record existed. Two types of that name is precisely the divergence ENG-194 warns about, so the sandbox's declaration is removed and its `create` signature derives the fields it actually reads from the one definition. This keeps `agent-sandbox`'s existing requirement that the primitive never *receive* an agent's parent, which passing the whole record would have broken.
- **The thinking loop**, the runtime's own and distinct from the coding assistant's, reasoning through a chat-completions client with a configurable `baseURL`. A step is one model call plus its tool results; a turn ends when the agent produces a message to its parent with no pending tool calls.
- **The capability surface** — a registry of capabilities, each declaring a name, an input schema, an invocation, and optionally a stream of progress. The runtime knows that shape and nothing about any particular capability, so adding or removing one requires no change to the runtime and an empty registry is valid. No capability is implemented here.
- **Booting from a transcript.** Construction takes a record *and* a prior transcript and continues mid-conversation, indistinguishably to the model from a run that was never interrupted. This is the property the whole suspend/resume model rests on.
- **A boot frame on stdin**, amending ENG-210's stated `jen agent --record <json>`. A single argument is capped at 128 KB on Linux (`MAX_ARG_STRLEN`) whatever `ARG_MAX` allows, which a ten-turn transcript clears in ordinary use — so the transcript cannot travel in argv at all. Once it is on stdin the record joins it rather than splitting one boot input across two channels, which also keeps the charter off a command line the host's process list can read, consistent with what `agent-sandbox` already established about secrets, and makes record and transcript arrive from one source that cannot disagree with itself on a resume.
- **The substrate gains a manifest of its own**, completing the pattern it already follows with its own TypeScript and test configuration. The runtime needs a model client, and jen's root manifest may not carry a dependency on the substrate's account — the substrate is excluded from jen's published package, so its dependencies must be too. This is also the shape the runtime needs regardless: it is installed into a sandbox image, not delivered through jen's npm tarball.

## Capabilities

### New Capabilities

- `agent-runtime`: The process an agent is inside its sandbox — the one agent record, the runtime's own thinking loop over a configurable model provider, the capability surface it reaches its tools through, construction from a record plus a prior transcript, and the boot frame that carries both.

### Modified Capabilities

- `agent-substrate`: Gains a requirement that the substrate carries its own manifest and declares its own dependencies, so that adding one never reaches jen's published package. The existing requirement that the repository's `package.json` be left unchanged on the substrate's account is preserved rather than relaxed — the new manifest is what makes it possible to keep.

## Impact

**Code.** New `agent/record.ts` and `agent/runtime/`. `agent/sandbox/index.ts` loses its `AgentRecord` declaration and derives `create`'s parameter from the one definition; `agent/sandbox/docker.ts` follows the rename. New `agent/package.json`.

**Dependencies.** `openai` enters the substrate's own manifest, pointed at an OpenAI-compatible `baseURL`. Chosen over a provider-abstraction library because the gateway is already the abstraction — OpenRouter reaches every model through one wire format, so a second layer over it would buy agnosticism twice — and over a hand-rolled client because streaming tool-call delta reassembly is the one part of this surface genuinely worth not owning. Nothing enters jen's root manifest, and jen's published tarball is unchanged.

**Constraint carried into design.** The client's own agentic loop is not used. The runtime calls the model once per step and owns tool dispatch and termination itself; delegating that would hand ENG-194's central decision — that the agent's loop is its own — to a library.

**Downstream.** ENG-211 (assistant adapter), ENG-197 (spawn), ENG-198 (messaging) and ENG-212 (completion and transcript visibility) all register against the capability surface defined here. ENG-213's supervisor is the other side of the boot frame and of the transcript this runtime emits.

**Not here.** No capability implementations, no supervisor, no wiring into jen's dispatcher or CI.
