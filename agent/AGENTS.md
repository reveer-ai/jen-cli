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
npm install --prefix agent          # once per clone, and after any change to agent/package.json
npx tsc -p agent/tsconfig.json
npx vitest run --config agent/vitest.config.ts
```

**Run both before merging anything that touches `agent/`.** A green pull request says
nothing whatsoever about this directory.

The install is the part that is easy to skip and confusing to skip: the substrate carries
its own manifest, so its dependencies live in `agent/node_modules` and the repository's own
`npm install` does not put them there. Without it the typecheck fails on an import that
looks perfectly correct.

The configs are the substrate's own and do not extend the repository's, on purpose — the
root `tsconfig.json` sets `rootDir: "cli"` and `outDir: "dist"`, and `dist/` is what the
published tarball is built from.

## Two suites need a running container runtime

`sandbox/docker.test.ts` drives a real one. Nothing in it is mocked, because a driver whose
only job is to drive another program proves nothing against a stub of that program.

`supervisor/containers.test.ts` is the supervisor's integration tier and needs one too. Three
of its assertions are about containers rather than about the state machine — that a fully
dormant tree holds none, that an agent which asked to stay resident still holds its own, and
that a run killed with containers live is swept and resumes — and a test double cannot make
any of them, because the double is what decides what `docker ps` would have said. Its agents
are a shell peer rather than the real runtime, so it needs no image beyond the `sh` a sandbox
already has to provide; one of its tests starts a supervisor in a detached process group and
`kill -9`s the group, because a test cannot do that to the process it is running in.

- Start the runtime first. On Docker Desktop, `docker desktop start`, then check with
  `docker version --format '{{.Server.Version}}'`. The suite fails in `beforeAll` with a
  message naming this rather than leaving you to read a creation error.
- The first run pulls `busybox:stable` and `hello-world:latest`. Slow once, cached after.
- Everything it creates is labelled `jen.run=<a per-run id>` and swept in `afterAll`. If a
  run is killed mid-way, `docker ps -a --filter label=jen.run` and
  `docker volume ls --filter label=jen.run` find what it left.
- **Ending a process's input is the caller's job, and a test that forgets hangs rather than
  fails.** `exec` writes the credential block and whatever `input` it was given, and then
  leaves the pipe open — that is the point of it. So a reader like `cat` never sees EOF, and
  awaiting `process.exit` without `stdin.end()` waits for the whole `testTimeout` and reports
  a timeout naming nothing. Three tests written before the input stayed open failed exactly
  this way, five minutes each, and the run gave no other sign of what was wrong. If a test
  here hangs, that is the first thing to check.

## Neither suite runs anywhere but on a machine someone started a runtime on

Nothing in CI runs either of them, so a change to `sandbox/` or `supervisor/` can be
typechecked, reviewed, merged, and still be the first thing to break when somebody finally
has a daemon. That is not hypothetical: the change that opened the input contradicted three
of `docker.test.ts`'s existing tests, and design, implementation and review all passed over
it because no runtime was reachable on any of those machines. **Run both before claiming a
change to either directory works**, and if you cannot, say so in those words rather than
reporting the suites you could run as though they were the suite.

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

`SandboxRequest` — the fields of an agent's record that provisioning reads, narrowed from
`AgentRecord` in `../record.ts` — is data the supervisor hands over. Three of those fields
used to be passed straight through into places that read them as instructions rather than
as values, and all three were invisible because the call sites looked like ordinary string
interpolation.

**The runtime's argument list has an option-parsing position, and the request's
`environment` sat in it.** `docker run [OPTIONS] IMAGE …` parses options until the first operand, so an
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

**Since ENG-197 the caller can be a model, and the reason that is survivable is an overlap
nothing names.** Spawning made an agent the author of a record, so "caller data" stopped
meaning "data the supervisor composed" and started meaning data a model wrote. The three
refusals above are still the backstop, but they are not what holds today — what holds is
that every field `SandboxRequest` reads is a field the spawn handler refuses to take from
its caller. `SandboxRequest` is `Pick<AgentRecord, 'id' | 'environment' | 'workspace' |
'credentials'>` and all four are in `OWNED` in `supervisor/index.ts`, so a child's four are
copied from its parent's own record or derived by the supervisor. No value a model wrote
reaches the driver at all.

That is two lists in two files agreeing by coincidence of maintenance, not by construction.
`sandbox/index.test.ts` pins the field list, so widening `SandboxRequest` fails a test — but
that test says nothing about `OWNED`, so the natural fix is to update the pinned list and
move on, and the new field is then reachable from a `spawn` the moment provisioning reads
it. **Adding a field to `SandboxRequest` means adding it to `OWNED` in the same change**, or
deciding deliberately that a model may set it and making the refusals above carry that
weight for real.

## Every pipe of a subprocess needs an `error` listener

A stream reports its own failure by emitting `error`, and an `error` with nothing listening
is not dropped — Node raises it as an uncaught exception and the process dies. The process
running this is the supervisor, so one agent's broken pipe would end every other agent's
run along with it.

**There are two places this applies now, not one.** `sandbox/docker.ts` starts processes for
the supervisor, and `runtime/workspace.ts`'s `exec` starts them for the agent — where the
process that dies from an unlistened `error` is the agent itself, mid-turn, with its turn
unreported. `exec` listens on all three of a child's pipes for that reason, and its `stdin`
case is the ordinary one rather than the exotic one: a command that exits without reading
its input breaks that pipe every time, and a command's exit status is the authority on
whether it worked. A broken pipe on the way in is not a second opinion.

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

## A body's channel is two pipes and one thread, and both halves of that bite

The supervisor holds tens of bodies, and each one is a subprocess whose standard input,
standard output and standard error are pipes with finite buffers. Behind them is a
single-threaded process. Everything below follows from those two sentences, and none of it
was visible until a run with real models produced enough output to fill anything.

**A stream nobody reads stops the process, and stops its other streams with it.** This is the
one that cost a run. The supervisor read a body's standard output and left its standard error
with no reader at all, which is fine until a body writes more to it than the pipe holds —
after which that body blocks *inside a write*, forever. It does not fail, does not exit, does
not read its input and does not take a step. Its container is up, it uses no processor, and
its stored state still says `working`, which is exactly what an agent thinking hard looks
like. And because a container runtime carries a process's two outputs over one connection and
splits them at this end, the blocked standard error stops the standard output too, so the
supervisor sees nothing further on the channel either. A 20-line probe is enough to see it:
run `sh -c 'printf before; …1 MiB to stderr…; printf after'` through the driver, read stdout
only, and `after` never arrives.

Every stream is therefore read, and `sandbox/index.ts` says so as a requirement on the
caller rather than leaving it to be rediscovered. What is read from standard error is kept as
a bounded tail and handed to the parent in the report of its ending, because a runtime that
could not read its boot frame writes the reason there and nowhere else — and a parent
choosing between retrying, replacing and escalating was otherwise choosing on `exit 1`.

**A write to a body may never come back, so nobody waits for one.** The same single thread
means a body that has stopped reading is a body a `send` to does not return from — not as a
rejection, which is handled, but not at all. `#say` used to be awaited from inside the
supervisor's serial queue, which every state transition in the run passes through, so one
body in that state stopped *every* agent: no delivery anywhere, no frame read from any other
body, nothing written to any transcript, and no stall reported, because a stall is only
reported when every agent is `waiting` and these all said `working`. Nothing was ever owed by
the wait — the result was discarded either way, since what a body does with what it is sent
is not something the send can report — so `#say` now queues per body and returns, which keeps
the order and costs nothing.

