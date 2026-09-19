## 1. The agent image

- [x] 1.1 Write `agent/.dockerignore` excluding `node_modules` and anything else that must not enter the build context, and confirm the context size is small enough that a rebuild is quick — 848 KB, and `operator.ts` is deliberately *not* excluded because `npm link` symlinks every name in `bin` whether or not the file is there
- [x] 1.2 Write `agent/Dockerfile`: a pinned base carrying a language runtime new enough to execute the substrate's TypeScript directly, the substrate copied in and installed so its agent entry point resolves by name, and its dependencies installed from the substrate's own manifest — `node:22.18.0-bookworm-slim`, `npm ci` from the lockfile, `npm link` so the name comes from `bin`
- [x] 1.3 Add the build-time check that the agent entry point *executes* — invoked with its input closed, required to exit non-zero with its own boot-frame error — and verify by hand that the build fails when a dependency is removed — verified: a build with `node_modules/openai` removed fails on this step, where `command -v` would have passed
- [x] 1.4 Install a pinned headless coding assistant in the image and check it runs without a credential; confirm it appears nowhere in `agent/package.json` — `@anthropic-ai/claude-code@2.1.277`, `claude --version` prints `2.1.277 (Claude Code)` at build time with no credential anywhere; `manifest.test.ts` now holds both halves
- [x] 1.5 Confirm the built image carries no credential in any layer or in its configuration, and that nothing in the build takes one as an argument — `.Config.Env` is `PATH`, `NODE_VERSION`, `YARN_VERSION`; no `ARG` and no `ENV` in the Dockerfile; a filesystem grep for key-shaped strings finds only `supervisor/AGENTS.md` naming a *variable*
- [x] 1.6 Build the image and provision one agent into it by hand, confirming the runtime boots, reads its frame, and reaches its model endpoint — a two-agent tree run through `operator.ts`: real containers from `jen/agent:latest`, a child that ran `exec` and wrote a file, a parent that collected it

## 2. The scripted model gateway

- [x] 2.1 Write a small OpenAI-compatible server serving `POST /v1/chat/completions` and nothing else, dispatching on the request's model identifier — `agent/gateway.ts`; any other method or path is a `404` naming what it was asked for
- [x] 2.2 Register the sequences the acceptance run needs — one that spawns, sends and awaits; one that spawns once more; one leaf that ends its turn with a message — keyed by identifiers records name — and the step is read out of the conversation rather than from a cursor, so two agents sharing a model identifier do not share a position
- [x] 2.3 Confirm a container reaches it on the host, and make the acceptance tier fail in its setup with a message naming this when it cannot, rather than failing inside a model call — `beforeAll` runs a probe container against a registered `script:probe` and fails naming `host.docker.internal`
- [x] 2.4 Confirm the runtime's own source is unchanged by any of it — no branch, no environment variable, nothing `policy.test.ts` would find — nothing under `runtime/` is touched by this change; `policy.test.ts` passes

## 3. The operator

- [x] 3.1 Write the operator's entry point and declare it in the substrate's manifest beside the agent entry point — `agent/operator.ts`, `bin.jen-operator`; `manifest.test.ts` asserts both names and that each points at a file that exists
- [x] 3.2 Construct a supervisor over the container driver from a root record, and decide from the run directory alone whether to add the root or recover the run — with nothing in the operator's inputs selecting between them — `store.root === null` is the whole of the question, and the opening is deliberately not re-delivered to a run that already exists
- [x] 3.3 Show the person what the root says, rendered as any recipient's message is, so a child quoting the substrate's mark cannot be read as the substrate speaking — through the exported `render()`; asserted in the tier with a root whose report opens `[substrate] …`
- [x] 3.4 Read the person's input and deliver it to the root on the same path a parent's message takes — one line is one `tell()`; asserted by a root that echoes `[from the human] …`
- [x] 3.5 Report a stalled run naming the agents that are waiting, and report the substrate's own failures, resolving neither
- [x] 3.6 End the run's sandboxes on shutdown and release no workspace; confirm by hand that a run ended this way can be taken up again with its work intact — confirmed: the child's `note.txt` was still in its volume after the run was ended and started again
- [x] 3.7 Confirm the operator shows nothing from agents below the root — the grandchild's phrase is in its own transcript and in no part of the operator's output

## 4. The acceptance run

