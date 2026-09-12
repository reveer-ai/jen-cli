## Context

ENG-194's substrate needs one primitive before anything else in it can be built: create an isolated environment for a single agent, and destroy it. ENG-213's supervisor is the only caller; an agent never reaches it.

What makes this different from provisioning a working directory is frequency. A sandbox is created and destroyed on **every suspension**, for every agent — a container exits each time its agent goes dormant. Create/destroy is a hot path run many times per agent, so boot cost matters and leak-freeness matters far more: a resource leaked once is leaked on a schedule.

This is also the first code under `agent/`, so it stands that directory up.

Two constraints from the proposal shape everything below. The substrate is **unwired** — not built, typechecked, executed by CI, or shipped — which means nothing here may require a change at the repository root. That is a statement about where tests run, not about whether they exist: everything built here is tested, in the change that builds it. And there is **one driver**, a second having been deferred, so no second implementation will independently exercise the interface and catch an assumption that leaked into it.

## Goals / Non-Goals

**Goals:**

- A sandbox interface holding only what it needs, with nothing driver-shaped in its declarations.
- A container driver that provisions a real isolation boundary, reached by running the `docker` CLI as a subprocess.
- Credentials that reach the container without ever touching disk or a command line.
- Create/destroy that leaks nothing under repetition, and that behaves defined-ly when it goes wrong.
- Tests covering all of it, and a stated obligation to run them, since nothing automated will.

**Non-Goals:**

- The agent runtime, the supervisor, messaging, spawn, or suspend/resume. ENG-210, ENG-213, ENG-197, ENG-198.
- The JSON-lines protocol. This task provides the pipes; ENG-213 defines what crosses them.
- Any network policy, or any interface surface for one.
- A second driver, a registry, or any extension mechanism.
- Orphan sweeping. This task **labels** containers so ENG-213's sweep can find them; the sweep itself is ENG-213's.

## Decisions

### The sandbox owns two lifetimes, not one

The interface separates **sandbox** lifetime from **workspace** lifetime, because the spec requires a workspace to survive the sandbox that mounted it and to be released with the agent.

```ts
interface SandboxDriver {
  create(record: AgentRecord): Promise<Sandbox>;
  releaseWorkspace(agentId: string): Promise<void>;
}

interface Sandbox {
  exec(command: string[], options?: ExecOptions): Promise<Process>;
  destroy(): Promise<void>;
}
```

`destroy` ends one period of the agent's activity. `releaseWorkspace` ends the agent. Collapsing them would make a suspension destroy the agent's files, which is the one thing suspension must not do.

Nothing above names a container, an image, a socket, a pid, or a host path — which is the interface requirement, and with one driver it is the only thing holding the seam open.

**Rejected:** a single `destroy(mode)` taking a flag. It reads as one operation with a modifier when it is two operations with different subjects, and the failure it invites — passing the wrong mode on a suspension — destroys a day of an agent's work.

### No network operation

Policy is unrestricted, so an operation to configure it would do nothing. A no-op kept for shape is dead code that reads as a feature, and it commits the interface to a parameter shape now, on no evidence, for a policy that does not exist.

The epic anticipates the operation staying on the interface so that policy can be added "without reshaping anything." That is a small saving, and it is outweighed: when restriction does arrive it will have a definite shape — an allowlist, a proxy, a per-agent rule — and the interface should take *that* shape rather than whichever one seemed plausible beforehand. Containers get the runtime's default network, which requires no code at all.

### Creation provisions and idles; `exec` starts processes

`create` starts a container with a trivial idle entrypoint. `exec` runs a process inside it and hands back that process's stdio and exit.

The agent runtime is therefore started by `exec`, and the pipes ENG-213's JSON-lines protocol rides on are the ones `exec` returns. That keeps this task ignorant of the protocol entirely, and means the interface has one way to run a process rather than a privileged first one and a different subsequent one.

**Rejected:** making the agent runtime the container's main process, with the runtime as the entrypoint. It is fewer moving parts, but it gives the interface two shapes for running a process — one implied by creation, one explicit — and it puts the protocol's stdio into `create`'s return type, which is protocol detail leaking into the primitive that must not know about it.

### `exec` returns a streaming process, not buffered output

`exec` yields a handle carrying the process's stdout and stderr as streams, plus a promise for its exit.

The buffered alternative — resolve when the process ends, with its output collected — is simpler and is all this task's own tests need. It is the wrong choice anyway, because the only real caller is ENG-213 attaching a line-delimited protocol to a long-running process. Buffering would mean an agent's messages arrive only when the agent exits, which is precisely never for a process designed to stay up and converse.

Building the buffered form now would therefore be building something known to need replacing, and the replacement would land underneath a consumer already written against it. Tests wanting collected output can accumulate a stream in a line or two; a consumer wanting a stream cannot recover one from a buffer.

### Secrets arrive by environment passthrough, never as a command-line value

`docker` accepts `-e NAME` with no `=value`, which forwards the value from the `docker` process's own environment. So:

