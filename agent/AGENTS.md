# The agent substrate

A ground-up redesign of how work gets coordinated, built while its shape is still being
found. It is not an extension of `cli/`, and the two do not import each other.

## Nothing automated runs any of this

`agent/` is deliberately outside the repository's build, typecheck, test command, CI
workflow, and published tarball. Wiring an unfinished experiment into the checks that gate
every pull request would make it a condition of merging unrelated work.

The cost is real and it is yours to pay: **no automated check covers this directory**, so
nothing catches a regression here until a person runs the tests by hand. That is a reason
to test more carefully than you would under CI, not less.

```bash
npx tsc -p agent/tsconfig.json
npx vitest run --config agent/vitest.config.ts
```

**Run both before merging anything that touches `agent/`.** A green pull request says
nothing whatsoever about this directory.

The configs are the substrate's own and do not extend the repository's, on purpose — the
root `tsconfig.json` sets `rootDir: "cli"` and `outDir: "dist"`, and `dist/` is what the
published tarball is built from.

## The sandbox tests need a running container runtime

`sandbox/docker.test.ts` drives a real one. Nothing in it is mocked, because a driver whose
only job is to drive another program proves nothing against a stub of that program.

- Start the runtime first. On Docker Desktop, `docker desktop start`, then check with
  `docker version --format '{{.Server.Version}}'`. The suite fails in `beforeAll` with a
  message naming this rather than leaving you to read a creation error.
- The first run pulls `busybox:stable` and `hello-world:latest`. Slow once, cached after.
- Everything it creates is labelled `jen.run=<a per-run id>` and swept in `afterAll`. If a
  run is killed mid-way, `docker ps -a --filter label=jen.run` and
  `docker volume ls --filter label=jen.run` find what it left.

## How a credential gets in, and the three ways that look right and are not

The requirement is that no secret reaches a command line or a file, inside the sandbox or
outside it. **Three spellings satisfy part of that and fail it overall.** All three are
easy to reach for, so each is written down here with what is wrong with it:

- `--env NAME=value` puts the secret in `docker`'s argv, which every process on the machine
  can read for the life of the call.
- `--env-file` puts it on disk, which is what delivering secrets as environment exists to
  avoid — it reintroduces a cleanup step that can be interrupted.
- **`--env NAME` with no `=value`** forwards the value from the `docker` process's own
  environment, and it does keep the secret out of argv. It fails anyway, and this is the
  one worth understanding, because nothing about the call looks wrong: **the runtime keeps
  whatever it is given as container configuration.** Create a container that way and
  `docker inspect --format '{{json .Config.Env}}'` hands the value back in full, for as
  long as the container exists. Writing no file yourself is not the same as no file
  existing — the runtime writes files too.

What the driver does instead: **creation passes no environment at all, and every process
started by `exec` is sent its credentials on its own standard input.** A tiny shell reads
`NAME=value` lines until an empty one, exports them, and `exec`s the real command, so the
secret lives in a pipe and in one process's memory and nowhere else. `docker.ts` imports
nothing from `node:fs` and writes no file; a source-level test guards that, and a second
test asserts against `docker inspect`, because the file the old mechanism caused was the
runtime's rather than this driver's and no source-level check could have seen it.

**Delivery is per process, not at creation, and it cannot be moved.** A process started by
`docker exec` takes its environment from the container's configuration — not from the
process already running inside it — so an entrypoint that read the block and exported it
would be the only thing that ever saw it. Verified: a container whose PID 1 exports a
variable, then `docker exec … printenv`, and the variable is absent.

The cost is a line protocol, so **a credential value may not contain a newline.** Creation
refuses one that does, naming the credential and never the value. If a multi-line secret
ever has to be carried — a PEM key is the obvious candidate — the change is to the block's
encoding, and whatever replaces it has to keep the same property: nothing on a command
line, nothing the runtime writes down.

## A record's fields are caller data, and three places took them literally

`AgentRecord` is data the supervisor hands over. Three of its fields used to be passed
straight through into places that read them as instructions rather than as values, and all
three were invisible because the call sites looked like ordinary string interpolation.

