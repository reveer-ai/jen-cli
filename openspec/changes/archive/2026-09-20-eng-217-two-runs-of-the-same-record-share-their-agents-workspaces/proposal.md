## Why

A workspace volume is named from the agent id alone:

```ts
function workspaceName(agentId: string): string {
  return `${WORKSPACE_PREFIX}-${slug(agentId)}`;
}
```

No run in it, and `slug` is a deterministic digest of its argument. **The store is per-run —
`~/.jen/runs/<run>/agents/<id>` — and the volume is not.** So a second run started from the
same record file hands its `chief-1` the volume the first run's `chief-1` filled. The agent
begins its first turn in a workspace already holding another run's files, carrying a
transcript that knows nothing about them.

The container name does not have this problem: `create` appends four random bytes, so two
runs never collide there. It is the workspace, and only the workspace, that is shared.

**The labels do not give it away either.** `#ensureWorkspace` labels a volume only when it
*creates* one, so a reused volume still carries the `jen.run` of whoever made it first. Three
live runs left five volumes where they should have left ten:

```
jen-workspace-live-chief-e9abdfc989   | jen.agent=live-chief,   jen.run=live-2
jen-workspace-live-chief-1-6b65a24c17 | jen.agent=live-chief-1, jen.run=live-3   ← live-4 reused it
jen-workspace-live-chief-2-bc73b300e1 | jen.agent=live-chief-2, jen.run=live-3   ← live-4 reused it
jen-workspace-live-chief-3-c60835e6ae | jen.agent=live-chief-3, jen.run=live-3   ← live-4 reused it
jen-workspace-live-chief-4-3f6f2df0cc | jen.agent=live-chief-4, jen.run=live-4
```

**It reaches a person two ways.** One run's work is read as another's, which is a confusing
thing to debug and a quiet way to get a wrong answer rather than an error. And label-based
cleanup is wrong in *both* directions against it — `docker volume ls --filter
label=jen.run=live-1 | xargs docker volume rm` misses volumes an earlier run created and
removes volumes a later run is still using. Reached by running the same record twice under
different run names, which is exactly what `agent/LIVE-PASS.md` tells a reader to do.

Pre-existing and verified as such: `workspaceName` and `slug` are byte-identical to what was
on `main` before ENG-216, whose only edit to `agent/sandbox/docker.ts` was the `#remove`
tolerance. Found while cleaning up after ENG-216's live passes.

## What Changes

**Key the volume on the run and the agent, so a second run of the same record starts clean.**
The driver already holds `#run` from its construction options, so nothing new has to be
plumbed to it and nothing new appears on the interface — which matters, because
`agent-sandbox` forbids a run identifier from appearing there at all.

- **`workspaceName` takes the run as well as the agent**, and both call sites — creation, and
  `releaseWorkspace` — pass the driver's own. `releaseWorkspace(agentId)` keeps its signature:
  a driver is constructed for a run and knows its own.
- **It matches the store**, which is already per-run. A run's transcripts and its workspaces
  should not disagree about which run they belong to.
- **Recovery is unaffected**, and this is the case to check rather than assume: taking over a
  run keeps that run's name, so every volume name is stable across a recovery and a resumed
  agent finds its files as it left them.
- **The label lie stops existing rather than being fixed.** Reuse across runs becomes
  impossible, so a volume's `jen.run` can only ever name its own run, and label-based sweeps
  become correct in both directions.
- **Two notes written by ENG-216's delivery become wrong and are rewritten, not left**: the
  paragraph in `agent/AGENTS.md` under *Creation assumes one call at a time per agent*
  describing the collision, and the cleanup guidance in `agent/LIVE-PASS.md` telling a reader
  to check the list before removing by label. Once this lands, removing by label is correct
  again and the warning should go rather than linger as a stale caution.
- **No migration.** jen has no adopters and never installs its own payload, so existing
  volumes on a developer's machine are orphans to remove by name — a line in the delivery
  comment rather than a mechanism.

**Rejected: keeping the sharing and making it honest by re-stamping labels on reuse.** It
makes the sweep correct and leaves the debugging trap in place, which is the substantive half
of the harm.

**Rejected: refusing creation when a volume belongs to another run.** Loud, but it makes a
second run of the same record impossible without a manual cleanup, for no gain over a fresh
volume.

## Capabilities

### New Capabilities

None. This is an existing requirement that does not hold in a case it was silent about.

### Modified Capabilities

- `agent-sandbox`: *Containers are ephemeral and workspaces outlive them* says the workspace
  outlives the sandbox that mounted it and belongs to "the same agent". It is silent on runs,
  which is why the code could key on the agent alone without contradicting anything. Adds that
  a workspace belongs to one agent **of one run**, with a scenario for two runs of the same
  record.

**Two neighbouring requirements were read against this and kept.** Both were reached by
grepping the main specs for the behaviour rather than for the files being edited, per
`openspec/changes/AGENTS.md`:

- `agent-sandbox`, *The container driver isolates the agent from the host and from other
  agents*, says "Two sandboxes live at the same time SHALL be unable to read or write each
  other's workspace". That already forbids the concurrent half of this defect and stays true
  word for word. It is scoped to sandboxes alive together, so it says nothing about the
  sequential case — a run that has finished and a run that starts afterward — which is the
  case actually observed and the one the delta closes. The silence is in the requirement that
  says what a workspace *belongs to*, which is the one being modified.
- `agent-supervisor`, *Spawn inherits references and cannot widen authority*, says "The
  child's sandbox workspace SHALL remain isolated by the child's own id". A parent and its
  child are always in the same run, so the id is still exactly what distinguishes their
  workspaces and the sentence stays true and load-bearing. Modifying it would replace the
  whole requirement block and force three untouched scenarios to be copied verbatim to sharpen
  one clause that is not wrong.

## Impact

- `agent/sandbox/docker.ts` — `workspaceName`'s signature and body; the two calls to it, at
  `create` and `releaseWorkspace`.
- `agent/sandbox/docker.test.ts` — the regression: two drivers with different `run` options
  and the same agent id each get their own volume. Plus the label sweep, which is the
  assertion that only makes sense once the name is per-run.
- `agent/AGENTS.md` — the collision paragraph under *Creation assumes one call at a time per
  agent*, rewritten to describe what the naming now guarantees. The findability block under
  *A run's workspaces outlive the run* becomes true as written and needs no edit.
- `agent/LIVE-PASS.md` — the "check that list before you run it" caution under *Afterwards: the
  workspaces are yours*, removed.
- **Nothing on the sandbox interface.** `agent/sandbox/index.ts` is untouched, and so is
  `SandboxDriver`'s shape — `index.test.ts` asserts its members and `policy.test.ts` asserts
  the supervisor never names `releaseWorkspace`.
- No change to records, transcripts, the store, the supervisor, or the operator. No change to
  container naming, which was never affected.

## Artifacts

Proposal, specs, tasks. **No design.md, deliberately** — the fork this change turns on was
settled before it was written, and both rejected alternatives and the reasons for rejecting
them are recorded above, which is where someone asking "why not just re-stamp the labels?"
will look. A design artifact would restate that and decide nothing; the mechanism detail that
would otherwise justify one is small enough to carry in `tasks.md`.

The specs delta is the artifact this change could least afford to skip. The requirement it
touches *permits* the defect rather than forbidding it: it describes a workspace as the
agent's and never says which run's agent, and the code implemented that silence correctly.
Fixing the code alone would leave a spec that still permits the sharing for the next reader to
implement against.
