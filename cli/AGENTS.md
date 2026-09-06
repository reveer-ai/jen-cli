# jen's own source

The CLI lives here, not in `src/`. `src/` names the same *location* in jen as in every project that adopts it — the project's own sources, under a root the workflow owns — but not the same tracked-ness: an adopter's sources are its repository's content and are tracked, while jen governs no sources of its own, so its `src/` holds only working checkouts and is gitignored. That is jen's arrangement, not a rule adopters inherit; jen writes no ignore file into a project.

## The payload declaration is the single source

`payload.ts` is the one statement of what jen owns. Both consumers read it: `scripts/stage-payload.js` at pack time, and the CLI's commands at install time. Never restate the file list in either — that is exactly how the two drift.

`scripts/stage-payload.js` is plain Node ESM with no build of its own, so it imports the declaration from `dist/payload.js`. **A build must precede staging.** `prepack` enforces the order; running the script standalone against a stale or missing `dist/` is the failure mode, and the script exits rather than staging a partial payload.

## The skills jen ships are not the pipeline's stages

`SKILLS` is every skill the payload writes into a project. Six of them are stages a Linear status triggers; `setup-jen` is not, and a future one need not be either. The two lists diverged the moment a non-stage skill shipped, and the payload declaration tracks the first. Nothing reading it asks which skills a status triggers — staging, installation, reconciliation, and the help text all want what `init` writes — and stage-ness already lives in the root `AGENTS.md` stage table and in the `task-pipeline` capability. A second list here would be a third statement of it, drifting on the first workflow change nobody thought to mirror into the CLI.

The help text is where the distinction bites: it counts what `init` writes, so counting stages would have reported six while seven landed.

**A second variable set over `.claude/skills` is forbidden, and this is not obvious from reading `plan.ts`.** `reconcileCandidates` derives its search from a set's own `targetDir` and `memberShape`, and `planInstall` runs it once per set. Two sets over one directory therefore derive the same shape, search the same locations, and return the same candidates — so a single stamped orphan lands in `plan.deletions` twice: a duplicated line in the run's report, and a second `unlink` of a path that is already gone. Nothing in the code guards against it, because until now there has only ever been one set. Add a skill to `SKILLS`; do not add a set beside it.

## Working copies stay unstamped

The stamp is applied during staging, never committed. jen's own checkout is not a managed install, and a stamp in `.claude/skills/` here would ship doubled. Staging refuses to stamp a file that already has a `metadata:` key, which is what that mistake looks like.

Adding a `metadata:` key to a shipped skill for any other reason will therefore break `prepack`. If one ever needs one, the stamp insertion has to merge into the existing block instead of inserting a new one.

## The scaffold ships from `scaffold/`, not from jen's own `.claude/`

`scaffold/settings.json` is what `jen init` writes into an adopter as `.claude/settings.json`. jen's own `.claude/settings.json` is a different file, and it is not the lesser one: jen is its own project, so a stage session clones jen and reads that file exactly as a session in an adopted repository reads theirs. It is jen's pipeline's permission configuration, in the same role an adopter's is — not a contributor's scratch space. Editing one does not change the other, deliberately: an adopter's seed should not shift because someone allowed a command here. Both are empty of grants as of ENG-190, which does not make them the same file; it means the point below applies to a change that *removes* an entry exactly as it did to one that adds one.

**So jen's own file stays empty, and a contributor's own grants go in `.claude/settings.local.json`.** An entry in `permissions.allow` resolves at step 1 of the classifier's decision order, *before* the classifier is consulted — so a grant here is a bypass jen's pipeline has and no adopter does. `Bash(gh:*)` in it exempts `gh pr review --approve` and `gh pr merge` from the judgment ENG-190 exists to put them under, and nothing in this repo would report that; emptying the array was a task a human applied by hand for exactly that reason. The pressure to undo it is real rather than hypothetical — with the array empty, `git`, `gh`, `openspec` and `npm` calls in jen's own repo reach the classifier where they used to short-circuit, so a contributor will notice and come looking for the file to fix. `.claude/settings.local.json` is the seat for that: gitignored, per-install, and it changes nobody's pipeline but the one on your own machine. `test/repo-layout.test.ts` holds the tracked file to an empty array, because an entry quietly restored there is invisible to every other check.

**An agent cannot edit jen's own `.claude/settings.json`.** It is the file granting the running session its permissions, and the harness denies the write — correctly, since an agent widening its own allow list is what that guard exists for. So a change that touches permissions here lands in two halves that do not run in the same place: `scaffold/settings.json` an agent edits normally, and jen's own file a human applies by hand. Plan the task that way rather than discovering it at the write, and never route around the denial with a different tool.

**A workspace the harness has not trusted ignores the project's own configuration entirely.** Installing 0.1.0 from a packed tarball into a scratch project and running `claude` there prints `Ignoring 8 permissions.allow entries from .claude/settings.json: this workspace has not been trusted`, and the session runs as though the file were empty. Trust is keyed by absolute path in `~/.claude.json`, so a dispatched run — a fresh clone at a path nothing has trusted — hits this every time, not just on a developer's first local run.

That message names allow entries because that is what the file held at the time. What trust gates is the file, not any one key in it: an adopter's own permission rules, and whatever else `.claude/settings.json` carries. jen ships an empty allow list now, so there is nothing of jen's left for trust to protect — which changes who is harmed by getting it wrong, not whether it has to be done. It stays the invocation's problem rather than the scaffold's; the file itself is correct.

Scaffold files are written only when absent, and never again — not by `update`, not by `init --force`. `--force` exists to resolve one ambiguity, whether an unstamped fixed path is jen's or the project's, and a filled-in `registry.yaml` is not ambiguous.