**The runtime's argument list has an option-parsing position, and `record.environment` sat
in it.** `docker run [OPTIONS] IMAGE …` parses options until the first operand, so an
environment of `--help` is consumed as the help flag — which **exits zero and creates
nothing**, so a driver that checks only for a non-zero exit accepts the creation and returns
a handle to a container that was never made. The same position accepts `--privileged`, which
would hand away the isolation the primitive exists to provide, from a record rather than
from any code.

Two things hold it now, and they are kept together because they fail differently:

- `--` before the image. Option parsing ends there, so whatever follows is read as an image
  reference however it is spelled — `run … -- --privileged` exits 125 with `invalid
  reference format`. This is the structural fix, and it is a property of *this* runtime's
  argument parser.
- A refusal of an empty environment or one starting with `-`. This is a property of the
  module, holds against a runtime whose parser differs, and gives the caller an error that
  names the cause. Deliberately **not** an image-reference grammar: what a reference may
  look like belongs to the runtime and its registry, and deciding it here would start
  refusing things the runtime accepts.

Any other caller value that ends up in operand position needs the same treatment.

**A flag's argument is not automatically safe, and the distinction is the one this note
originally got wrong.** It used to say that `--workdir`, `--volume` and `--name` were all
fine because the parser has consumed the flag and takes the next token whatever it says.
That is true only of a value handed over *whole*. It is false the moment this module
**composes** the argument, because then the argument has a syntax of its own and the
caller's value is inside it.

`--volume` is the composed one: `source:destination[:options]`, joined here by a `:`. A
workspace of `/workspace:ro` is therefore not a path containing a colon — it moves the join.
The volume lands at `/workspace` read-only, while `--workdir` is a *separate* argument that
still gets the string whole and names `/workspace:ro`, a directory the runtime then creates
in the container's writable layer. Creation **exits zero**. Every process starts somewhere
that looks right, `pwd` agrees, writes succeed — and the agent's work is outside its volume
and discarded at the next suspension, silently. That is worse than the `--help` case, which
at least fails immediately.

So the test to apply is not "is this a flag argument" but **"does this module build the
string, or hand the value over as one token?"** `--name` and `--workdir` hand it over whole;
`--volume` builds it.

The check is on the *value*, not on the flag, because the workspace reaches three positions
with three syntaxes — the composed volume argument, `--workdir`, and the default `cwd` of
every `exec` — and what has to hold is that all three name the same one place. Switching the
mount to `--mount type=volume,dst=…` was considered: it does preserve a colon, but it reads
`,` as a delimiter of its own, so it relocates the hazard and additionally refuses `/a,b`,
which the composed form carries fine. A flag can only ever fix its own argument.

Absolute-and-no-colon is the whole of the check. The runtime already refuses a relative or
empty destination loudly (`the working directory 'workspace' is invalid, it needs to be an
absolute path`), so that half buys a better error rather than a caught bug — kept because it
names the record's field instead of an argument the caller never wrote. `..` and doubled
separators are left alone: the runtime normalises them and applies the *same* normalisation
to the mount destination and the working directory, so those two continue to agree.

**And a credential name is read by a shell, which is stricter than the protocol carrying
it.** Delivery is a line of `NAME=value` text, and a name like `1BAD`, `A-B` or `A B`
travels that line perfectly intact — `export` is what refuses it, with `sh: export: 1BAD:
bad variable name`, killing the credential prologue and therefore *every* process ever
started in that sandbox, long after a creation that looked fine. Validate the portable
grammar `[A-Za-z_][A-Za-z0-9_]*` at creation. The general shape of the mistake: checking
only what would break the transport, when the receiver is what actually constrains the
value.

