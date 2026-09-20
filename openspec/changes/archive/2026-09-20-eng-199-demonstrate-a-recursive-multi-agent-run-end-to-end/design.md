## Context

See proposal.md — Why. What the design has to work within:

- **Seven of the nine criteria already have tests.** `containers.test.ts` holds suspension, `kill -9` resume and the sweep against real containers; `failure.test.ts` holds a parent woken by a child's death; `spawn.test.ts` and `routing.test.ts` hold depth, dismissal, the single messaging path and the human at the root. What none of them holds is the real runtime being the thing inside the box — every container test drives `SHELL_PEER`, and every runtime test runs in process against `scripted()`.
- **The runtime reaches its model over the network.** `runtime/model.ts` holds one seam: an OpenAI-compatible surface at a `baseURL` carried on the record. `scripted()` substitutes at that seam *in process*, which is unavailable once the runtime is inside a container.
- **`command` is already a supervisor option**, defaulting to `['jen-agent']`. Running the real runtime is a matter of supplying an image that carries it, not of changing the supervisor.
- **The boot frame arrives on standard input and nothing arrives in argv** (`runtime/boot.ts`).
- **Nothing in the substrate deletes a workspace.** `releaseWorkspace` is on the driver and is called only by `sandbox/docker.test.ts`; `policy.test.ts` asserts the supervisor's source never names it, because `destroyAll` runs after a failure — exactly when every agent's work is sitting in its workspace.

## Goals / Non-Goals

**Goals:**

- The real `jen-agent` runtime runs inside a real container, completes a turn, and spawns a chain through it.
- That run is repeatable without a model credential and without spending tokens.
- A person can start a tree, talk to its root, and see what the run is doing.
- The live pass is repeatable by someone who did not run it the first time.

**Non-Goals:**

- **No second copy of coverage that exists.** The tier asserts what the existing suites cannot, not all nine criteria again through a more expensive path.
- **No second sandbox driver, and no change to the driver interface.**
- **No change to the supervisor's surface.** If a criterion appears to need one, that is a finding to record, not licence to widen the component the epic says to keep smallest.
- **No assertion about what a live model does.** A test that asserts a model chose to delegate is a flaky test wearing the clothes of a proof.
- **No operator verb beyond start, speak, observe and shut down.**

## Decisions

### The tier covers the seam nothing else does, and stops there

One run, asserting six things — the real runtime boots in a container and completes a turn; an agent spawns an agent that itself spawns; two children run at once in isolated workspaces; a child's container killed out from under it wakes its parent rather than hanging it; the operator's process group killed mid-run comes back and finishes; and the run leaves nothing behind.

Four of those overlap something already tested, and each is kept for a reason specific to the real runtime rather than out of completeness. Resume is the sharpest: `containers.test.ts` proves it with a shell script, but `answerInterrupted` and the `#answerInLog` collision the whole suspend design is built around live in the runtime, and no test has ever exercised them with a real body in a real container. Visible failure is kept because the real driver reports a killed container's exit where the double decides what to report, and ENG-199 names both as the two that will actually find bugs.

Everything else the criteria list — the single messaging path, dismissal, the human at the root, one record type throughout — is asserted today and is not asserted again here.

### The model double is an HTTP server keyed on the model identifier

The runtime inside a container cannot be handed a JavaScript object, so the tier stands up a small OpenAI-compatible server on the host and points each record's `baseURL` at it. It implements `POST /v1/chat/completions` and nothing else.

*Why not a code seam:* an environment variable selecting a double would put a test-shaped branch inside the one component whose whole property is being byte-identical everywhere, and `policy.test.ts` reads the runtime's source precisely to prevent that class of thing. Baking the double into the image would make the image under test different from the image that ships. The `baseURL` seam already exists for this, and `model.ts` says the provider is a value in a record rather than a commitment in code — so using it costs nothing and proves the seam at the same time.

*What it dispatches on:* `model.model`, the free-form model identifier, which is already on every record and arrives verbatim in every request. A record reading `"model": "script:delegate"` gets the scripted sequence registered under that name — a `spawn` call, then `send`, then `await`; `"script:leaf"` gets a turn-ending message. Depth ≥ 2 is therefore deterministic while travelling the entire real path: capability dispatch, the protocol, the supervisor's grant check, provisioning.

*Rejected:* matching on the charter. It is substring matching against English, it breaks when a charter is reworded for reasons that have nothing to do with the test, and it re-invents what an exact field already does.

*Reachability:* the container reaches the host at `host.docker.internal`, which Docker Desktop provides and Linux Docker does not. The driver passes no network flags and **is not given any here** — adding `--add-host` to every container the substrate creates, for a test's benefit, is the driver growing a concern that is not its own. Linux is a recorded gap.

### The image pins the assistant; the manifest must not

`agent/Dockerfile`, built from `agent/` as its context, on a pinned Node base at or above the 22.18 the manifest already requires — the runtime is TypeScript executed directly, so native type stripping is a hard requirement of the base rather than a preference. The substrate is copied in and installed so `jen-agent` resolves on `PATH`; a `.dockerignore` keeps the local `node_modules` out of the context.