**Nothing in this repo reads `scaffold/`.** Its files are inert text here and only become instructions in an installed project, so a name one of them points at can be wrong for a release without anything here noticing — which is how `registry.yaml` shipped telling adopters to run a skill that had never existed under that name. `test/payload.test.ts` closes the one case it can check by construction: every `` `X` skill `` a scaffold file names must be in `SKILLS`. Anything else the scaffold points at is only as correct as the last person to read it in an installed project.

## The stamp gates deletion, not overwriting

Worth stating outright, because it is easy to read the ownership stamp as "this file is jen's" and conclude that removing it makes the file the project's. It does not, and an adoption run caught exactly that assumption in draft documentation.

`planInstall` writes every payload file to its declared target unconditionally — the stamp is not consulted on that path at all. It is read in one place: reconciliation, where a candidate in a variable set's target directory that the payload *no longer ships* is deleted only if stamped. So:

| The file | Stamped | Unstamped |
|---|---|---|
| still in the payload | overwritten | overwritten, and re-stamped |
| dropped from the payload | deleted | left alone |
| never in the payload | left alone | left alone |

That table is about variable-set members. A fixed path is in none of its rows: it is written unconditionally, carries no stamp by construction, and `plan.ts` never considers it for deletion at all.

The only thing unstamping buys an adopter is keeping a skill a later version dropped. There is no supported way to hold an edit to a skill jen currently ships, and documentation must not imply one — telling an adopter their edit is safe in precisely the case where it is lost is worse than saying nothing.

## Retiring a fixed path is a migration, not a deletion

Deleting a fixed path's declaration stops jen *writing* it. It does not remove the copies already installed, and no later `jen update` will: a fixed path can never be orphaned, so it is never a deletion candidate — the reasoning is at the guard itself, in `plan.ts`. Every installed copy stays where it is, doing whatever it did, forever.

This is worth stating because the opposite is the natural reading, and it has already been assumed in writing once — the scheduled workflow's removal was scoped believing `jen update` would clean up after it, on the strength of the deletion table above. It would have left a live polling workflow in every adopted repository.

So retiring a fixed path is two questions, and the second is the one that gets skipped: what stops shipping, and what happens to what is already out there. The second is answered per retirement — by the adopter count, by what the stale file does if left, and by whether the path is one an adopter might later want for themselves. Do not reach for a general mechanism that deletes retired paths on sight without weighing that last part: a retirement entry never expires, so claiming a path forever in order to clean it up once will silently delete whatever an adopter writes there afterwards.

## The planner writes nothing

`plan.ts` reads; `apply.ts` writes. Nothing in `plan.ts` may touch the filesystem, and no write may move into it for convenience.

The reason is the refusal path: `jen init` on a project that already holds a fixed path must leave *no* trace — no skill, no scaffold, nothing. With the two phases separate, that is `plan.conflicts.length > 0 → return`, and it stays true however the writing code is later rearranged. Interleaved, it would be a property of statement order, and one write hoisted above the guard leaves an adopter with half a payload and an error.

Idempotency and the run's report both fall out of the same split: the report is the plan rendered, and a second run is a plan with an empty write set.

## The project boundary is physical, not lexical

Comparing resolved path *strings* against the project root proves nothing: `existsSync`, `readdirSync`, `mkdirSync`, and `writeFileSync` all follow symlinks, so an in-bounds path can name a write anywhere on the filesystem. Adopters really do symlink these paths — `AGENTS.md → CLAUDE.md` is a common one, and a shared `.claude` is not exotic.

Two rules, and they are not the same rule:

- **A link *at* a managed path** is content the project put there, and jen owns the path — so `apply` unlinks before writing, and the planner counts it as present (making a symlinked fixed path a conflict for `init`). Note the dangling case: `existsSync` follows a dead link and answers *false*, which is why every check of a project path in `plan.ts` goes through `entryKind`/`lstat` and never `existsSync`.
- **A link *on the way to* one** is somewhere else's directory, and everything below it belongs to whatever it points at. The run refuses outright — both commands, `--force` included, writing not even the paths it could have reached.

`containedPath` enforces both in the executor, so a hand-built or stale plan cannot get around them either. Anything new that touches the filesystem goes through it rather than `resolveInProject`.

## Resolving the OpenSpec binary goes through the bare specifier

OpenSpec's `package.json` declares `exports` with only `"."`, so the obvious first attempt fails:

```
import.meta.resolve('@fission-ai/openspec/package.json')  →  ERR_PACKAGE_PATH_NOT_EXPORTED
import.meta.resolve('@fission-ai/openspec')               →  …/@fission-ai/openspec/dist/index.js
```

`openspec.ts` therefore resolves the bare specifier and walks up to the directory holding `package.json` to read `bin.openspec`. Not `node_modules/.bin/openspec`: that shim lives in jen's install tree, which is not the project's under a global or `npx` install. Not `npx @fission-ai/openspec` either — that needs the network and floats off the version the lockfile pins.

**A dispatched stage session cannot resolve OpenSpec on its own, so the run hands it a shim — and `openspec` and `npx openspec` need it in two different places.** The session's cwd is a bare clone the pipeline never installs into — no `node_modules` to walk up to — and a global install of jen links jen's bin alone, never a dependency's. So `openspec` is not on `PATH`, and `npx openspec` (which never consults `PATH`) walks up for a `node_modules/.bin` that isn't there and then reaches the registry — for the unscoped `openspec`, not jen's `@fission-ai/openspec`. `exec.ts` writes the same wrapper (`exec "<node>" "<openspecBin()>" "$@"`, mode `0755`) into two siblings of `repo/` and `config/`: `bin/`, which `childEnvironment` prepends to the session `PATH` so bare `openspec` resolves, and `node_modules/.bin/`, which `npm exec`'s walk-up from the clone finds. Both are swept with the run directory, same as the askpass script. The `PATH` prepend always wins over whatever `childEnvironment`'s inherit loop copied, and it *becomes* the whole of `PATH` only where the runner carried none — the closed-environment case the tests construct, where they assert `PATH` is exactly the shim dir. Every stage runs `openspec`; without this the pipeline cannot start.

