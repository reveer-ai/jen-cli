## 1. Verify the one mechanism the design rests on

- [x] 1.1 Start the container runtime's daemon and confirm it is reachable. The machine this change was designed on had it installed but not running, so no step below has been exercised against a live daemon.
- [x] 1.2 Confirm that `docker run -e NAME` with no `=value` forwards the value from the `docker` process's own environment into the container. Verify by running a container that echoes the variable, with the value present only in the spawned process's environment. If this does not hold, stop and apply `design.md`'s fallback — piping an env block to the container's stdin — before writing the driver, because the credential requirement depends on it and both obvious alternatives violate the spec.
  - **Outcome: the passthrough forwards the value, and is unusable anyway.** The runtime resolves it into the container's configuration, where `docker inspect --format '{{json .Config.Env}}'` returns it in full for the container's lifetime — a file outside the sandbox holding the secret, which the spec forbids. The fallback applies, and it had to move: `docker exec` builds a process's environment from the container's configuration and not from PID 1, so an entrypoint that read the block would be the only thing that ever saw it. Delivery is per process. See 4.3.

## 2. Stand up `agent/`

- [x] 2.1 Create `agent/tsconfig.json`: `noEmit`, `strict`, `noUncheckedIndexedAccess`, `nodenext` module and resolution, `types: ["node"]`, covering `agent/`. Do not extend the root config — it sets `rootDir: "cli"` and `outDir: "dist"`, and inheriting either would aim substrate output at the directory the tarball is built from.
- [x] 2.2 Create `agent/vitest.config.ts` with `root` pinned to `agent/` and an include covering `agent/**/*.test.ts`, so the run does not pick up the repository's own config.
- [x] 2.3 Confirm `npx tsc -p agent/tsconfig.json` and `npx vitest run --config agent/vitest.config.ts` both run, and that neither writes compiled output anywhere.
- [x] 2.4 Confirm the repository root is untouched: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `.gitignore` and `.github/workflows/ci.yml` unchanged, and no `agent/package.json` created.

## 3. The interface

- [x] 3.1 Write `agent/sandbox/index.ts`: the `AgentRecord` fields this task needs (id, image, workspace, credential references), `SandboxDriver` with `create` and `releaseWorkspace`, `Sandbox` with `exec` and `destroy`, and the process handle `exec` returns.
- [x] 3.2 Give `exec` a streaming process handle — stdout and stderr as streams plus a promise for exit — not buffered output. ENG-213 attaches a line-delimited protocol to a long-running process, and buffered output would arrive only when that process exits.
- [x] 3.3 Verify by reading that no declaration in `index.ts` names a container, an image reference, a daemon socket, a process identifier, or a host filesystem path. With one driver this reading is the only thing holding the interface independent, so it is a real step rather than a formality.
- [x] 3.4 Confirm the interface declares creation, process execution, destruction and workspace release, and nothing further — in particular no network configuration operation.

## 4. The container driver

- [x] 4.1 Write `agent/sandbox/docker.ts`, reaching the runtime by running the `docker` CLI as a subprocess. No client library, and no dependency added to the repository's manifest.
- [x] 4.2 Implement `create`: ensure the agent's workspace volume, then start a container from the record's image with a trivial idle entrypoint, the volume mounted at the workspace path, and `jen.run` / `jen.agent` labels applied.
- [x] 4.3 Deliver credentials by resolving each reference at creation and sending it to each process as it starts, over that process's own stdin: `docker exec -i … sh -c DELIVER sh <command>`, where `DELIVER` reads `NAME=value` lines until an empty one, exports them and `exec`s the command. Creation passes the runtime no environment at all. Never `-e NAME=value`, which puts the secret in argv where every process on the host can read it; never `--env-file`, which puts it on disk; and never bare `-e NAME`, which keeps it out of argv and puts it in the container's configuration instead — see 1.2. A value containing a newline cannot ride a line protocol, so creation refuses one, naming the credential and never the value. The *name* is constrained by the receiving shell rather than by the protocol, and more tightly: `1BAD` and `A-B` ride the line intact and then fail in `export` with `bad variable name`, which would kill every process ever started in that sandbox. Validate `[A-Za-z_][A-Za-z0-9_]*` at creation instead. Listen for `error` on every pipe of the spawned process: an `EPIPE` from an unread credential block is emitted on the stdin stream rather than on the child, and unhandled it terminates the supervisor.
- [x] 4.4 Mount no host directory, and never the runtime's socket.
- [x] 4.5 Implement `exec` over `docker exec`, returning the streaming handle from 3.2.
- [x] 4.6 Implement `destroy` as an explicit `docker rm -f`, not by passing `--rm` at creation, so destruction is this code's decision and is observable in a test.
- [x] 4.7 Implement `releaseWorkspace` to remove the agent's volume, separately from `destroy`.
- [x] 4.8 Make creation unwind exactly what it created on a partway failure: remove the container remnant, and remove the volume only if this same call created it. A resuming agent's volume already holds its work and must survive a transient failure.
- [x] 4.9 Make `destroy` succeed on a sandbox that is already gone, and stop and release one whose process is still running.
- [x] 4.10 Make an absent or unreachable daemon a creation error naming the cause, with no fallback to anything less isolated.
- [x] 4.11 Where `docker` output must be read, request machine-readable output with an explicit `--format` template and parse only the values actually needed.
- [x] 4.12 Keep the record's fields out of the runtime's option-parsing position. `record.environment` is an operand, so pass `--` before it — after which the runtime reads the next token as an image however it is spelled — and refuse an empty environment or one beginning with `-`, which is what holds on a runtime whose parser differs. Not an image-reference grammar: that belongs to the runtime and its registry. Without this, an environment of `--help` is consumed as a flag, exits *zero*, creates nothing, and creation returns a handle to a container that was never made; `--privileged` in the same position gives away the isolation the primitive exists to provide.