The headless assistant is installed **in the Dockerfile, at a pinned version**, and named nowhere in `agent/package.json`. `agent-workspace-tools` requires that no part of the substrate name a particular assistant, and a dependency entry in the substrate's own manifest would be the substrate naming one. The image provides a command and the substrate knows nothing about it — which also keeps the decision reversible, since replacing the assistant becomes an image change touching no source.

*The build-time check cannot be `--help`.* Nothing is read from argv and the boot frame is read from standard input, so `jen-agent --help` waits for input that never comes and the build hangs rather than failing. The check is `jen-agent < /dev/null`, which must exit non-zero with the boot frame's own error — proving the shebang resolves, that Node strips the types, and that `openai` is present, none of which `command -v` would notice. The assistant's check is its own `--version`, which must not require authentication.

*No credential is baked in and none is written during the build.* Credentials keep arriving per process on standard input, as `agent-sandbox` requires.

### The `kill -9` test kills the operator, not a purpose-built harness

`harness.ts` exists because a test cannot `kill -9` its own process group, and it drives `SHELL_PEER`. The tier needs the same trick against the real runtime, and the operator is already a process holding a supervisor that can be started detached. So the tier launches the operator, kills its group with containers live, and starts it again. That covers resume and the operator's own recovery in one, and avoids a second harness that would drift from the program people actually run — a harness that resumed differently from the operator would prove recovery for a program nobody uses.

*Consequently the operator distinguishes a new run from a resumed one by reading the run directory* — absent means `add` the root record with its opening message, present means `Store.open` and `resume()`. Nothing on the command line says which, because a flag there is a thing a person gets wrong exactly once, after a crash, and the store already holds the answer.

### Clean exit is the test's own sweep, and the supervisor's rule is untouched

Containers are gone because `destroyAll` ends them. Workspaces are not, by design, and this change does not add anything that deletes one: the tier releases its own volumes in `afterAll`, filtered on the run's `jen.run` label, exactly as `containers.test.ts` already does.

*Which leaves a real gap, recorded rather than closed:* a person who runs a tree by hand has no way to release its workspaces and must remove them themselves. Giving the operator a verb for it was considered and cut — no criterion asks for it, and the argument `sandbox/index.ts` makes against a flag on `destroy` ("the mistake it invites — passing the wrong mode on a suspension — destroys a day of an agent's work") is a reason to be slow about adding the substrate's first workspace-deleting path, not fast. It goes in `agent/AGENTS.md` so the next person meets it as a known gap rather than as leaked disk.

### Observation is pull, and the operator does not pretend otherwise

The operator prints what the root says and nothing else — no descendant transcripts, no tree view. That is the epic's visibility rule rather than a shortcut: transcripts are large, visibility is pull, and a parent reads a child's through `read` when the prose does not satisfy it. An operator streaming every agent's output would be the substrate re-introducing push visibility at the one seam where a human is watching.

Everything printed goes through the exported `render()`. `onMessage` is the one path that skips it — it is handed the raw `Message` — so a consumer printing `message.content` shows a person an unescaped `[substrate] …` a child could have quoted, which is the forgery `render()`'s escape exists to prevent, at the one recipient who cannot ask the substrate a follow-up question.

### Killing a child means killing its container, by label

The tier ends one child's body out from under it and asserts its parent is woken with a termination message. It does this through the container runtime directly, filtered on the run's `jen.run` label — the same way `containers.test.ts` already asserts about containers. The driver interface may not name a container and is not asked to.

## Risks / Trade-offs

- **`claude -p` may not authenticate inside a container from environment alone** → This is the live pass's point and has no fallback here: `agent-sandbox` forbids a secret reaching a file, so a login file is not available. If it fails, the finding is recorded and the assistant half becomes its own task; every structural criterion is unaffected, because nothing in the tier runs an assistant.
- **`host.docker.internal` is a Docker Desktop convenience** → The tier fails in `beforeAll` with a message naming it, the way the existing container suites already name a missing daemon, rather than failing obscurely inside a model call.
- **A scripted gateway can drift from what a real model does** → It is deliberately a proof about the substrate, not about models. The live pass covers the gap, and the two are kept apart so neither is mistaken for the other.
- **Nothing automated runs any of this** → Already true of two suites and required by `agent-substrate`. The tier is one more command a person runs by hand, documented beside the two that exist.
- **A live run leaks its workspaces** → Recorded above and in `agent/AGENTS.md`; removal is by label and is the person's.
- **The first real run may find the supervisor's unbounded provisioning retry expensive** → `supervisor/AGENTS.md` defers that question to "ENG-199's run rather than to a constant in this file". A cost is a finding to record; adding a backoff constant is policy in code and a separate decision, not a fix made in passing.

## Migration Plan

Nothing deploys and nothing migrates. The image is built locally from the working tree and pushed to no registry, which is what keeps `agent-substrate`'s exclusion of the substrate from the repository's checks and published package intact. Rollback is `docker image rm`.

## Open Questions

- **What the assistant half does if environment-only authentication proves impossible.** Deferrable: it changes no spec here, no part of the approach, and no task but the live pass's own outcome, since the assistant is reached as an ordinary command and nothing in the substrate names one.
- **What a stalled tree should make the operator *do***, beyond reporting it. `agent-supervisor` requires it be surfaced and not resolved, which reporting satisfies; whether a person wants an exit code, a prompt or something else belongs to an interface that does not exist yet, and `supervisor/AGENTS.md` already records it as open.
