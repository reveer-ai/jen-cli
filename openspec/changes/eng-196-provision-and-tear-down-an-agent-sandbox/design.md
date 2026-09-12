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

### Secrets arrive on a process's stdin, never as a command line or as container configuration

The obvious spellings violate the spec outright. `-e NAME=value` puts the secret in `docker`'s argv, which is readable by every process on the host for the life of the call. `--env-file` puts it on disk, which the spec forbids and which reintroduces exactly the cleanup-that-can-be-interrupted problem that delivering secrets as environment exists to remove.

This design's first answer was the third spelling — `-e NAME` with no `=value`, which forwards the value from the `docker` process's own environment — and it was recorded as unverified, because no daemon was running on the machine this was designed on.

**Verified at implementation, and it does not hold.** The passthrough works exactly as documented and the secret does stay out of argv. But the runtime resolves what it is handed into the container's own configuration, where `docker inspect --format '{{json .Config.Env}}'` returns it in full for as long as the container exists. The requirement is that no file inside *or outside* the sandbox holds the secret, and a record the runtime keeps past the call is what that forbids. Writing no file oneself is not the same as no file existing.

So the recorded fallback applies — pipe the env block over stdin — with one correction found the same way. The fallback as written delivered to the **entrypoint**, and that cannot work: a process started by `docker exec` takes its environment from the container's configuration rather than from the process already running inside it, so an entrypoint that exported the block would be the only thing that ever saw it. Delivery is therefore **per process**, at the moment one starts:

```ts
spawn('docker', ['exec', '-i', name, 'sh', '-c', DELIVER, 'sh', ...command]);
// DELIVER reads NAME=value lines until an empty one, exports them, and execs "$@".
```

Creation still resolves the references, so a credential that cannot be resolved fails the creation it belongs to and unwinds with it; what moved is only when the value is handed over. The secret is then in a pipe and in one process's memory — in no argv, no file, and nothing the runtime writes down. The cost is a line protocol: a value carrying a newline cannot be delivered, and creation refuses one rather than truncating it.

**The second cost, found in review: a pipe can break, and an unattended break is fatal.** If nothing is left reading — `docker exec` refused, or the container gone between the call and the runtime's attempt at it — the write ends in `EPIPE`, which the stream emits as an `error` event. An `error` with no listener is not dropped; Node raises it as an uncaught exception, and the process it kills is the supervisor, so one agent's broken pipe would end every other agent's run with it. The listener for it goes on the stdin stream, not on the child: the child's own `error` covers a failure to spawn and nothing after. A broken pipe then surfaces through `exit` — as the subprocess's own failing exit where it has one, since its stderr accounts for the failure better than the pipe does, and as a rejection where the subprocess exited *zero*, because a command that ran without the credentials it was sent looks exactly like one that had them.

**The third cost, found in the review after that one: the receiver constrains the name more tightly than the protocol does.** The line carries `NAME=value`, so the protocol's own objections are an empty name, a newline and an `=`. The shell that reads the line refuses more than that — `1BAD`, `A-B` and `A B` all arrive intact and die in `export` with `bad variable name`. Left to creation's discretion that is the worst shape a failure can take here: creation succeeds, and every process ever started in that sandbox fails in the prologue, at a point that no longer points back at the record responsible. So the portable grammar `[A-Za-z_][A-Za-z0-9_]*` is checked at creation. The general lesson, and the one worth carrying to whatever replaces this encoding: **validate what the receiver accepts, not what the transport can carry.**

### The record is caller data, and the runtime's argument list has an option-parsing position

The record's fields are interpolated into command lines, and one of them lands somewhere that reads them as instructions rather than as values.

`docker run [OPTIONS] IMAGE …` parses options until the first operand, and `record.environment` was appended in exactly that position. An environment of `--help` is therefore consumed as a flag — which **exits zero and creates nothing**, so a creation checking only for a non-zero exit accepts it and returns a handle to a container that was never made. `--privileged` in the same position gives away the isolation this primitive exists to provide, from a record rather than from any code here.

Two things hold it, kept together because they fail differently:

- **`--` before the image.** Option parsing ends there and the next token is read as an image reference however it is spelled. This is the structural fix, and it is a property of *this* runtime's argument parser.
- **A refusal of an empty environment, or one starting with `-`.** This is a property of the module, holds against a runtime whose parser differs — which nothing here tests, and which the driver is meant to work against — and names the cause for the caller.

**Rejected:** validating the environment as an image reference. What a reference may look like belongs to the runtime and to whatever registry it talks to, and a driver deciding it here would start refusing things the runtime accepts. The narrow property is the whole of what is wrong: a leading `-` is never a legitimate reference, and it is exactly what makes a token an option.

Nothing else in the record reaches an operand position. The other interpolated fields are arguments to a flag (`--workdir`, `--volume`, `--name`), where the parser has already consumed the flag and takes the next token as its value whatever it says.

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

**[The `-e NAME` passthrough was unverified, and failed verification] → the fallback, applied per process.** Above. It kept the secret out of argv and put it in the container's configuration, which the spec forbids as surely as a file; credentials are delivered over each process's stdin instead.

**[Parsing `docker` CLI output is more brittle than a client library] → ask for machine-readable output and parse narrowly.** Prefer `--format` with an explicit template and exit codes over scraping human text, and keep parsing to the few values actually needed. The dependency-free win is worth this; a library would mean the substrate gains a manifest, which the proposal rules out.

**[First test run pulls an image] → accepted.** Slow once, cached after. The alternative is vendoring or building an image, which is more machinery than a test fixture warrants.