## 5. Tests

Everything below is written alongside the code it covers. Nothing automated will run these — that is what makes the coverage matter rather than what excuses it.

- [x] 5.1 A sandbox is created from a record and a handle is returned; destroying it removes the container.
- [x] 5.2 A file written to a workspace survives `destroy` and is present in a sandbox created afterwards for the same agent.
- [x] 5.3 `releaseWorkspace` reclaims the volume.
- [x] 5.4 Two sandboxes live at once cannot read each other's workspace, and neither can read the host's filesystem.
- [x] 5.5 No host directory is mounted, and the runtime's socket is not present inside a sandbox.
- [x] 5.6 A resolved credential is present in the sandbox's environment, and appears in no command line assembled by creation and no file written by it. Assert against the argv actually passed, so `-e NAME=value` cannot creep back in unnoticed — and against `docker inspect`, so no spelling that hands the runtime an environment can either. A value needing quoting survives delivery intact; one carrying a newline is refused at creation.
- [x] 5.7 After destruction, the credential is not readable anywhere the sandbox left behind.
- [x] 5.8 Cycling create/destroy enough times to surface a per-cycle leak — a few dozen — accumulates no containers, volumes, processes, or file descriptors. Assert against counts taken before and after, not against a fixed expected number.
- [x] 5.9 Creation that fails partway reports the failure and leaves nothing it created behind, including the case where the volume pre-existed and must survive.
- [x] 5.10 Destroying an already-destroyed sandbox succeeds; destroying a running one stops it.
- [x] 5.11 Creation with no reachable daemon fails with an error naming the cause.
- [x] 5.12 A sandbox for a record naming no parent is created by the same path as one at any depth — the primitive reads nothing about hierarchy.
- [x] 5.13 `exec` streams output as it is produced rather than at process exit. This is the property ENG-213 depends on and the one a buffered implementation would silently fail.
- [x] 5.14 A credential block whose reader is gone reports a failed process rather than terminating the caller, and is never reported as a *success* — the second is what fails outright if the handling is removed, because vitest's own `uncaughtException` handler catches the crash the first would otherwise show. `exec` into a sandbox already destroyed reports the runtime's failure too.
- [x] 5.15 A record whose fields would be read as instructions is refused at creation and leaves nothing behind: an environment the runtime would parse as an option (`--help`, which otherwise exits zero and creates nothing, and `--privileged`), and a credential name the delivery shell cannot export (`1BAD`, `A-B`, `A B`). Assert on the argv that the image is passed after `--` and appears nowhere before it, since the refusal alone would not catch a runtime that parses differently. Both refusals run after the workspace has been looked for, so cover both directions of the unwind: the workspace this call created is removed, and a resuming agent's is not. Assert too that the grammar is not narrowed past what the shell accepts — a leading underscore and a trailing digit are the edges — because failing closed there is silent and would read as a configuration mistake.

## 6. Notes and close-out

- [x] 6.1 Write `agent/AGENTS.md`: that the substrate's tests need a running daemon, that nothing in CI runs them, and that anyone changing `agent/` runs them before merging. Record anything learned in task 1.2 about the environment passthrough, since a future session would otherwise rediscover it the hard way.
- [x] 6.2 Add a `CONTRIBUTING.md` section covering how to typecheck and test the substrate, and stating that it is deliberately outside the build, the checks and the tarball.
- [x] 6.3 Run `npx tsc -p agent/tsconfig.json` and `npx vitest run --config agent/vitest.config.ts` clean, then the repository's own `npm run build`, `npm run typecheck` and `npm test` to confirm nothing at the root was disturbed.
- [x] 6.4 Run `openspec validate eng-196-provision-and-tear-down-an-agent-sandbox --strict`.
- [x] 6.5 No changeset. Nothing here is built, shipped, or reachable from the published CLI.
