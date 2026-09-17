## Context

See proposal.md — Why. What shapes the approach is what already exists.

The supervisor holds every transcript and already serves `read`: it checks the target descends
from the caller, slices by `from`/`count`, and answers with `{ id, from, total, events }` or a
refusal. `read` is in `ROUTED` and in `EVERY_CAPABILITY`. None of that is being rebuilt.

Two constraints decide the rest:

**A workspace is a Docker named volume, not a host directory.** The driver mounts
`jen-workspace-<id>` at the record's workspace path and deliberately mounts nothing of the
machine's. The supervisor is a host process; it cannot write into a workspace without starting a
container against that volume or `docker exec`-ing into a live one.

**The runtime is already inside the container, with the volume mounted**, and it is what receives
the supervisor's answer.

Those two together are the whole design.

## Goals / Non-Goals

**Goals:**

- An agent whose record names `read` can call it and see what a descendant actually did.
- Reading a transcript of any size costs the caller a path, not a transcript.
- Adding `read` touches the runtime's declaration list and nothing else structural — no branch in
  the reasoning loop, the dispatcher, or the protocol.

**Non-Goals:**

- Changing what the supervisor stores, serves, or authorizes. ENG-213's `#reading` stands.
- A general mechanism for other capabilities to write results to the workspace. The population is
  one; a framework for it would be machinery with no case to answer.
- Streaming, tailing, or watching a live transcript. A read is a snapshot.
- Preventing a parent from granting `read` without a way to read files.

## Decisions

### The transcript is written to the workspace; the model is given the path

**Why not return the content.** The epic's test is that reading a 50,000-token transcript must not
pull 50,000 tokens into the caller's context. A result is carried again on every later model call,
so a transcript returned once is paid for repeatedly — the cost is not the read, it is the rest of
the parent's life.

**Why not a bounded excerpt.** The obvious alternative is the task's own phrasing: serve "last N
steps, or a slice", cut at the limit `fs` and `exec` use. It was rejected because the paging
semantics it requires — offsets, counts, a total to subtract from, negative indices to reach the
end — are a worse version of tools the agent already has. `tail -50`, `sed -n '300,350p'` and
`jq 'select(.type=="tool_call")'` are better at this than any argument set designed here, and they
cost the agent nothing to learn. Designing offset arithmetic for a model to perform is designing a
reliable source of off-by-one errors.

**Why not both — a file plus a small excerpt in the result.** Considered and dropped for
simplicity. Two surfaces means every caller decides which to use, and the excerpt is the wrong
answer often enough (it is the *start* or the *end*, never the part that mattered) that it would
mostly be ignored while still costing context on every call. One path, no choice.

**What this makes worse, and it is accepted:** a parent holding `read` but neither `fs` nor `exec`
receives a path it cannot open. The alternative is `read` implying a grant of `fs`, which would
make it the first capability that silently widens another — a worse property than a grant that is
merely useless, because it is invisible at the point the grant is made. `agent-runtime` already
requires a capability's description to say what withholding it costs; this goes there.

### The runtime writes the file, not the supervisor

Forced by the volume. Having the supervisor write would mean it starting a container against an
agent's workspace or executing inside a running one — the supervisor reaching into a container,
which it does nowhere else and which is a larger authority than routing a message.

The runtime is in the container already. It receives the answer, writes it, returns the path. The
transcript crosses the channel as one frame and never enters the model's context, which is the
only cost that was ever at stake: a 200KB line over a pipe is free.

### `read` is one capability that both raises a request and works in place

The substrate has had two disjoint kinds: `spawn`/`stop`/`send`/`await` raise and do nothing
locally; `fs`/`exec` work locally and raise nothing. `read` is the first of a third shape.

This is a smaller change than it sounds. A capability is a name, a description, a schema and an
`invoke`; `fs` already has an entirely custom `invoke`. What `read` needs is for `supervised()` to
let a declaration do something with the answer before returning it — and what must *not* change is
the loop, the dispatcher, or the protocol, none of which can tell the difference. The runtime's
requirement is that no capability has a path of its own through those three, not that a
capability's own body is uniform.

### Ranges stay on the wire and are hidden from the model

The supervisor's `from`/`count` are how the runtime pages the transcript down to write it without
holding the whole thing in memory. Nothing ENG-213 shipped is removed, and the agent-facing schema
is `{ id }` alone.

### The file is `.transcripts/<id>.jsonl` in the caller's workspace, overwritten per target

**JSONL** because the store is an ordered event log and one event per line is the shape `grep`,
`jq`, `wc -l` and `tail` all expect. A JSON array would force a parse before any question could be
asked of it.

**Keyed by target id, overwritten**, so re-reading a child refreshes its file rather than
accumulating one per call. A parent that reads four children holds four files, bounded by the
number of descendants it inspects rather than by how often it looks.

**A reserved directory rather than a namespace.** `.transcripts/` names exactly what is in it.
Nothing else is written to a workspace by the substrate today, and inventing `.agent/` or `.jen/`
to hold a population of one is machinery ahead of a case for it.

### The provider's opaque reasoning payload is kept in the file

`ReasoningEvent.opaque` exists so projection can replay reasoning verbatim, and a parent inspecting
a child is not replaying. It would be dropped if it cost context — on disk it costs nothing, and
keeping it means the read boundary holds no per-field rule about which parts of a stored event
were "only for replay". What is stored is what is written.

## Risks / Trade-offs

- **The file is a snapshot and a working child's transcript moves on.** → Calling `read` again
  overwrites it, so refresh and read are one operation rather than a read plus a poll. The
  description says the file is current as of the call.
- **A parent granted `read` alone gets an unusable path.** → Stated in `read`'s description and in
  `spawn`'s guidance on what withholding costs, which is where the substrate already handles this
  class of problem. Not prevented.
- **A large transcript written into a workspace consumes the volume.** → It is a second copy of
  something the supervisor already stores, bounded by descendants-inspected rather than by calls.
  No new bound is introduced; the supervisor's own store has the same property and no mechanism
  guarding it.
- **`.transcripts/` could collide with a path the agent chose.** → It is the agent's own workspace
  and `fs` can write there; a parent that puts its own files under `.transcripts/` will have them
  overwritten. Accepted rather than guarded — a reserved name that an agent must be prevented from
  using is a rule needing enforcement in `fs`, which is a cost out of proportion to the collision.
- **Writing the file is work that can fail** — a full volume, a permission error — after the
  supervisor has already answered. → The failure is returned as a failed capability result naming
  what happened, like any other. The transcript is not lost; it is still in the supervisor's store
  and the call can be repeated.

## Migration Plan

Additive. The runtime offers `read` only to a record that names it, and no existing record does;
an agent constructed before this change behaves identically after it. Nothing stored changes shape,
so no transcript, record or workspace needs migrating, and rollback is the removal of a declaration.
