## Why

ENG-194's substrate needs one primitive before anything else in it can exist: create an
isolated environment for a single agent, and destroy it. The supervisor calls it; an agent
never does.

Nothing in jen does this today. [`cli/exec.ts`](../../../cli/exec.ts) provisions a working
copy per run — a temp directory, a clone, credentials in a child's environment — and it is
the closest thing in the repository, but it is not this. Its directory is a path on the host
rather than an isolation boundary, its credentials sit in a file the run deletes afterwards
rather than dying with a container, and it runs once per stage session. The sandbox runs
**many times per agent**: a container exits every time its agent suspends on `await`
(ENG-213), so create/destroy is a hot path, and leak-freeness matters in a way it never did
for a once-per-run temp directory.

ENG-196 is also the first code under `agent/`, so it is the change that stands that
directory up.

## What Changes

- **A new top-level `agent/` directory**, holding the substrate and nothing else. It is
  **deliberately not wired into anything**: `npm run build`, `npm run typecheck`, `npm test`,
  `.github/workflows/ci.yml` and `files: ["dist"]` are all untouched, so the substrate is
  neither built by the repository's build nor shipped in its tarball. It is run by hand while
  the model is still being found.
- **`agent/tsconfig.json` and `agent/vitest.config.ts`, and no other new configuration.**
  The tsconfig is `noEmit` — a typecheck, not a build — which is what makes `strict` and
  `nodenext` apply to the new code and what stops an editor inventing a loose inferred config
  for it. There is **no `agent/package.json`**: Node resolution walks up, so `agent/` finds
  `typescript` and `vitest` in the root `node_modules` and inherits `"type": "module"`, and
  the Docker driver below takes no dependency that would require one. No new build output,
  so no new ignore rule.
- **The sandbox interface: four operations.** Root a filesystem, exec a process, configure
  network, inject secrets — plus create and destroy. Narrow on purpose, so a hosted tier can
  later put gVisor or Firecracker behind it. It is not a plugin system and gains no third
  driver.
- **A Docker driver**, which issues container lifecycle commands by running the `docker`
  binary as a subprocess — the pattern [`cli/exec.ts`](../../../cli/exec.ts) already uses
  throughout. No client library, and therefore no dependency. It is the only driver providing
  real isolation: no host directory mounted in, the container socket never mounted in,
  credentials arriving as environment so they die with the container rather than needing
  cleanup, and parallel agents never sharing a mount.
- **An in-process driver**, which is not optional and is not a fallback. A sandbox becomes a
  child process with a temp directory as its workspace — no isolation, and none intended. Its
  whole job is to let the substrate's tests and ENG-199's recursive acceptance run execute
  with no daemon, in milliseconds. It also proves the interface is an interface rather than
  `docker run` with extra steps.
- **One conformance suite, run against both drivers.** That is what actually holds the two to
  the same contract. Tests requiring real isolation are Docker's alone.
- **Network is unrestricted.** The operation exists on the interface so a policy can be
  applied later without reshaping anything; no allowlist is built or enforced. The condition
  for revisiting is egress on shared infrastructure, and it is recorded rather than left
  implicit.
- **The in-process driver must never be reachable in a real run.** Driver selection is
  explicit and the in-process driver is never the default.
- **Not in scope, and named so it is not mistaken for an oversight:** no CI check covers
  `agent/`. Nothing automated will catch a regression there until someone runs its tests by
  hand. This is a deliberate consequence of keeping the substrate unwired while its shape is
  still being found, and `design.md` carries the condition for reversing it.

## Capabilities

Every capability ENG-194 introduces is new. The substrate is a ground-up redesign rather than
an extension of the pipeline jen runs today, so it takes none of the existing capabilities as
deltas — and in particular not `repo-layout`, whose requirement is that *the CLI's* source
lives at `cli/`. The substrate is not the CLI, so that requirement stays true as written and
threading `agent/` into it would entangle the new design with the capability set it is
eventually meant to supersede.

### New Capabilities

- `agent-substrate`: where the substrate lives and what it is separate from — a top-level
  `agent/` root, self-contained, deliberately outside jen's build, typecheck, test run, CI
  and published tarball, with the conditions under which that stops being true. Thin now and
  shared by every later task in the epic, which all land in the same directory under the same
  boundary.
- `agent-sandbox`: the sandbox primitive — its four operations, the two drivers and what each
  is for, the isolation the Docker driver guarantees, the ephemeral-container/durable-workspace
  lifetime, leak-freeness across many cycles, and the failure modes (creation that fails
  halfway, destruction of something already gone, destruction of something still running).

### Modified Capabilities

<!-- None. See above. -->

## Impact

- `agent/` — new: the interface, the two drivers, the conformance suite, `tsconfig.json`,
  `vitest.config.ts`.
- **Nothing at the repository root changes.** `package.json`, `tsconfig.json`,
  `tsconfig.test.json`, `vitest.config.ts`, `.gitignore` and `.github/workflows/ci.yml` are
  all left exactly as they are — which is the point, and is worth verifying rather than
  assuming, since `test/package.test.ts:36` pins `files` to `['dist']` and `npm-package`
  requires the tarball be exactly the payload.
- `CONTRIBUTING.md` — gains how to typecheck and run the substrate, since it is the document
  `adoption-docs` requires to carry the repository's own layout and testing material. That
  requirement is satisfied by the addition rather than changed by it, so it takes no delta.
  This is the one place the substrate touches jen's existing documentation, and it touches it
  by being described there, not by changing what jen does.
- `agent/AGENTS.md` — the Docker daemon is not running on this machine, so the Docker driver
  cannot be verified locally today and its tests skip. A note recording that, and recording
  that a skip is currently indistinguishable from a pass because nothing in CI runs them.
- No changeset. Nothing here is built, shipped, or reachable from the published CLI.