All three refusals happen after the workspace has been looked for, so all three go through
the unwind — which means a refusal must not take a *resuming* agent's workspace with it.
That pair (unwinds the workspace it created, keeps the one it didn't) is tested for each.

One thing the workspace refusal cannot have: a test that catches the divergence itself.
Once the value is refused there is no record left that produces a split mount, so the
create/write/destroy/recreate test beside it stays green with the refusal removed. It states
the property — where a process starts is what persists — and the refusal's own test is the
one that fails. A passing persistence test is not coverage of this bug.

## Every pipe of a subprocess needs an `error` listener

A stream reports its own failure by emitting `error`, and an `error` with nothing listening
is not dropped — Node raises it as an uncaught exception and the process dies. The process
running this is the supervisor, so one agent's broken pipe would end every other agent's
run along with it.

**`child.on('error', …)` does not cover it**, and that is the part worth remembering. A
failed write to standard input emits on `child.stdin`, never on `child`; the child listener
catches a failure to *spawn* and nothing after. The reachable case here is the credential
block with no reader left — `docker exec` refused, or a container gone between `exec` and
the runtime's attempt at it — which ends the write in `EPIPE`.

**The suite will not tell you plainly if this is removed.** Vitest installs an
`uncaughtException` handler of its own, so under the tests the crash is caught, `close`
still arrives, and the exit is correct: the run goes red with an "Uncaught Exception" beside
a *passing* test, which reads like noise. Nothing installs that handler for the supervisor.
The test that fails outright is the other half of the pair — that a broken pipe must not
resolve as a success.

Which is the policy: a broken pipe surfaces through `exit`, as the subprocess's own failing
exit where it has one (its stderr says more about why than the pipe does), and as a
rejection where the subprocess exited *zero* — because a command that ran without the
credentials it was sent looks exactly like one that had them.

## Asking whether a workspace exists: `volume ls`, never `volume inspect`

`docker volume inspect` exits non-zero both when the workspace is absent and when the
runtime cannot be reached, and the two are not separable from the exit code.

That matters more than it looks. Creation returns whether *this call* created the
workspace, and that answer is what licenses the unwind to delete it on a failure. Read an
unreachable runtime as "absent", and a transient error during a **resume** ends up
reporting a workspace this call created — handing the unwind permission to destroy a day of
the agent's work.

`docker volume ls --filter name=^NAME$ --format '{{.Name}}'` exits zero whether or not it
matched, so a non-zero exit means only that something really failed. Prefer that shape for
any other existence question here. The same lesson, learned the same way, is recorded for
`git fetch` in [`cli/AGENTS.md`](../cli/AGENTS.md).

## Creation assumes one call at a time per agent

Asking whether the workspace exists and then creating it are two steps, and the gap between
them is what decides whether a failed creation is allowed to delete the workspace on its way
out. Two `create` calls for the **same** agent could both find it absent, both make it, and
both believe they made it — after which a failure in either takes the other's work with it.

Nothing here defends against that, deliberately. A sandbox is provisioned for an agent that
is about to work, and an agent is either suspended or working, so the supervisor has no
reason to hold two in flight for one agent. That is an assumption about the caller living in
this code, and nothing here would notice if it stopped being true — so if the supervisor ever
grows a path that could provision the same agent twice at once, this is the thing that breaks,
and it breaks by deleting data rather than by erroring.

Concurrent creation for *different* agents is fine: the container name, the workspace name and
the labels all derive from the agent id, so nothing is shared.

## What a sandbox image has to provide

`sh` and `sleep`, and nothing else. Creation starts a shell loop as a trivial idle
entrypoint and `exec` is what starts real processes; a long single `sleep` is avoided
because the maximum argument `sleep` accepts varies between implementations. `exec` goes
through `sh` too, since that is what reads the credential block — so the shell is a
requirement of running anything here, not only of idling.

An image with no shell is created and then fails to start. That is the behaviour
`hello-world:latest` is used for in the tests, and it is the **only** case that leaves a
remnant for the unwind to remove — a creation that fails on a missing image leaves nothing
behind at all. If you rewrite the unwind, note that the missing-image test passes with the
unwind deleted entirely; the `hello-world` one is what actually holds it.

## Adding a driver is a change, not an extension

The driver set is closed in source. No registry, no dynamic loading, no configuration
naming an implementation to load.

Exactly one driver exists, so nothing independently exercises the interface in
`sandbox/index.ts` and nothing can reveal an assumption that leaked through it. Its
independence is held by reading it — `sandbox/index.test.ts` makes that reading a test,
over the prose as well as the declarations. Keep it small enough to re-read in full, and
re-read it in full when a second driver is written.