## Variable-set members must be able to carry the stamp

Deletion is the stamp intersected with the shipped payload, so a format with nowhere to put a stamp can never be reconciled. Markdown (frontmatter) and YAML (`#` comments) qualify; JSON does not. Adding a JSON file to a variable set fails staging — put it in a fixed path instead, or leave it project-owned.

## The tarball is `dist`-only

`files: ["dist"]` plus `prepack` is the whole packaging story, and `test/package.test.ts` asserts the tarball's contents both ways — what must be there and what must not. Anything added to `files` needs that test updated deliberately, not accommodated.

Known limitation: `prepack` does not run for an install straight from a git URL, and `dist/` is gitignored, so a git-URL install yields an empty payload. Adopters install from the registry; this is accepted, not solved. `stagedPayloadDir()` is where it surfaces — it fails naming the missing directory rather than adopting a project with nothing to write.

Running the CLI from source has the same shape: `import.meta.resolve` puts the payload beside the module, and there is no `cli/templates/`. Tests inject a staged directory through `RunOptions.templates`; the tests that exercise real resolution spawn the built `dist/index.js`.

## Exercising it as an adopter

Tests inject a staged payload and never see the tarball, a real `openspec init`, or an adopter's `node_modules`. Getting all three means packing and installing:

```
npm pack --pack-destination /tmp
cd /tmp/proj && git init && npm init -y && npm i -D /tmp/reveer-jen-*.tgz && npx jen init
```

`npm pack` runs `prepack`, so the tarball is built and staged by construction — running the CLI out of the working tree skips staging and proves nothing about what ships.

**`openspec init` writes into `.claude/skills/` too.** Its nine `openspec-*` skills land beside jen's, at exactly the depth reconciliation searches, and survive `jen update` only because they carry no stamp. Deletion must stay the stamp intersected with the payload: rewrite it as "whatever is in the target directory that the payload does not ship" and every one of them disappears on the next update. `messyProject` carries one by hand for that reason — the fixtures never run the delegation that would put them there for real, so without it the widened rule passes every unit test.

## The tick writes nothing, and that is why the announcement is the session's

`run.ts` reads, decides, prints, and hands the dispatched set to a launcher it was given.
No tracker mutation, no git-host call, no file — which is what makes deciding safe to run
at any time, twice, and what lets two runners — two instances of the one jen ships, or one
of those beside a runner an adopter drives — reach identical conclusions. `test/dispatch.test.ts` holds it both ways: every document the
tick sends must parse as a `query`, and the modules on its path must import nothing from
`node:fs`. Adding a write here is not a small change; it is the property being protected.

**Execution is injected rather than imported, and that is what keeps the guard honest.**
`tick()` takes a `Launch` and never reaches for `exec.ts`. Importing it directly would work
and would force the guard to be relaxed for a transitive import that legitimately writes —
and a relaxed guard no longer distinguishes the case it was written to catch. `run.ts` does
not even import the *type*: `LaunchResult` is declared structurally there, and `RunOutcome`
in `exec.ts` satisfies it while carrying more. `--dry-run` is the absence of a launcher, not
a branch around one, so a preview cannot decide differently from the run it previews.

The cost of that is worth stating, because it looks like an oversight. The comment marking
a task as taken is written by the **session**, once it is up, rather than by the dispatcher
at dispatch time. So a session that dies between being emitted and announcing itself leaves
no evidence it was started, and the next tick emits it again. The window is process start to
first tracker write — seconds against a session that runs for minutes — and the concurrency
cap bounds how many can sit in it at once. Closing it would mean the tick writes, and a
writing tick is permanent where this hole is bounded and self-correcting.

The exposed failure with no backstop at all is a stage that *forgets* its announcement: it
is re-dispatched every tick and does real work each time. There is no failure counter to
catch it, deliberately. The announcement being the first thing a session does is the whole
mitigation.

## `JEN_` is a one-way door: nothing named in it can reach a session

`childEnvironment` withholds every variable prefixed `JEN_` from a stage's session, and that
is exhaustive rather than heuristic only because jen defines the namespace — `VARIABLES` in
`github.ts` enumerates it, and a prefix test over a closed set has no unnamed member to miss.
Keeping that true has a cost that is easy to walk into: **a variable jen invents for a
*session* to read cannot be named `JEN_*`**, because the strip will take it away and the
symptom is the variable simply not being there. Nothing warns. Either name it outside the
namespace or hand it to the session some other way.

The scoping beside it reads every stage's `JEN_ENV_<STAGE>` declaration rather than only the
running stage's, which looks like a bug until the withholding case is in mind: giving
`test-task` a variable needs its own declaration, but *keeping* it from `deliver-task` means
`deliver-task`'s run reading `JEN_ENV_TEST_TASK` too, since nothing else tells it the name
was spoken for. The reason it cannot key on the role instead is `STAGES` — reviewing,
testing, and delivering are one role, so a role-keyed rule hands the stage that merges what
was meant for the stage that tests.

**`notes` is not `failures`, and the difference is load-bearing.** `RunOutcome.ok` is derived
as `failures.length === 0`, so anything pushed there stops a pipeline. A declaration that
scoped nothing — a misspelt stage, a variable the runner never held — left every stage
holding exactly what it would have held anyway, and is reported without failing anything.
Moving one of those into `failures` would fail unattended runs over a typo that changed
nothing.

