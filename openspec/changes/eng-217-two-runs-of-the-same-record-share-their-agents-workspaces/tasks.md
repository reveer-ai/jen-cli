## 1. Name the workspace after the run and the agent

The composition, decided here because `proposal.md` deliberately carries no `design.md` and
this is the whole of the mechanism:

```ts
function readable(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 32);
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 10);
}

/** Unchanged output: one part, so nothing is joined. */
function slug(agentId: string): string {
  return `${readable(agentId)}-${digest(agentId)}`;
}

/** The workspace of one agent of one run. */
function workspaceName(run: string, agentId: string): string {
  return `${WORKSPACE_PREFIX}-${readable(run)}-${readable(agentId)}-${digest(run, agentId)}`;
}
```

Three things about it are load-bearing and are the reason it is written down rather than left
to be re-derived:

- **`\0` is what makes the readable parts safe to be lossy.** A run name is free text — the
  store uses one as a directory name — so `readable` is lossy on both parts by design, and a
  digest over `run + agentId` would let `("ab", "c")` and `("a", "bc")` name one volume. The
  separator cannot occur in either part, so the digest identifies the pair exactly.
- **One digest, not two stacked `slug` calls.** The thing being named is the pair, so it
  carries one identity; `slug`'s own doc comment already separates the job the digest does
  from the job the readable part does. Two slugs would run the identity mechanism twice and
  bury the run's legible name behind a hash, in exactly the list — `docker volume ls` — a
  person reads while debugging this defect's symptom.
- **`slug` keeps its current output byte for byte**, since a single part is joined with
  nothing. Container names are built from it and do not move, and the tests asserting them
  stay green.

- [ ] 1.1 Split `slug` in `agent/sandbox/docker.ts` into `readable` and `digest` as above,
      leaving `slug` as their composition and its doc comment pointing at both.
- [ ] 1.2 Give `workspaceName` the run parameter and the composition above, with a doc comment
      saying a workspace belongs to one agent **of one run** and why — the store is per-run and
      the volume must not disagree with it.
- [ ] 1.3 Pass the driver's `#run` at both call sites: `create` (`docker.ts:291`) and
      `releaseWorkspace` (`docker.ts:384`).
- [ ] 1.4 Confirm `releaseWorkspace(agentId)` keeps its signature and `agent/sandbox/index.ts`
      is untouched. `agent-sandbox` forbids a run identifier on the interface — a driver is
      constructed for a run and knows its own — and `index.test.ts` asserts `SandboxDriver`'s
      members while `policy.test.ts` asserts the supervisor never names `releaseWorkspace`.
- [ ] 1.5 Confirm nothing else derives a volume name or sweeps volumes by label: `destroyAll`
      lists containers only and must keep doing so, and `#unwind` is handed the name `create`
      already computed.

## 2. Prove it against a real runtime

`agent/sandbox/docker.test.ts` needs a running container runtime and **nothing in CI runs
it** — see `agent/AGENTS.md`, *Neither suite runs anywhere but on a machine someone started a
runtime on*. Start the runtime and run it; if you cannot, say so in those words rather than
reporting the suites you could run as though they were the suite.

- [ ] 2.1 Add the regression to `agent/sandbox/docker.test.ts`: two drivers with different
      `run` options and **one** agent id (not `request()`'s, which already embeds `RUN`). The
      first writes a file to its workspace; the second's agent finds an empty workspace and
      cannot read it; the first's file is still there.
- [ ] 2.2 Release both workspaces explicitly in that test's `finally`. The file's `afterAll`
      sweeps on `label=jen.run=${RUN}` and the second driver's volumes carry a different run —
      the same reason the existing *does not reach another run's sandboxes* test cleans up its
      own, and after 1.2 that sweep is finally telling the truth.
- [ ] 2.3 Add the label-sweep assertion, which is the one that only means anything once the
      name is per-run: after both runs exist, `volume ls --filter label=jen.run=<run>` selects
      exactly that run's volumes and none of the other's.
- [ ] 2.4 **Confirm 2.1 fails against the current code**, by stashing the `docker.ts` change
      and running it. A regression that passes before the fix is testing something else.
- [ ] 2.5 Add the recovery case: the same run name and the same agent id, provisioned through a
      second driver, finds the workspace as it was left. This is the case the change could
      plausibly break and the one `specs/agent-sandbox/spec.md` names — a run taken over keeps
      its name, so its volume names must not move.
- [ ] 2.6 Run `npx vitest run --config agent/vitest.config.ts` in full, plus
      `agent/supervisor/containers.test.ts` and `agent/acceptance.test.ts`, which also need a
      runtime and also build workspaces.

## 3. Rewrite the two notes this makes wrong

Both were written by ENG-216's delivery and describe the defect as a standing hazard. Left
alone they become stale cautions about something that can no longer happen, which is worse
than no note.

- [ ] 3.1 `agent/AGENTS.md`, under *Creation assumes one call at a time per agent*: replace the
      paragraph beginning "**Two agents in different runs with the same id are not different
      agents to `workspaceName`, though.**" with what the naming now guarantees. Keep the
      surrounding same-agent-concurrency hazard, which is untouched by this change and still
      real.
- [ ] 3.2 `agent/LIVE-PASS.md`, under *Afterwards: the workspaces are yours*: remove the
      "**Check that list before you run it…**" paragraph. Removing by label is correct again,
      in both directions, and that is the whole point of the change.
- [ ] 3.3 Confirm the findability block in `agent/AGENTS.md` under *A run's workspaces outlive
      the run, and removing them is yours* needs no edit — `docker volume ls --filter
      label=jen.run=<run>` becomes true as written rather than changing.
- [ ] 3.4 Judge whether anything here clears the bar for a *new* note. Probably not: the
      guarantee belongs in `workspaceName`'s doc comment and in the spec, and a note repeating
      them earns nothing.

## 4. Close the change out

- [ ] 4.1 `npx openspec validate eng-217-two-runs-of-the-same-record-share-their-agents-workspaces --strict`.
- [ ] 4.2 `npm run typecheck`.
- [ ] 4.3 Check the delta against the main specs once more at requirement granularity, per
      `openspec/changes/AGENTS.md` — `--strict` reads only what the delta names. `proposal.md`
      records the two neighbouring requirements already read and kept, with reasons; confirm
      they still hold against what was actually written.
- [ ] 4.4 **No migration.** Existing `jen-workspace-<agent>` volumes on a developer's machine
      become orphans under the new naming. jen has no adopters and never installs its own
      payload, so they are removed by name — a line in the delivery comment, not a mechanism.
