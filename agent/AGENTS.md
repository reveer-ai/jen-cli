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