**Pipe writes block on Linux and do not on macOS**, which is why the substrate's own tests
had to be run against containers to see any of this. Node writes to a pipe synchronously on
Linux and asynchronously on macOS, so a runtime inside a container blocks where the same code
on the host quietly buffers — and the double in `supervisor/double.ts` cannot model either,
because its streams are objects that accept whatever is written. Anything about backpressure
is `containers.test.ts`'s to hold, and anything about *waiting* can be held in the double by
making a `send` that never settles, which is what `Peer.deaf` is.

## Report before you destroy standard input, or the reason is replaced by the destroy

`runtime/main.ts` ends the process on a turn it cannot complete, and how it ends is what a
parent is told: the body's exit becomes a message the supervisor posts, carrying the tail of
what the body wrote on its standard error. There is exactly one order that works.

**Destroying standard input while the `for await` over it is running makes that loop reject
with `ERR_STREAM_PREMATURE_CLOSE`.** Verified with a probe rather than reasoned about. That
rejection lands in the same outer `catch` a boot failure does, so an exit path that destroys
first and writes the reason afterwards prints *"Premature close"* — handing a parent an
account of how the process closed its own input in place of why the agent stopped.

So the one exit path writes the reason, sets the exit code, and destroys standard input
last, and it is idempotent: the second call, arriving from the outer `catch` with the
destroy's own error, is swallowed rather than allowed to print over the first.

**This is invisible in review and invisible to a test that checks the exit code.** The wrong
order still exits, still writes exactly one line to standard error, and still reports —
it reports the wrong thing, which is precisely the diagnosis ENG-216 exists to deliver. The
test that holds it is `runtime/entry.test.ts`, "reports the failure that stopped the turn
and not the one raised by stopping", and it asserts on the text rather than on the code.

## `close` on a child is not the end of its process group

`exec` spawns `detached` so the child leads a process group, and terminates by signalling
the negated pid — `SIGTERM`, then `SIGKILL` after a grace — so that a build, a test runner
or an assistant takes its own children with it. The trap is what happens in between.

