## Why

Every piece of the agent substrate is built and tested, and the thing the substrate exists to do has never once happened. `containers.test.ts` drives `SHELL_PEER` — a shell script — and every runtime test runs in-process against a scripted model. So the real `jen-agent` runtime has never started inside a real container, no agent has ever reasoned with a real model from inside a sandbox, and no agent has ever spawned another. `aRecord` names `jen/agent:latest`; nothing in the repository builds it.

That leaves the epic's load-bearing claim untested. Homogeneity — one agent type, the root structurally identical to one at depth four — is held today by source-reading tests and by a shell peer standing in for the runtime. It has never been demonstrated by an agent spawning an agent that itself spawns.

Two seams are unproven and they fail differently, which is why this change treats them separately rather than as one run:

- **The runtime in a container.** The image, the entry point, the protocol over `docker exec` stdio, the credential block, suspension and resume with a real body. Mechanical, and it either works or it doesn't.
- **A model choosing to delegate.** That a charter — not a hand-authored skill file — is what makes an agent fan work out and collect it. A judgment claim, and nondeterministic by nature.

## What Changes

- **A pinned agent image.** A Dockerfile at the substrate's root building the environment `aRecord` has been naming all along: a pinned Node base, the substrate installed with `jen-agent` on `PATH`, a pinned headless coding assistant, and a build-time check that both commands run. No credential is baked into it; credentials keep arriving per process on standard input as `agent-sandbox` already requires.
- **A minimal console operator.** A second executable that boots a supervisor over the container driver from a root record, prints what the root says through `render()`, reads a person's replies as `tell()`, and reports a stalled tree. It is the first consumer `onMessage`, `onStalled` and `onFailure` have ever had, and the thing a human sits in front of for the live pass. Nothing more: no persistence of its own, no tree view, no command language.
- **An automated acceptance tier**, covering the seam nothing else does. Seven of the nine criteria already have tests — `containers.test.ts` holds suspension, `kill -9` resume and the sweep against real containers, and `spawn.test.ts`, `routing.test.ts` and `failure.test.ts` hold the rest against the driver double. What no test holds is the real runtime being the thing inside the box. So the tier is one run proving that: the runtime boots in a container and completes a turn, an agent spawns an agent that itself spawns, two children run at once in isolated workspaces, a killed child wakes its parent, a killed process group comes back and finishes, and the run leaves nothing behind. Deterministic and free to re-run.
- **A fake model gateway for that tier.** The runtime reaches its model over the network, so a double cannot be an in-process object the way `scripted()` is. A small OpenAI-compatible server on the host, with each record's `baseURL` pointed at it, makes the tier repeatable. This uses the `baseURL` seam exactly as `model.ts` describes it and adds no branch to the runtime, so `policy.test.ts` stays honest.
- **A live pass, documented and run by hand.** Real models over OpenRouter, real charters, an agent that decides for itself to spawn, and `claude -p` authenticating inside a container from the environment alone. It costs tokens, it needs a person, and its result is written down rather than asserted.
- **Whatever the run breaks.** The task is an acceptance test and the two criteria expected to find bugs are resume and visible failure. Fixes to existing behaviour land in this change; a fix that changes a requirement adds a delta to the capability it belongs to.

## Capabilities

### New Capabilities

- `agent-image`: The environment an agent's sandbox is built from — what the substrate's own image provides, what it pins, what it must not contain, and the fact that it is the project's to replace.
- `agent-operator`: The human-facing entry point to a run. How a person starts a tree, how a root's words reach them, how theirs reach the root, and what a stalled or failing run looks like from outside.

### Modified Capabilities

None. The nine criteria are behaviours `agent-runtime`, `agent-sandbox` and `agent-supervisor` already specify; demonstrating them changes no requirement. Two adjacent requirements were read against this change and both hold as written:

- `agent-substrate` excludes the substrate from the repository's build, checks and published tarball, and names the condition for reversing that — something depending on it, or it being published. Neither becomes true here: the image is built locally from the working tree, nothing outside `agent/` imports the operator, and the acceptance tier joins the two suites CI already does not run. If the image is ever pushed to a registry, that clause fires and this exclusion is what has to be revisited.
- `agent-workspace-tools` requires that no part of the substrate name a particular assistant. The pinned assistant therefore belongs to the image and **not** to `agent/package.json` — declaring it as a substrate dependency would make the substrate name one, which is the requirement's plain words. The image provides a command; the substrate still knows nothing about it.

## Impact

**New**: `agent/Dockerfile` and whatever it needs to build; the operator program and its entry in the substrate's manifest `bin`; the acceptance tier and the fake gateway supporting it; a written record of the live pass and how to repeat it.

**Changed**: `agent/package.json` gains a second executable. `agent/AGENTS.md` and `agent/supervisor/AGENTS.md` gain what the first real run teaches — the supervisor's own note already defers the cost of its unbounded provisioning retry to "ENG-199's run rather than to a constant in this file", and this is that run.

**Unchanged**: the repository's `package.json`, `tsconfig.json`, `vitest.config.ts`, CI workflow and published tarball, all of which `agent-substrate` requires be left alone on the substrate's account.

**Depends on**: a running container runtime, and — for the live pass only — a model credential and a subscription or key the assistant can authenticate with. The automated tier needs the first and nothing else.

**Risks**: the container reaching a gateway on the host is a Docker Desktop convenience on this machine and needs explicit configuration on Linux; and the live pass may find that `claude -p` cannot authenticate from environment alone, which `agent-sandbox`'s no-secret-in-a-file rule leaves no fallback for. Both are design's to resolve.