## The in-flight test ignores the marker's stage, on purpose

`inFlight` takes the most recent comment carrying a `jen:run` marker and answers on its
`event` alone. It does **not** check that the marker's `stage=` matches the stage the task's
current status maps to, and it must not start: a session that has already moved the status
and is still writing its closing comment is a session still working the task, and matching
on stage would dispatch the next stage on top of it.

It also does not filter by comment author. `design.md` describes the test as reading the
tracker agent's own comments, and the tick has no agent identity to compare against — it
receives a team and a project and nothing else, by requirement. Establishing one would cost
a third query for a `viewer` id, to defend against a human hand-pasting an HTML comment.

## The comment page proves its own order rather than trusting the documented one

This is the section that reads like defensive noise until you know what it is defending
against, so the failure comes first. The in-flight test looks at the most recent marked
comment and nothing else. If a bounded page of ten comments came back *oldest*-first, every
announcement a long-running task has ever carried sits behind the bound, the task reads as
never announced, and a session is dispatched against it on every tick — forever, with no
error anywhere, and doing real work each time. Nothing degrades. It just never stops.

Linear documents `orderBy: createdAt` as descending and `linear.ts` requests it explicitly.
That is not evidence, and sorting the page afterwards is not a guard: a sort orders what came
back and says nothing about what stayed behind the bound. So `holdsNewest` makes the page
carry its own — the first `createdAt` against the last says which way the connection runs.
Descending with more behind it means this page is the newest and costs nothing; ascending
means it is the oldest; too short or tied to tell means unproven, which is treated as
oldest. A page with nothing behind it is the whole record either way.

`established` in `run.ts` is two loops because the two cases need different ones, and this
is the part worth reading before editing it. From a page known to be the newest, every
further page is strictly older, so the first marker found walking backward is the most recent
one and the walk stops there. From a page that is *not* known to be the newest, paging
forward walks toward newer comments — stopping at the first marker would settle on a stale
one, so the walk has to reach the end before anything is read out of it. Collapsing these
into one loop reintroduces exactly the bug the evidence exists to prevent.

The check is a comparison, not a judgment, so the dispatch path keeps its property that two
ticks over identical state reach identical conclusions. **Do not replace it with a one-off
verification against the live API**: that settles the question for one identity at one moment
and re-opens it silently, which is the worst shape a check can have when the failure it guards
is invisible.

**What the fallback costs is `COMMENT_PAGE_BUDGET` requests for that issue, not one.** Neither
walk ends on its own in the case that matters. The backward one stops at the first marker, so a
task that has been through a session once is cheap forever after — but a task nothing has ever
announced against has no marker anywhere, and the walk drains its whole record. The forward one
has no early exit *at all*, by construction: stopping early is the bug it was split out to
avoid. So if the connection ever does come back ascending, every issue past one page would
re-read its entire history on every tick, forever, growing with the discussion rather than
settling. The budget is what makes that a bounded cost instead of an unbounded one.

Exhausting the budget **declines the candidate**; it never falls through to `inFlight(…) ??
false`. "Not in flight" is what dispatches, so reading an unfinished record as idle would start
a session on top of a live one — the same failure the ordering evidence exists to prevent,
reached from the other side. The decline says `unproven` and names `--comment-page`, which is
the operator's lever: raising it moves how far the same number of requests reaches, which is
why the budget itself is not a second flag.

## A candidate is a task, and the label is a gate rather than a filter

Candidacy is the status *and* the `task` label. The first live tick against jen's own
project dispatched three issues and two were epics — ENG-136 and ENG-133 sit in stage
statuses as a matter of course, because their children are what is moving. A stage dispatched
against an epic spends a whole session establishing there is nothing to implement, and marks
the epic in flight while it does.

The label is tested in the tick, in `notATask`, and deliberately **not** put in the poll's
server-side filter even though that would be free. Filtering means the issue is never
fetched, so it can never appear in the report — and a person who moved an issue into a stage
status and saw nothing happen would have nowhere at all to find out why. Silence there is
indistinguishable from a pipeline with nothing to do. Fetching a handful of epics costs
nothing against a poll measured at 7 points.

`EPIC_LABEL` is read only to tell one decline from the other in the report. Candidacy rests
on `TASK_LABEL` alone, so an issue carrying neither label never dispatches — which is a real
behaviour change for a human-created issue moved straight into `In Design`, and the intended
one. The gate runs before the comment read, so a non-task never triggers the paging fallback.

## The status table is a second statement of the workflow's, held by a test

`stages.ts` restates the stage table in the root `AGENTS.md`, and cannot do otherwise — the
tick reads no files, and a runner need not have the repository checked out at all. So the
mitigation is `test/stages.test.ts`, which parses the table out of `AGENTS.md` and asserts
the compiled one matches, in the idiom `payload.test.ts` uses for the scaffold's skill
references. Same for the announcement marker, which has seven statements: six skills and
`MARKER`. Edit either statement and CI fails here, which is where both of them live.

Candidacy is an allow list for the same reason it is everywhere else in this file: a team
will add statuses jen has never heard of, and the failure mode of a deny list is dispatching
a stage against a task in a status nobody intended.

## The client names every field, so drift fails loudly

`linear.ts` writes out each field it wants rather than reaching for a fragment or the SDK's
generated documents. A removed field then fails at the tick with the tracker's own message.
The failure this avoids is the quiet one: an empty candidate set is indistinguishable from a
healthy quiet pipeline, so a client that swallowed a query error would report a working
dispatcher for exactly as long as nobody went looking. Every error path raises; none returns
an empty result.

`RATELIMITED` arrives as HTTP 400 with the code in the body rather than as a 429, so it is
matched by code and not by status. There is no retry anywhere in the client: the pipeline's
answer to a failed tick is the next tick.