```ts
spawn('docker', ['run', '-e', 'ANTHROPIC_API_KEY', ...], {
  env: { ...minimal, ANTHROPIC_API_KEY: resolved },
});
```

The secret is in the child `docker` process's environment and in the container. It is in no command line and no file.

This is the one mechanism in this task that the spec's credential requirement depends on, and it matters because the obvious spellings both violate it. `-e NAME=value` puts the secret in `docker`'s argv, which is readable by every process on the host for the life of the call. `--env-file` puts it on disk, which the spec forbids outright and which reintroduces exactly the cleanup-that-can-be-interrupted problem that delivering secrets as environment exists to remove.

**To verify at implementation.** The bare `-e NAME` passthrough is documented Docker behaviour but `docker run --help` does not state it, and it could not be exercised here — no daemon was running on the machine this was designed on. Confirm it before building on it. If it does not hold, the fallback is to pipe an env block to the container's stdin and have the entrypoint read it, which is uglier but keeps both prohibitions.

### Destruction is explicit, not `--rm`

`destroy` runs `docker rm -f` rather than creation passing `--rm` and relying on exit.

`--rm` is tempting for leak-freeness, but it makes destruction implicit and untestable: a test asserting that destroy removed a container cannot distinguish it from one the daemon removed on its own, and a container that dies unexpectedly disappears with whatever would have explained why. Explicit removal makes the spec's destruction scenarios — absent, running, half-created — things this code decides rather than things the daemon happens to do.

Labels (`jen.run`, `jen.agent`) are applied at creation regardless, so ENG-213's sweep has a backstop for the case explicit removal cannot cover: a supervisor killed with containers live.

### Half-created cleanup undoes exactly what this call created

Creation is two steps — ensure the workspace volume, then start the container — and the spec requires a failure partway to leave nothing behind.

"Nothing behind" cannot mean "remove the volume", because on a resume the volume already existed and holds the agent's work. So creation tracks which resources *this call* brought into existence and unwinds only those. A failure to start the container removes the container remnant; it removes the volume only if this same call created it.

**Rejected:** unwinding everything named in the record. It is simpler and it destroys a resuming agent's workspace on a transient daemon error.

### The image comes from the record

The record names the image. The substrate provides no default and builds nothing: the project's own Dockerfile defining its toolchain is the epic's intent, and a default here would quietly become the thing everyone uses.

Tests name a small public image. That means the first test run pulls, which is slow once and cached after.

### `agent/` layout and configuration

```
agent/
  sandbox/
    index.ts        the interface and its types
    docker.ts       the container driver
    docker.test.ts
  tsconfig.json     noEmit, strict, nodenext
  vitest.config.ts  root pinned to this directory
  AGENTS.md
```

`tsconfig.json` does not extend the root's: the root sets `rootDir: "cli"` and `outDir: "dist"`, and inheriting either would put substrate output into the directory the published tarball is built from. It restates the compiler options instead — a handful of lines, and the duplication is the point, since the two are deliberately independent.

`vitest.config.ts` pins `root` to `agent/` so the run does not pick up the repository's config, which sets `fileParallelism: false` for reasons belonging to jen's own suite and not to this one.

Commands, neither of them wired into anything:

```
npx tsc -p agent/tsconfig.json
npx vitest run --config agent/vitest.config.ts
```

## Risks / Trade-offs

**[Nothing automated ever runs these tests] → a stated obligation, and a note where it will be read.** The proposal makes `agent/` unwired deliberately, and the consequence is that the tests are executed only when a person chooses to. There is no honest mitigation inside this task's scope: a nightly job or a CI step would be the fix, and both are the wiring that was deliberately declined. So the mitigation is procedural and must be explicit — `agent/AGENTS.md` records that the substrate's tests require a running daemon and are run by hand, and anyone changing `agent/` runs them before merging. This is the weakest part of this design and it should be named as such rather than presented as covered. It is a reason to test *more* carefully here, not less: a gap in coverage is caught by nothing.

**[One driver means nothing independently exercises the interface] → the interface requirement, checked by reading.** Accepted deliberately, with the reasoning in the proposal. The residual risk is *semantic* rather than nominal: an assumption about ordering, synchronicity, or stream behaviour can be true-by-accident under Docker and invisible until something else goes behind the interface. Nothing here catches that. The compensating move is to keep the interface small enough to re-read in full when a second driver is written.

**[The `-e NAME` passthrough is unverified] → verify first, fallback recorded.** Above. It could not be tested without a daemon.

**[Parsing `docker` CLI output is more brittle than a client library] → ask for machine-readable output and parse narrowly.** Prefer `--format` with an explicit template and exit codes over scraping human text, and keep parsing to the few values actually needed. The dependency-free win is worth this; a library would mean the substrate gains a manifest, which the proposal rules out.

**[First test run pulls an image] → accepted.** Slow once, cached after. The alternative is vendoring or building an image, which is more machinery than a test fixture warrants.