**The child's `close` says nothing about the group.** It fires when the process we started
has exited *and* its stdio has closed, and a grandchild that holds none of the child's pipes
satisfies both while still running. So the obvious tidy-up — clearing the deferred `SIGKILL`
in the `finally` that runs once `close` resolves — cancels the only signal that would ever
have reached a descendant ignoring `SIGTERM`, and the result then says the command "and
anything it had started" was terminated when one of them is still running. It leaks past the
agent, past the run, and past the test suite, because nothing else knows that pid.

The escalation therefore outlives the child, and the call waits for it rather than leaving it
to a timer this process may exit before firing. `process.kill(-pid, 0)` is what makes that
cheap: an empty group answers `ESRCH` and the call returns immediately, which is every
command that ended on its own, so only a group with something still in it pays what is left
of the grace. `EPERM` from that probe is a yes — something is there and is not ours.

**Testing it takes a grandchild that both ignores `TERM` and holds no pipe**; drop either
half and the test passes against the broken code. `sleep 60 &` from a shell inherits the
shell's stdout, so `close` waits for it and the bug is invisible. Spawn it with
`stdio: 'ignore'` and a `trap "" TERM`, and clean the pid up in a `finally` — a test for a
process leak that leaks the process when it fails is not worth much.

## A local capability has no timer behind it, so `open` is not the safe call it looks like

The runtime arms nothing for a capability that is *working*. The supervisor's residency
timer is set at `#turn` and `#awaiting`, both states an agent reaches by finishing
something, and the loop awaits each call in turn — so a capability that blocks blocks the
agent, permanently, and the `AbortSignal` handed to `invoke` is a courtesy rather than a
guarantee. `exec` carries its own deadline for this reason. Everything else has to avoid
starting a wait it cannot end.

**`open(path, 'r')` is such a wait.** Opening a FIFO for reading blocks until something
opens the write end, and a workspace is a directory its own agent can `mkfifo` into, so the
path is reachable from a model's own output. The read never returns, the turn never ends,
and nothing anywhere reports it. `constants.O_RDONLY | constants.O_NONBLOCK` is what makes
the open return regardless of what the path names, and on a regular file it changes nothing.

**Ask the handle what it opened, not the path.** `stat(path)` then `open(path)` proves a
fact about the name and then reads a different object; `open` then `handle.stat()` asks the
open file description itself, so there is no window to swap anything into. It also costs one
syscall rather than two.

Reads look like the operation that cannot hang, which is exactly why this one got shipped:
the path checks in `place` are about *where* a path leads and say nothing about *what* is
there, and every test in the suite pointed them at regular files.

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

**Two agents in different runs with the same id are not different agents to `workspaceName`,
though.** It is keyed on the agent id alone and `slug` is a deterministic digest, so a second
run of the same record hands its `chief-1` the volume the first run's `chief-1` filled — while
the store, which is `~/.jen/runs/<run>/agents/<id>`, keeps them apart. An agent then starts its
first turn in a workspace already holding another run's files. The labels do not give this
away either: creation only labels a volume it *makes*, so a reused volume still carries
`jen.run` naming whoever created it first, and a label sweep both misses volumes an earlier run
left and removes volumes a later run is still using. Found by running the same record three
times under different run names, which is what `LIVE-PASS.md` asks for.

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

## A capability name that was a placeholder is now a real capability

Half the suite uses `fs` as the name of a made-up capability — `aCapability('fs')` handed to
a `Runtime` directly — and that is still fine, because those tests supply the capability
they name. **`entry.test.ts` is the one that is not fine**, because it runs the real
`main.ts`, which since ENG-211 offers `fs` and `exec` for real.

One test there named `fs` as the example of a capability a record asks for and nothing can
resolve. It had been correct for as long as every shipped capability was a supervised one.
Afterwards the process booted a perfectly good agent and sat waiting for a message that
never came, and the test failed five minutes later as `Test timed out in 300000ms` — naming
nothing, pointing at nothing, and looking exactly like a hang in whatever else had changed.

So: **a name used to mean "unresolvable" has to be one no source offers**, and adding an
entry to `SUPERVISED` or to `local()` means checking `entry.test.ts` for it. The general
shape, worth recognising elsewhere: a test whose premise is an absence goes quiet rather
than red when the absence is filled.

## A capability's description is source, and the structural tests read it as such

`supervisor/policy.test.ts` holds the claim that a runtime never branches on where an agent
sits, and it holds it the only way a claim about an absence can be held: by reading the
runtime's own files and refusing to find `.parent`, `isRoot`, `depth` or `ancestor` in any
of them. It strips comments before it looks. **It does not strip string literals**, and a
capability's description is a string literal hundreds of bytes long written for a model.