## Every bounded connection asks for `pageInfo`, and something reports the truncation

Four connections in `linear.ts` are bounded — the team's statuses, the project's issues, an
issue's labels, an issue's comments — and each one asks for `pageInfo { hasNextPage }` beside
its nodes. Add a fifth and it carries the flag too.

This is the same failure as the swallowed query error, one level down. A bound with no flag
cannot tell a short answer from a truncated one, so a project with more issues in stage
statuses than the page holds loses the overflow entirely: not dispatched, not declined, not
named anywhere, nothing errors, exit 0. That is indistinguishable from a healthy quiet
pipeline, which is precisely the shape this client exists to refuse.

The tick does not *page* any of them, and does not need to. What it owes a person is that the
report account for everything sitting in a stage's status, and a `note` line naming the bound
satisfies that where paging would make every tick's cost scale with a project's backlog. What
each truncation changes is a claim:

| Connection | What silence would have asserted |
|---|---|
| statuses | that the team has no `Pending`, or none of a stage status — when neither was read |
| issues | that the pipeline is quiet |
| labels | that nothing has refined the issue |
| comments | that no session is working the task — the one that dispatches |

Only the last can start a session on wrong evidence, which is why only the last declines
rather than annotates. The other three report and carry on.

## `run()` hands back a number or a promise

`jen run` is the first asynchronous command. `cli.run` returns `number | Promise<number>`
rather than widening `init` and `update`, which are synchronous and whose callers depend on
it — `test/install.test.ts` narrows the union at its one call site rather than casting, so an
installer that quietly became asynchronous fails loudly instead of comparing a pending
promise against an exit code.

## Workspace trust is the invocation's, and `-p` does not exempt a run from it

`-p`'s own help says the trust dialog is skipped in non-interactive mode, which reads like a
dispatched run is exempt. It is not. A fresh clone under `-p` still prints
`Ignoring N permissions.allow entries from .claude/settings.json: this workspace has not been
trusted` and runs **as though the file were empty** — on every run, since every clone is a
path nothing has ever trusted. (Verified under `--permission-mode acceptEdits`, which is what
the invocation carried at the time; the mode is not what the trust check reads.)

What is lost is the project's own configuration. jen's seeded allow list was the original
motive and no longer exists — the scaffold grants nothing as of ENG-190 — but the job is
unchanged: an adopter's `.claude/settings.json` is where their own permission rules live, and
an untrusted clone runs as though they had written none. With nobody present, a rule a project
added precisely because its runs needed it is silently not in force.