- [x] 4.1 Write the tier's setup: require a container runtime and the gateway, build or require the image, label everything with the run, and sweep containers *and* this tier's own volumes afterwards
- [x] 4.2 Assert the real runtime boots in a real container, takes a turn, and reports it — with the whole credential path in one assertion: the value the host resolved is the value the endpoint was reached with
- [x] 4.3 Assert an agent spawns an agent that itself spawns — depth ≥ 2 through the real runtime — read from stored parentage rather than from ids that look nested
- [x] 4.4 Assert two children are in flight at once, each in its own workspace, neither seeing the other's — claimed from both sides: two requests held at the gateway at one moment, and `docker ps` asked at that same moment
- [x] 4.5 Assert a child whose container is killed out from under it wakes its parent with a termination message rather than leaving it awaiting one
- [x] 4.6 Assert the operator's process group killed mid-run comes back from records and transcripts alone and finishes the work, with each agent continuing from where it suspended — the second command line is byte-for-byte the first
- [x] 4.7 Assert the run leaves no container behind, and that its workspaces survived until the tier released them itself
- [x] 4.8 Run the tier repeatedly to confirm it is deterministic, and fix or remove any assertion that is not — four consecutive runs, five tests each, ~9s per run, no flake

## 5. Fixes the run finds

- [x] 5.1 Fix what the run breaks, keeping each fix to what the run actually demonstrated; where a fix changes a requirement, add a delta to the capability it belongs to rather than editing a spec in place — one fix: a message handed to a live body and never recorded was lost when the supervisor ended that body. Found by the first run by hand, in one try. Delta added to `agent-supervisor`. Review found the fix incomplete on its third caller — a residency expiry restored the message and nothing delivered it — so the delta gains a paragraph and a scenario for it, and `#retire` is where the settle goes. Review then found that settle unbounded: anything queued behind a shutdown reaches it over a closed run and provisions a body for an agent the run has finished with. The bound is one line in `#settle` rather than at `#retire`, because a late frame and an outside `tell()` arrive the same way; the delta gains a sentence and a scenario for it, and there is a regression test per entrance
- [x] 5.2 Record whether the supervisor's unbounded provisioning retry costs anything real — the question `supervisor/AGENTS.md` defers to this run — as a finding, without adding a backoff, a ceiling or any other constant to the supervisor — measured and recorded there: zero attempts while idle, ~13ms each per external event, and the number worth knowing is the settle loop's doubling rather than the retry

## 6. The live pass

- [x] 6.1 Write down how to perform the live pass: the records, the credentials it needs, what to watch, and what each criterion looks like when it passes — `agent/LIVE-PASS.md`
- [ ] 6.2 Run it against real models with charters rather than scripts, and record whether an agent reaches depth 2 by its own judgment — as a finding, not an assertion
- [ ] 6.3 Verify a headless coding assistant authenticates inside a container from its environment alone, with no login file; if it cannot, record exactly how it failed and raise it as its own task rather than reaching for a file
- [ ] 6.4 Record the result of the live pass on the task, including anything it found that the automated tier cannot see

> 6.2–6.4 are a person's and are deliberately left open: they cost tokens, they need
> credentials this pipeline does not hold, and their outcome is a finding rather than an
> assertion. Nothing else in the change depends on them. `agent/LIVE-PASS.md` is what makes
> them repeatable by someone who did not run them the first time.

## 7. Notes and verification

- [x] 7.1 Record in `agent/AGENTS.md` what the first real run taught, including that a run's workspaces outlive it and their removal is the person's, and that reaching a host service from a container is configured differently outside Docker Desktop — and three more: why the build check cannot be `--help`, why the assistant belongs to the image, and that the operator's shutdown is the end of its input
- [x] 7.2 Run the substrate's typecheck and its full test suite, including both tiers that need a container runtime, and report which were actually run rather than reporting the ones that could be — **all of it was run**: `tsc -p agent/tsconfig.json` clean, and 457 tests across 24 files, including `sandbox/docker.test.ts`, `supervisor/containers.test.ts` and the new `acceptance.test.ts` against a real daemon. Re-run after review's changes: **459 tests across 24 files**, the repository's own 444, `npm run build` and `npm run typecheck` clean, and the new build guard confirmed by breaking `agent/Dockerfile` with a stale tag on the machine
- [x] 7.3 Confirm the repository's own manifest, TypeScript configuration, test configuration, CI workflow and published tarball are unchanged on the substrate's account — `git diff main...HEAD` touches nothing outside `agent/` and `openspec/`; `npm pack --dry-run` selects 28 entries, none under either; the repository's own suite passes (444 tests)
- [x] 7.4 Run `openspec validate --strict` on the change