So `read`'s description, saying a transcript is readable at "any depth below you", failed a
test about branching. Nothing was wrong with the code and nothing in the failure said so —
it named `main.ts` and a regular expression about the tree.

Say it in words the test does not look for; "a child, a child of that child, anything below
you" is the same sentence to a model. Widening the strip to exclude string literals is the
wrong repair: the words are exactly as load-bearing inside a template as outside one, and
the test's whole value is that it cannot be talked out of a match.

The same file's `RUNTIME` list is enumerated by hand, so **a new module under `runtime/`
is not covered until it is added there** — `transcript.ts` was added with this change.

## Writing an output flood in a test program takes `writeSync`, not `process.stdout.write`

A loop around `process.stdout.write` looks like the way to make a program that floods its
output, and on a pipe it is the way to make one that floods *its own memory*. Writes to a
pipe are asynchronous: each call queues a chunk and returns, the loop never yields, so
nothing is ever flushed and the reader sees nothing while the writer grows without bound.

`writeSync(1, …)` blocks when the pipe is full, which is what a flooding command actually
does, and is what lets the reader on the other end — `exec`'s output cap — be the thing that
stops it. `assistant-stub.ts --flood` is written that way for exactly this reason.

## A `FileHandle`'s `write` can come up short, and nothing makes you look

`handle.write(data)` issues one `write(2)`. It does not loop. What it managed is reported in
the resolved object's `bytesWritten`, and the call resolves rather than throwing when that is
less than what it was handed — so a caller advancing its own counter by the length of the
data, which is the obvious way to write it, records bytes that never landed and gets no
signal at all.

The realistic road to a short write here is **a full volume**: a regular-file write returns
short rather than `ENOSPC` when there is some room left and not enough, which is precisely
the state a workspace reaches first. It is worst where the file is then published as complete
— `runtime/transcript.ts` writes pages to a temporary and renames it over the target, and a
short write turns that from a guard into the thing that publishes a truncated file under a
whole one's name, atomically and undetectably.

`handle.writeFile(data)` loops until every byte is out, and when called repeatedly on the
same handle it continues from that handle's current position, so a per-page write stays a
per-page write. Use it for anything whose completeness is load-bearing. `supervisor/store.ts`'s
`save()` and `runtime/transcript.ts` both do. `handle.write` is fine where a short write is
survivable — `store.ts`'s per-event append is one line to an open log, re-derivable if it
tears — but "survivable" is a decision to make rather than a default to inherit.

## A transcript answers `grep` with claims as well as acts, and an argv is escaped twice

`read` exists so a parent can check a child's report against the record, and the record is
complete in both directions: a child's own report messages are `message` events sitting on
the same kind of line as its `tool_call`s, exactly as the spec requires — nothing is selected
and nothing is elided. So a prose `grep` over the file matches the claim as readily as the
act, and what distinguishes them is the `"type"` the line opens with. Printing the line
answers the question; `grep -c` discards precisely the field that disambiguates, which makes
a count the one shape of the question the file cannot answer.

The quieter half is the escaping. `ToolCallEvent.arguments` is the provider's JSON string
kept unparsed — `events.ts` says so in as many words — so it is a JSON string *inside* a
JSON line, and the argv `["npm","run","lint"]` lands on disk as `\"npm\",\"run\",\"lint\"`.
A grep for the unescaped form matches nothing. That is a false negative on the one surface
whose whole value is catching a false claim, though it fails in the safe direction: it
prints nothing at all, which invites another look rather than a wrong conclusion.

`jq`, which `read`'s own description names for this, parses both layers and gets it right.
Reach for it over `grep` whenever the question is *which commands actually ran*.

## The substrate's manifest, and the entry point that needs no build

`agent/package.json` exists because the runtime has a dependency and the repository's
manifest may not carry it — a dependency declared at the root would be installed by
everyone who installs the CLI, to support code the published package does not contain.
Three consequences, none of them obvious from the manifest alone:

- **The install tree is `agent/node_modules`, and the root `.gitignore` has a line for it.**
  The existing `/node_modules/` rule is anchored to the repository root and does not reach
  it. The rule added is `/agent/node_modules/`, narrow on purpose: a source file added
  under `agent/` stays trackable, which is what `agent-substrate` requires.
- **Tooling is deliberately *not* redeclared.** The compiler and the test runner come from
  the repository, which already carries them. Only what the substrate's own code imports
  belongs in its manifest — a second copy at a second version is two things to keep in step
  for no gain. `manifest.test.ts` asserts this in both directions.
- **The entry point is a `.ts` file that node runs directly**, by stripping the types out of
  it. There is no build here and there must not be: `noEmit` is what keeps the substrate
  from producing an artifact to ignore, clean, or accidentally publish. `erasableSyntaxOnly`
  is what keeps that possible — it refuses at the typecheck the constructs that have no
  runtime-free spelling (enums, namespaces, parameter properties), any one of which would
  turn the entry point into something needing a build step after all. Nothing else would
  catch it, since nothing here is ever compiled.