Three routes past it were verified against 2.1.220 rather than read off documentation:
`--settings` (works, and rejected — it leaves the project's own file inert, which is the one
thing trust exists to prevent, and a project can grant its runs commands jen has never heard
of); overriding `HOME` (works, and rejected — it also relocates git's
config, ssh's known-hosts, and npm's cache, which a stage's own build reaches for); and
`CLAUDE_CONFIG_DIR`, which moves exactly the one store that needs moving. That is what
`exec.ts` uses, writing `projects[<clone>].hasTrustDialogAccepted` into a store the run throws
away.

**`CLAUDE_CONFIG_DIR` is not in `claude --help`.** The mitigation is worth more than the
choice: the run scans the session's stderr for that warning and fails the run on it. Do not
soften it into a warning — the whole point is that it turns a denial found halfway through a
run into a first-second failure.

**Know what that check does and does not cover, because ENG-190 narrowed it.** The symptom it
matches is an *entry count*, and the CLI prints no such line when the count is zero. Verified
on 2.1.260, two untrusted runs differing only in the array, both reaching the same
authentication failure so the silence is not a run that stopped early:

| `permissions.allow` | stderr, untrusted |
|---|---|
| `["Bash(npm run build:*)", "Bash(git:*)"]` | `Ignoring 2 permissions.allow entries …` |
| `[]` | **nothing at all** |

So a failed trust write is indistinguishable from a healthy start unless the project wrote
allow entries. Before ENG-190 that was safe to ignore, because `jen init` seeded eight of them
and every jen-installed project therefore emitted the warning. Now the scaffold grants nothing,
and every adopter is at zero by default.

The tempting reading — *no entries, nothing lost, correct silence* — is wrong, and the note at
the top of this section is why: what trust gates is the file, not any one key in it. A project
whose settings carry a `deny` rule and an `env` block and an empty `allow` loses all of it to
an untrusted clone and prints nothing; confirmed on 2.1.260 with exactly that file. The
guarantee that this check catches `CLAUDE_CONFIG_DIR` being withdrawn now holds only for
projects that happen to have written allow rules.

Do not fix that by loosening the regex — there is no wider *string* to match, because the CLI
emits no line at all. It needs a check that does not key on the entry count: verifying the
trust store took, or asserting the settings file was honoured by something other than a count.
That is **ENG-192**, deliberately not ENG-190, which was the mode switch.

**Auto mode adds nothing to stderr that `PERMISSION_WARNING` could confuse with a trust
failure.** Checked rather than assumed, because the two causes would be indistinguishable if
it did and every healthy run would report a trust failure that never happened. On 2.1.260, in
a workspace whose `.claude/settings.json` carries `Bash(npm run build:*)` and
`Bash(npm run typecheck:*)`, a trusted run under `--permission-mode auto` prints **nothing at
all** on stderr, while the same workspace untrusted prints `Ignoring 5 permissions.allow
entries …` under `acceptEdits` and `auto` alike, byte-identical. So the mode did not change
what the warning means and `PERMISSION_WARNING` needs no second clause; leave the regex as it
is.

**Do not restate that as "auto discards package-manager run commands on entry."** ENG-190
asserted that in four places before review caught it, and it is not established. Read the
negative for exactly what it is: silence on stderr is equally consistent with *dropped
silently* and with *never dropped*, so this experiment cannot be cited as evidence that any
particular rule is inert under `auto`. What 2.1.260 actually carries, found by reading the
binary's strings rather than by running it:

* an **opt-in** setting, default false, suspending *every* Bash/PowerShell allow rule while
  auto mode is active — all-or-nothing, not by category;
* an advisory `/auto-mode-setup` review that *flags* entries "broad enough that auto mode
  either ignores them at runtime, or auto-approves destructive commands with no check" and
  offers to remove them, with a person deciding.

So a runtime-ignored category does exist and is described by *breadth*. Nothing found sizes
it, and `Bash(npm run build:*)` is narrow. Treat any entry as live until it is deleted.

Two limits on all of the above. Both runs ended at `Failed to authenticate` before any tool
ran, so this is the startup path only — the right path, since the untrusted run died at the
same point and still printed the warning, but a discard announced at the first permission
check instead would not have been caught. And the mechanism cannot be settled from inside a
dispatched session at all: a nested `claude auto-mode config` is itself blocked by the
classifier, and working around that denial is the one thing not to do. Settle it from an
attended session or leave it open.

**The clone path must be `realpath`'d before the trust entry is keyed by it.** This is not
tidiness and it is not obvious: on macOS the system temporary directory is a symlink, so
`mkdtemp` hands back `/var/folders/…` while the session resolves its own workspace to
`/private/var/folders/…`. Key the entry by the unresolved path and the lookup misses, the
workspace reads as untrusted, and the permissions are silently inert — the exact failure this
module exists to prevent, by a route that looks impossible. It was found by a test, not by
reasoning, and the stderr check above is what would have made it loud in production.

## A run's clone cannot use `--branch`

`git clone --branch <branch>` fails when the branch does not exist, and **`design-task` runs
against a branch that does not exist yet** — the request carries the tracker's *suggested*
branch name, and design is the stage that first creates and pushes it. So a clone insisting on
the branch would fail every design dispatch, which is the pipeline's entry point, before the
session could report anything useful. `exec.ts` clones at the default branch, then places the
branch locally. It never pushes it: pushing is the stage's, and a branch pushed by the executor
is a branch with no commit explaining it.

Clones are full rather than shallow, and this is load-bearing rather than lazy. Stages read
history — the resume convention has them check commits against completion markers — and
`openspec archive` and delivery both work over more than one commit.

**Which of the two cases it is, is asked of the clone rather than of an exit code.** This ran
`git fetch origin <branch>` and read a non-zero exit as "the remote carries no such branch"
until review caught it. A missing ref and an unreachable remote **both exit 128**, with nothing
in the status separating them — so any transport or auth failure fell through to `--create` and
handed the session a branch cut from the default branch, with none of the task's history on it.
The resume convention amplifies that rather than catching it: a stage takes the commits on the
branch as evidence over any marker, so it reads the task as untouched, redoes the work,
announces itself, writes to the tracker, and moves the status — and the only thing that fails is
the push at the end, by which point the tracker says the stage completed. Late and silent.

A full clone already carries every head, so `git rev-parse --verify --quiet
refs/remotes/origin/<branch>` settles it against the clone, where a missing ref exits **1** and a
repository-level failure exits **128** and the two *are* separable. Only `1` is read as absent;
anything else is raised. And `git switch <branch>` off the remote-tracking ref sets the upstream,
which `--force-create <branch> FETCH_HEAD` does not — without it every resumed branch left the
session's own `git push` failing with *has no upstream branch*.

## The outcome is read from every signal, because no one of them is the whole story

ENG-164 was opened saying an in-run failure prints as the result rather than raising the exit
code. Verified against 2.1.220, an authentication failure raised **both** — exit 1 and
`is_error: true`. So reading either alone is right by accident and wrong the first time a
failure reports only one. `verdict()` fails on any of four: the stderr warning above, a
non-empty MCP failure off the `system/init` event, `is_error` on the result, and a non-zero
exit. They agree on success, and a disagreement is a failure either way.

Reading the init event is what forces `--output-format stream-json` and therefore `--verbose`,
which it requires. Plain `json` returns only the final result, and a session that never reached
the tracker cannot announce itself — which feeds straight back into the next tick dispatching
that task again.

**Two shapes of MCP failure exist and both are read**: an explicit `mcp_server_errors` list,
and an `mcp_servers` entry whose status is anything but `connected`. The task was written
against the first; the second is what has actually been observed. A check knowing only one of
them passes a session that never reached the tracker.

## A session gets its own role's token and none of another's

`credentialsFor` reads only the named role's variables, and `exec.ts` then strips **every**
`JEN_GH_*` variable out of the child's environment rather than filtering it down. A runner
configured for all three roles holds all three private keys, and a session inherits whatever
the runner's environment held. It needs none of them: it acts through the minted installation
token, already scoped to its own installation and expiring on its own.

The app slug comes from `GET /app` under the JWT rather than from a tenth environment
variable. `registry.yaml` records an `app` name per role, but the executor reads no files, and
a renamed app would otherwise commit under a name that no longer exists.

The tracker's `--mcp-config` payload is written to a file inside the run's own config
directory, never passed inline. A command line is readable by every process on the host, and
that string carries the tracker credential. The file goes with the directory when the run ends.

**The same rule governs the clone, and it is easy to break there without noticing.** An
installation token spliced into the clone URL is an argv element of `git clone` — the same
exposure, on the same host, and argv is the worse hiding place of the two:
`/proc/<pid>/cmdline` is world-readable where `/proc/<pid>/environ` is owner-only. So
`remoteUrl` carries the username and no credential, and `GIT_ASKPASS` points at a script in
the run's config directory that echoes `GH_TOKEN`. The session inherits both, which is what
lets it push through the same clone afterwards — the credential is supplied at each use and
goes with the run rather than sitting in `.git/config` for the length of it.

**Setting the token without setting `user.name`/`user.email` is a silent bug.** The token
governs what a run may *do*; the git config governs what the history *says* it was. Leave the
second out and commits carry whatever identity the host has configured — a person's, on a
runner started from their own machine — and the attribution `pipeline-identity` builds its
audit story on stops being true without anything failing.

**The noreply address is keyed by the bot user's id, not the app's, and nothing tells you
when you have used the wrong one.** They are different numbers for the same app —
`reveer-jen-dev[bot]` is app `4588651` and user `316769915`; `github-actions[bot]` is `15368`
and `41898282` — and an address built from the app id is accepted by every layer that handles
it and resolves to no account, so the commit renders with an unlinked name. That is the
attribution failure the paragraph above warns about, reached from *inside* the mitigation and
looking exactly like success. `installation()` therefore makes a third request,
`GET /users/<slug>[bot]`, and raises rather than falling back if the host names no id. It goes
under the minted installation token rather than the JWT: the JWT authenticates the *app*, and
a user lookup is an ordinary read rather than an app endpoint.

## A stop has to reach the steps between children, not only the running one

`terminate()` kills what is in `#live`. Nothing not yet spawned is in it — and a run's first
step is minting, which reaches the network with no child in existence at all. So a signal
landing in that window left the run to clone, configure, and start a full session after it had
been told to stop: money spent, and a stage writing to the tracker and pushing commits past
its own cancellation. `#spawn` refuses once `#terminating` is set, which puts the refusal on
the path the existing `catch` already handles and leaves the cleanup unchanged.

The outcome distinguishes the two stops, and `see()` in `run.ts` reads both: `sessionStarted`
false means nothing ran, true means the task holds whatever the session got to. `terminated`
is not the raw flag either — read straight off it, a run that had already finished and
succeeded reported as stopped, and the report then described a completed stage as one left
mid-session.

**A cleanup that failed is reported, not swallowed.** Removing the run directory is the whole
of how `stage-execution`'s "no credential remains on the host" is satisfied — `config/mcp.json`
holds the tracker's, live until someone rotates it — so the single case that violates the
requirement must not be the single case nothing says anything about. (The git token is not
among what is left behind, and only because of the `GIT_ASKPASS` arrangement above: put it
back in the clone URL and it sits in `.git/config` here too.) It is added to the run's
failures rather than raised over them, so it never masks the session's own outcome.

## Only the tracker's own key earns the tracker's diagnosis

A run's clone is a full jen installation, so a project's own `.mcp.json` contributes MCP
servers beside the one the executor passes. `readStream` keeps each failure's server name and
`verdict` reserves "the tracker connection did not initialize" for `TRACKER_SERVER`; anything
else is named as itself. Pooling them sends whoever reads the report after the wrong system
entirely, and the report is all an unattended run leaves behind.

## A run can outlive the token it minted, and the two halves fail apart

The installation token `github.ts` mints expires an hour after minting, it is minted **once** at
the very start of the run, and `jen run` now blocks for as long as its sessions take — which a
stage session can plainly push past an hour.

What makes this worse than a plain expiry is *which* half stops working. The tracker credential
is the project's long-lived agent key, so `LINEAR_API_KEY` keeps working for the whole session;
only `gh` and `git push` go 401. A stage that crosses the hour can therefore still announce,
comment, and move the task's status while being unable to push what it did or to touch the PR.
It ends by writing a closing comment saying the stage is done, and the commits go with the run
directory when it is swept. That is exactly the marker-outliving-its-work case the resume
convention warns a later stage about — manufactured by the executor rather than by a killed run.

`expiresAt` is captured and currently read by nothing; it is carried so this is observable
rather than because anything acts on it. There is no cheap fix, which is why this is a note and
not a guard: the session holds the token in its environment, and neither `gh` nor an
already-started child can be handed a new one. Anything real here is a design decision — an
askpass reading a file the run refreshes, a `gh` credential helper, or a run that declares a
ceiling on session length and fails *at* it rather than past it. ENG-167 carries the observation
that settles which: how long a real stage session actually takes against the hour it has.

## Neither model credential reports what it has left, so exhaustion has no symptom jen can read

The installation token above at least *says* when it expires. Model access says nothing. An API
key's balance and a subscription's usage window are both invisible from inside a run — there is
no field to capture the way `expiresAt` is captured — so a token that has been revoked, or a
window the operator's own interactive work already spent, surfaces as a session dying at model
access with nothing in jen's output naming the cause. It reads as an ordinary stage failure.

This is why the both-set case in `credentialsFor` is a refusal rather than a precedence. Every
other credential jen reads has exactly one name, so a wrong one fails loudly the first time it
is used; a model credential picked silently out of two fails only later, on the *other* one's
budget, and the operator has nothing to read that says which was spent. Refusing costs one
`unset` at configuration time, where a person is. The delete in `childEnvironment` is the same
argument one layer down — the session is given the name the run holds and no other, so the CLI
never gets to apply its own precedence below jen's decision.

## The runner holds no lock, deliberately

`jen watch` keeps no lock file, no pidfile, no ledger, and no memory of what it launched.
This is not an omission to be tidied up the first time someone runs two of them.

A lock is pipeline state one instance has and another cannot see. jen ships one runner but
does not ship the only one — a timer, a container, or a scheduled job on a git host drives
the same `jen run`, and none of those shares a host with this process. So the moment `watch`
consults a lock, runners stop being wrappers over one tick and start being implementations
that can reach different conclusions from the same tracker. What actually stops a task being
dispatched twice is the announcement on the task — which every runner reads, and which a
restart re-establishes for free.

Two instances on one project are therefore governed by exactly what two runners are: the
in-flight test and the concurrency cap, both derived from the tracker. `test/watch.test.ts`
asserts the negative by snapshotting the checkout across ticks.

Signals are the loop's rather than any tick's. `cli.ts`'s `dispatch()` installs handlers per
invocation and removes them on the way out; `watch()` installs its own for the length of the
process and calls `tick()` directly rather than routing through `dispatch()`, which is what
keeps the two from ever both being installed.

## The halt matches two ways, and which one applies depends on whose name the status is

`haltingStatus()` in `run.ts` is the single seam, and it asks two questions. A status the
*workspace* named is matched on its `type` — `HALTING_STATUS_TYPES` is `completed`, `canceled`
— so a workspace that renamed `Completed` or added a status of its own is still understood by
the category the tracker files it under. A deny list rather than an allow list over `started`,
because jen's own project sits in `Backlog` while its pipeline runs and an allow list would
have halted it silently.

The pause is matched on its **name**, `PAUSED_STATUS_NAME` — `On Pause` — folded exactly as
the stage statuses are. That is not the type rule being abandoned; it is the type rule running
out of signal. Verified live against this workspace: `ProjectStatus.type` is the *category*,
and there are exactly five — `backlog`, `planned`, `started`, `completed`, `canceled` (one
`l`). There is no `paused`. The pause the API's older project `state` field carried became a
status *named* `Paused` filed under `planned`, and `planned` is precisely the category that
must not halt, since ordinary planning projects share it. So the pause is filed under
`In Progress` (`type: started`) where it reads truthfully, and a category every working
project shares can carry no signal at all.

**The rule to keep, when the next status question comes up:** match by name only what jen
prescribes and `setup-jen` tells the operator to create, the way `stages.ts` already matches
`In Design` and `Pending`. Match by type anything the workspace chose for its own reasons.
Inferring a workspace's meaning from a name it picked itself is the thing that stays banned.

Two traps worth naming, both found the expensive way:

- `save_project`'s `state` is not a probe. A name that resolves to no status is answered by
  the project's status simply not changing, with no error — so a failed set is not evidence
  the status is absent, and a set that appears to work is the only thing that means anything.
- `list_projects`' `state` filter does not validate its argument either. A nonsense value
  returns an empty list, identically to a real-but-unused one. An empty result there is not
  evidence about the schema.

Together those are why `setup-jen` reports this status rather than verifying it: the tracker's
tool surface has no call that lists project statuses and none that creates one, and neither of
the two above can be bent into standing in for the missing read.

## The extra-approval setting does not reach an application's pull request, and it can only be observed

`require_extra_approval_for_unattributed_changes` sits on a ruleset's `pull_request` rule
beside the count and the two settings delivery's own push walks into. It is **on by default**,
on new rulesets and existing ones alike, so a project carries it without anyone choosing it,
and where it applies it raises the effective requirement to one *more* than configured. That
is above the bound `pipeline-identity` states — one approval from `deliver` is the ceiling of
what the pipeline can produce — so if it reached the pipeline's pull requests, every task
would park in delivery on an approval nothing can give.

It is **inert at an approving-review count of zero**, which is the state of every branch that
has not yet been through `setup-jen`'s gate section. So a repository that has never raised its
count holds no evidence about this either way, and raising the count is the act that makes the
setting live for the first time. That is why it went unnoticed here through ENG-141 and two
rounds of ENG-173's own gate wording.

**Observed on this repository, 25 Aug 2026**, immediately after `primary` (ruleset `20589957`)
went to `required_approving_review_count: 1` with the setting left `true`: PR #12
(`Version Packages`, authored by `app/reveer-release` — an application acting as itself, not on
behalf of a person) went from `reviewDecision: REVIEW_REQUIRED` / `mergeStateStatus: BLOCKED`
at zero approvals to `APPROVED` / `CLEAN` on **one** approval. So the setting is scoped as
GitHub documents it — to the host's own assistant — and does not reach an ordinary
application's pull request. It stays `true` on `primary`, and nothing in the pipeline is
affected by it.

**The part that cost the time: the requirement cannot be read, only observed.** There is no
per-pull-request effective approval count anywhere on the API. `PullRequest.reviewRequirements`
does not exist on the GraphQL type; `/repos/{owner}/{repo}/rules/branch/{branch}` answers `404`
for a token without administration access; and `reviewDecision` is `REVIEW_REQUIRED` at zero
approvals whether the branch wants one approval or two. The two cases are indistinguishable
until an approval exists, so the only instrument is to put **exactly one** approving review on
an application-authored pull request and read whether the decision flips. A session that plans
to "read the requirement" will find nothing to read and should budget for the approval instead.

Two things to keep straight if this is re-derived. The vehicle has to be **application-authored**
— a human-authored pull request is outside the setting however the host scopes it, so approving
one demonstrates nothing while looking exactly as though it had. And this observation is
evidence about an application acting as itself, which is what the three pipeline roles are; it
is not evidence about any other setting in the family, each of which needs its own vehicle.

**This observation also ships**, in the gate section of `.claude/skills/setup-jen/SKILL.md`, and
it has to: an adopter's project has never opened a pipeline pull request, so without it every
first binding meets this setting, reports it undetermined, and reports the gate unsatisfied with
no move available. The shipped copy is the observation with its provenance — host, date, vehicle,
repository state — and the instruction to cite rather than conclude, which is what keeps it from
ageing into an assumption. **Two copies, and they must not drift**: whatever re-derives or
supersedes what is written here updates the skill in the same change, and `test/merge-gate.test.ts`
holds the shipped one to carrying its date and its vehicle.