**So every relative import under `agent/` names the `.ts` file it actually is.** Not `.js`,
which is the convention everywhere else in this repository and the one TypeScript's
`nodenext` resolution normally insists on. Node resolves a stripped module's specifiers
literally: `import … from './boot.js'` sends it looking for a `boot.js` that this directory
never produces, and the program dies at load with a module-not-found naming a file nobody
wrote. **The typecheck is perfectly happy with it** — the resolution is node's, at runtime,
and there is no build in between to notice. `allowImportingTsExtensions` is what lets the
compiler accept the honest spelling, and `noEmit` is its precondition. `entry.test.ts` runs
the real entry point as a real subprocess, which is the only thing here that would catch a
regression.

## The boot frame rides the same pipe as the credentials, and `exec` is why that is safe

A runtime is started with one JSON line on standard input carrying its record *and* its
prior event log. Not argv: a single argument is capped at `MAX_ARG_STRLEN` — 128 KB on
Linux, whatever `ARG_MAX` allows — and an event log clears that in ordinary use, so a log
cannot travel that way at all. Once the log is on standard input, splitting the record onto
a second channel buys nothing and costs atomicity.

That input is the same one the credential block arrives on, and **the ordering is held by
concatenation rather than by two writes.** `exec` appends the caller's `input` to the
credential block and performs a single write and a single close, so nothing can interleave
and nothing can arrive early. It was tempting to write the block, then the frame, as two
operations; that spelling has a window in it and the window is invisible in every passing
test.

It works on the receiving side because POSIX requires a shell's `read` not to consume past
its newline on a shared descriptor, so the prologue takes the block a byte at a time and
stops at its terminator. That guarantee is easy to not know about, and **its failure mode is
not an error.** A prologue that over-read would hand the runtime a frame missing its first
bytes, which reads as a malformed record — so the diagnosis would land on the supervisor
that built the record rather than on the pipe. Hence the test in `sandbox/docker.test.ts`,
which sends a payload past 128 KB and compares every byte, and hence every parse failure in
`runtime/boot.ts` naming the field it could not read.

## The client's loop is not used, and that cannot be caught by behaviour

`runtime/model.ts` uses the `openai` client for exactly one thing: one chat completion, whole.
Its `runTools` and runner helpers will dispatch tool calls and take the next step for you, and
**if one of them were used here everything would still work** — the tests would pass, the agent
would answer, and the substrate's central decision (that the agent's loop is the agent's, not a
vendor's and not the coding assistant's) would have been given away with nothing to show for it.

So the guard is a source-level test, over the file's *declarations* with its prose stripped
out. The prose has to stay free to name what it is avoiding, or the reason for avoiding it
is the first thing lost.

## The completion is not streamed, because the accumulator destroys extensions

This one cost a live gateway to find, and it is the single most likely thing for a future
session to undo on the reasoning the first version used.

`stream()` looks like the obvious choice and the file said so for three passes: it accumulates
chunks and dispatches nothing, and reassembling tool-call `arguments` that arrive split at
arbitrary byte boundaries is genuinely worth not owning. **What it also does is overwrite every
field the standard does not define.** `ChatCompletionStream` destructures each delta as
`{ audio, content, refusal, function_call, role, tool_calls, ...rest }` — concatenating
`content` and `refusal`, accumulating `tool_calls` and `audio`, and handing `rest` to
`Object.assign`. So `opaque`, whose whole rule is *the fields outside that standard set*, was by
construction the fields the accumulator does not accumulate.

Against OpenRouter and `deepseek/deepseek-r1`, one prompt:

```
NOT streamed : reasoning_details[0].text  =  8106 chars
streamed     : reasoning_details[0].text  =     2 chars   (".\n")

1290 chunks, 1200 of them carrying reasoning_details,
7971 chars of reasoning across the deltas — 2 of which reach the log.
```

`reasoning` came back `null` outright, because the last delta carries `null` and `null` wins —
so the readable-text rule never fired either. The spec requires provider reasoning to be
carried "in a form that projection replays without interpreting it"; 0.03% of it was.

**The way out was not to own the merge.** Accumulating extension deltas here means inventing
merge semantics for shapes that are unknown by definition — string-append for `reasoning`, but
`reasoning_details` is an array whose parts merge by `index`, and the next extension a provider
ships is a guess. Guessing is interpretation, which is the one thing `opaque` may not do. One
unstreamed `create()` returns every extension whole **and** returns tool calls whole with them,
so the reassembly that streaming was chosen for does not arise rather than being taken on.

Two costs, both accepted knowingly:

- **No token-by-token progress.** Nothing in the substrate reads one — `capability.ts` notes the
  same about `progress`. ENG-212 is where transcript visibility lands; if it wants live tokens,
  it is re-opening this trade with the merge problem still attached, not finding an oversight.
- **A long generation now has a wall-clock deadline, and the first thing that will cut one is
  our own client.** This is the cost that was misfiled here for a pass as "an idle intermediary,
  not observed", and the truth is nearer and measurable. `parseResponseWithTimeout` returns
  early — unraced — when `options.stream` is set, so while this streamed, a step had no time
  limit whatsoever. Unstreamed, the body read is raced against `startTime + timeout`, and
  **expiry does not throw: it calls `retryRequest`**, re-issuing the entire completion
  `maxRetries` times. Against a server holding the body back, with the deadline shortened to
  stand in for a long generation:

  ```
  create()  ->  APIConnectionTimeoutError | Request timed out.
  create()  ->  generations the server was asked for: 3
  stream()  ->  OK "hi"
  stream()  ->  generations the server was asked for: 1
  ```

  Three full generations, produced and billed and discarded, then an error — and the retries
  cannot help, because a generation that was merely long is long again. Left at the SDK's
  defaults that threshold is **ten minutes**, which a real reasoning run can reach, and nothing
  in the change would have chosen it.

  `model.ts` now names both numbers: thirty minutes, `maxRetries` 2, with the reasoning beside
  them. The short version is that the deadline is set above any generation a model plausibly
  produces so that expiry means *dead* rather than *slow* — which is what makes re-issuing a
  retry again instead of a triple charge. **The cost that buys is a hung step taking ninety
  minutes to surface**, three attempts at thirty, and it is bounded by suspension rather than
  here. If a step ever needs cancelling sooner, the thing to reach for is the signal
  `index.ts` already threads into `step` — a caller abort throws immediately and is not
  retried, which the deadline path is not. Do not reach for `maxRetries: 0`: that counter also
  governs 429s, 5xx and connection resets, which are the failures a gateway really produces,
  and nothing else in the substrate retries anything.

**And the reason no test could see it: every stub sent an extension in a single delta**, where
last-wins and accumulate-properly are indistinguishable. Both stub servers now split one the way
the wire does — a character per delta, ending on `null` — and serve the streamed shape only to a
request that asks for it. So the doubles stay honest whichever way a future session goes, and
`model.test.ts` keeps one test that streams the same reply through the SDK on purpose and asserts
the loss. If *that* goes red, the accumulator has learned to merge extensions and this whole
section is worth re-opening.

## The projection lives here, not in the supervisor

Turning an event log into a provider message array happens in the runtime, on the live path
and the resumed path alike, and there is exactly one implementation of it.

The pull the other way is real: the supervisor is what hands a resuming runtime its log, so
projecting there looks natural. It would make byte-identical resume depend on two
implementations staying in agreement — and **nothing on either side alone could catch them
drifting.** A test of the runtime's projection passes; a test of the supervisor's passes; the
requests differ, the prompt cache misses on every resume, and nothing reports anything. One
implementation used on both paths makes the property structural instead of tested-for.

It also keeps provider knowledge out of the supervisor, which is the one component that is
not homogeneous and is therefore the one to keep smallest.

Two things follow, and both are load-bearing:

- **Nothing outside the log may reach a request.** No clock, no random source, no attempt
  counter, no request id. `at` is on every event and is deliberately not projected.
  `resume.test.ts` runs its two comparisons on *different clocks* precisely so that anything
  a clock touches fails there.
- **Key insertion order is part of the claim.** Providers key prompt caches on prefix
  content, so a re-ordered key is a cache miss rather than a cosmetic difference. The
  comparisons are on serialized bytes; `toEqual` would pass on a reordering and see nothing.

## A response message is not a request message, and a tidy stub hides the difference

`opaque` on a reasoning event carries a provider's *extension* fields so they can be replayed
onto the assistant message. The first spelling of that rule captured everything the projection
did not itself produce, which sounds equivalent and is not: `annotations` and `refusal` are
ordinary fields of the OpenAI **response** schema, present on a reply that did no reasoning
whatsoever. `ChatCompletionMessage` defines them; `ChatCompletionAssistantMessageParam` — the
request side — defines `annotations` nowhere. So an ordinary reply wrote a `reasoning` event
with empty content, and every later request echoed a field the request schema does not have.

**What makes this worth a permanent note is how it survived a suite that was otherwise
thorough.** Three separate guards were live and none could see it:

- `resume.test.ts` compares the live path against the resumed one byte for byte. Both paths use
  the one projection, so both were wrong *identically* and the comparison stayed green. That is
  not a gap in the test — it is what a byte-identity comparison structurally cannot see, and it
  is worth knowing about a test the whole design rests on.
- `entry.test.ts` runs the real client against a local server, which is the right shape. Its
  stub returned `{ role, content }` — tidier than any real gateway, which sends `refusal: null`
  and `annotations: []` on the plainest possible reply. **A double cleaner than the thing it
  stands for cannot fail.** The stub now sends what OpenAI sends.
- The typecheck cannot help at all: what goes into `messages` is cast at the seam, because the
  whole point of `opaque` is carrying fields no request type declares.

So: when a rule is about what came back from a provider, state it against the **standard's own
response fields** — knowable, finite, versioned with the SDK — and let anything outside that set
be the extension. Stating it against what our own code produces is a different set, and the
difference is exactly the standard fields nobody thought about. Test it against a message shaped
the way a gateway shapes one, and mutate the rule to confirm the test can actually fail.

**And the other half of that rule is a hole: excluding a standard field from `opaque` drops it
unless something else picks it up.** `refusal` is what taught this. Taking it out of the
extensions was right, and it then reached nothing — no `ModelStep` field, so no event, so no
assistant message at all for that step: the parent got an empty string, and the resumed model
met the next message with no memory of having declined the last one. A refusal is the agent's
message and is carried as one, flagged so the projection can put the text back in `refusal`
rather than in `content`. Every other standard field is dropped on purpose, `audio` being the
one a provider could really set. So the set in `model.ts` is a **list of decisions**, not a
filter: adding to it silently discards whatever it names, and the field to check when something
a provider sent goes missing.

## The resume test never serializes; a real resume always does

`resume.test.ts` hands the log from one runtime to the next as live objects. A real resume
cannot: the log leaves one process as JSON on standard output and re-enters the next through
`parseEvents` on standard input. **Everything an event carries has to survive that round trip,
and the test that the whole design rests on does not cross it.**

Nothing is broken here — the ten-turn process-level comparison was run and every request body
is byte-identical to the uninterrupted run, `opaque` reasoning and the `refusal` flag included.
The point is where the next hole would be. An `Event` field that `parseEvents` does not know
about is dropped in transit, and the symptom is the one this directory has now produced twice:
the suite stays green, the live wire is wrong, and the byte-identity comparison cannot see it
because both of its paths are in the same process. So when an event gains a field, the question
is not only what the projection does with it — it is whether `parseEvents` carries it, and the
check is a log that has actually been through `JSON.stringify` and back.

Worth knowing when writing that check: the runtime re-seeds the charter from the record when a
log has none, so a log that loses its charter in transit is silently repaired and proves
nothing. Break a field the record cannot supply.

## The provider accepts the replayed reasoning and throws it away

Measured against OpenRouter's chat-completions surface, which is the only live gateway this
substrate has run on. **Replaying `opaque` onto the assistant message changes nothing about
what the model is given.**

The same conversation sent twice — once with the extension replayed exactly as
`projection.ts` builds it, once with it stripped — bills the same prompt either way:

```
openai/o4-mini      extension 3809 B   with 62 tok   without 62 tok   difference 0
deepseek/deepseek-r1  extension 2873 B   with 47 tok   without 47 tok   difference 0
```

Both shapes, so this is not a property of one model: `reasoning_details` comes back as
`reasoning.encrypted` (a 2.3 KB opaque `data` blob, no readable text) from the o-series and
as `reasoning.text` (4 KB of prose) from r1. Each is carried whole, replayed whole, accepted
without complaint, and dropped before the prompt is counted.

**The distinction this cost a pass to learn is that acceptance is not honouring.** The
earlier live check established that the gateway does not *reject* a request carrying a
replayed extension — which was the real risk, and the right thing to have checked, because
`annotations` proved a field we invent onto a request can be refused outright. It says
nothing about whether the field arrives anywhere. A 200 and a sensible answer look identical
whether the provider read the block or discarded it on sight; the only thing that separates
them is the token count, and you have to ask for it deliberately.

So the current cost is about **2–3 KB per turn of request body, transmitted and dropped** —
wire, not tokens, and it grows linearly with the conversation. Not a reason to stop:

- The requirement is to replay without interpreting, and a provider that starts honouring
  these is carried with no change here. Dropping the replay to save bandwidth would be a
  spec change, and it would be reversed by the first provider that needs it.
- It is genuinely load-bearing on the *native* Anthropic and OpenAI Responses surfaces,
  where a thinking block has to be handed back for the chain to continue. This substrate
  does not talk to those yet. `baseURL` is exactly what makes it able to later.

**What would change the calculus is this measurement coming back non-zero**, so re-run it
rather than assuming either way — one completion, then the same follow-up with and without
the extension, comparing `usage.prompt_tokens`. If a provider begins counting them, replay
stops being free and the per-turn growth becomes a prompt-cache and cost question worth its
own decision.

## The substrate has an image now, and a third suite that needs one

`agent/Dockerfile` is the environment `aRecord`'s `jen/agent:latest` has been naming since
the beginning. It is built locally from `agent/` and pushed to no registry, which is what
keeps `agent-substrate`'s exclusion of this directory from the repository's package intact —
if it is ever pushed, that clause fires and the exclusion has to be revisited.

```bash
docker build --tag jen/agent:latest agent
npx vitest run --config agent/vitest.config.ts acceptance.test.ts
```

The tier builds the image itself in `beforeAll`, so the command above is only for building
it by hand. **Three suites now need a running container runtime**, not two — `acceptance.test.ts`
joins `sandbox/docker.test.ts` and `supervisor/containers.test.ts`, and it is the only one of
the three that needs the image.

### The build check cannot be `--help`, and that is a property of this entry point

`jen-agent` reads its boot frame from standard input and takes nothing from argv, so any
check that starts it without closing its input waits for a frame that never comes — a build
that **hangs** rather than one that fails. The check is `jen-agent < /dev/null`, required to
exit non-zero with the boot frame's own error, which also proves the shebang resolves, that
Node strips the types, and that `openai` is installed. `command -v` would notice none of
that: verified by building with `node_modules/openai` removed, where a presence check passes
and this one fails naming it.

### The assistant is the image's and must never be the manifest's

`agent-workspace-tools` forbids any part of the substrate naming a particular assistant, and
a dependency entry in `agent/package.json` would be the substrate naming one in the plainest
way there is. It is installed in the Dockerfile at a pinned version instead, which is also
what keeps the choice reversible — replacing it, or providing none, changes an image and no
source. `manifest.test.ts` holds both halves.

### A run's workspaces outlive the run, and removing them is yours

Nothing in the substrate deletes a workspace. `destroy` ends a body, `destroyAll` sweeps
bodies, dismissal keeps the workspace, and `shutdown` is the ordinary way to stop for the
day — a run is ended for every reason including that one, and its agents' work is sitting in
their workspaces waiting to be resumed from. `releaseWorkspace` exists on the driver and
`policy.test.ts` asserts the supervisor's source never names it.

So **a tree you run by hand leaks its workspaces to you**, and there is no verb for it —
giving the operator one was considered for ENG-199 and cut, because no criterion asks for it
and the substrate's first workspace-deleting path is a thing to be slow about. They are
labelled, so they are findable:

```bash
docker volume ls --filter label=jen.run=<run> --format '{{.Name}}'
docker volume ls --filter label=jen.agent=<agent id> --format '{{.Name}}'
```

`acceptance.test.ts` removes its own in `afterAll` for exactly this reason. If you run the
operator by hand, that is on you.

### A failed image build is invisible unless the build itself is asked

`jen/agent:latest` is left on the machine by every green run of `acceptance.test.ts`, and
nothing anywhere removes it — so **whether the tag resolves says nothing about whether the
Dockerfile in the working tree builds.** A setup that asked `docker image inspect` after a
failed build would find yesterday's image and run all five tests green against it: green, and
about nothing on disk. The build's own exit is the answer, and it is the only one. `run()`
rejects on a non-zero exit, so the build is wrapped in a `try` and the error's `stderr` is
what the failure carries. Nothing else in the repository ever builds this image, so this tier
is the only thing that would ever notice.

### A container reaches the host at `host.docker.internal`, on Docker Desktop only

`acceptance.test.ts` stands a scripted model up on the host and points each record's
`baseURL` at it, which is the seam `model.ts` describes rather than a branch added for a
test. Reaching it from inside a container relies on `host.docker.internal`, which Docker
Desktop provides and Linux Docker does not. **Teaching the driver `--add-host` was rejected**:
it would make every container the substrate ever creates carry a concern that exists for a
test, and a flag added for a suite is a flag every agent then runs under. So the tier probes
it in `beforeAll` and fails naming it, and running the tier on Linux needs that configured
some other way. Recorded as a gap rather than fixed.

A live pass — real models, real charters, an agent that decides for itself to delegate, and
an assistant authenticating inside a sandbox — is a person's job and is written down in
[`LIVE-PASS.md`](LIVE-PASS.md).

### The operator ends when its input ends, and that is the whole of its shutdown

`jen-operator <store-root> <run> <record.json> [opening]` reads one line at a time and
delivers each to the root by the path a parent's message takes. **The end of its input is a
person ending the run**, so a shutdown follows immediately — which means piping a single
line into it says the thing and then ends the run, rather than waiting to see an answer. That
is correct and it surprises: use a terminal, or hold the input open, if you want to watch.

Nothing on the command line says whether to begin or to resume, and the opening message is
**not** delivered again to a run that already exists. Resuming is done by re-running the
command that started it — that is the point of nothing on the line saying which — so
honouring the opening on a resume would put a duplicate instruction into the root's mailbox
every time, at the moment after a crash when a person is least likely to notice it.
