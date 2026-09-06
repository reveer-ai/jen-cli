# jen

The workflow layer for automated, agentic software development — task-anchored, spec-driven, and git-reviewed.

jen installs a workflow into your project's repository: a workflow document every agent working there is bound to, and a set of skills that carry it out. Work is anchored to a task in your tracker, specified before it is written, and reviewed as a pull request that holds the specs and the code together. Each stage runs when its task reaches that stage's status.

jen does not host your project or point at it from somewhere else. It installs *into* your repository — the root becomes jen's (`AGENTS.md`, `.claude/`, `openspec/`, `registry.yaml`), and your own sources live under `src/`, tracked right there beside the workflow that governs them.

## What jen owns, and what you own

Read this before you install. jen overwrites its own files on every update, and an edit to one of them is gone the next time you take a version — so where the boundary falls decides where it is safe to work.

| Path | Who owns it | What an update does |
|---|---|---|
| `AGENTS.md` (root) | jen | **Replaced wholesale.** This is the workflow document. Notes you write here are lost. |
| `.claude/skills/<stage>/SKILL.md` (the seven shipped skills) | jen | **Replaced wholesale.** A skill jen stops shipping is deleted. |
| `registry.yaml` | you, from the moment it exists | Nothing. Written once when it is absent, then never rewritten or deleted. Read, though: it is where the runner gets your tracker project from. |
| `.claude/settings.json` | you, from the moment it exists | Nothing. Same once-only rule. |
| `src/`, your `openspec/` content, skills you write yourself | you | Nothing. jen does not touch them and never deletes an unstamped file. |
| your `.gitignore` | you | Nothing. jen writes no ignore rules and imposes no arrangement on what you track. |

**Change which project the pipeline polls in `registry.yaml`.** The runner reads it from the checkout it was pointed at, when it starts — so editing the registry is the whole of it, and a running runner takes the change on its next start.

### The stamp, and what it does and does not protect

`.claude/skills/` is shared: jen's skills sit in it beside any you write. Every skill jen put there carries an ownership stamp in its frontmatter, which is how it tells the two apart:

```yaml
metadata:
  jen: true
```

The stamp marks a file as **jen's to remove**. It governs deletion, not overwriting, and the difference is the one thing worth knowing before you edit anything:

- **A skill jen still ships is overwritten on every update, stamped or not.** Deleting the stamp does not claim it. The next `jen update` rewrites the file and puts the stamp back, and your edit is gone either way.
- **A skill jen has stopped shipping is deleted only if it still carries the stamp.** Deleting the stamp keeps it, which is how you hold on to a skill a later version dropped.
- **A skill jen never shipped is never touched.** Unstamped and not in the payload means jen leaves it exactly where it is.

So there is no supported way to keep an edit to a skill jen currently ships. If you want different behaviour, write your own skill under its own name — that file is yours, permanently, and no update will look at it.

The same goes for the workflow document. Root `AGENTS.md` carries no stamp at all — jen owns that path outright and replaces it on every update. Project notes go in an `AGENTS.md` nearer the code they describe, at or below `src/`, which jen never touches.

## Adopting jen

### 1. Install

```bash
npm i -D @reveer/jen
```

A devDependency rather than a bare `npx`, so that jen and the OpenSpec version it drives are both pinned in your project's lockfile. Every stage of the workflow runs OpenSpec, and it has to resolve from your project rather than from wherever `npx` cached it.

### 2. Initialize

```bash
npx jen init
```

Writes the workflow document, the seven skills, and a scaffold your project owns from then on, then initializes OpenSpec in the project. It prompts for nothing, is safe to re-run, and is safe in CI. It reports every path it wrote, refreshed, or left alone.

### 3. Bind the project to its tracker — your step, not a command

`jen init` leaves the workflow pointing at nothing. `registry.yaml` is a stub, and nobody has checked that your tracker carries the statuses the stages move tasks through. Binding closes that gap.

**No subcommand does this.** It is a conversation: which team, which project, and a look at whether the statuses and labels the pipeline needs are actually there. The CLI never reaches your tracker. Ask your assistant to run the `setup-jen` skill:

```
Run the setup-jen skill
```

It confirms the team and project with you, verifies that the pipeline's statuses exist (`Backlog`, `Todo`, `In Design`, `In Progress`, `In Review`, `In Testing`, `In Delivery`, `Done`), ensures the `epic` and `task` labels, and records the result in `registry.yaml`. It creates no status and renames nothing — a missing one is reported for you to add. Re-run it as often as you like; it holds no state and every step is idempotent.

Once it reports the project bound and the statuses satisfied, the pipeline can run.

### 4. Permissions — what a session may run

The pipeline's stages run with nobody watching, and a denied action is not a prompt an unattended run can wait out. That is why this section exists — but it is no longer a list you have to write.

**A session judges each action on what the action is**, rather than matching it against permissions named in advance. Installing your declared dependencies, running your typecheck, your linter, your build, your tests, the one-off command a task turns out to need — ordinary development work needs no entry anywhere, and nothing about your project has to be enumerated for the pipeline to run it.

jen grants nothing on your behalf, deliberately. It chooses what it ships long before your project exists, so any list it wrote would be a guess at a toolchain it never saw — granting entries you have no use for while missing every one you depend on.

**`.claude/settings.json` is still yours, and still read.** `jen init` writes it with an empty `allow` list, as the seat for a rule you actually want: something to permit that a per-action judgment would otherwise stop, or to deny that it would otherwise let through. An entry you put there is in force in a dispatched run exactly as it is in a session you run yourself.

```json
"Bash(terraform state:*)"
```

Entries you add to the list already there, not a file to paste over the one jen wrote — replacing it drops whatever else the file holds, and that loss surfaces as behaviour in the middle of a run rather than as an error.

The tracker's own tools are granted where the pipeline is invoked rather than here, since their identifiers differ per install.

**On a project installed before this changed, the entries jen once wrote are still in your file, and they are yours** — to keep or to remove. `.claude/settings.json` is yours from the moment it exists and `jen update` never rewrites it, so no version you take will empty it for you. Keeping them costs you nothing directly. Be aware only that a matching entry resolves *before* the judgment is made rather than alongside it, so a broad one exempts everything it covers from review — `Bash(gh:*)`, which jen used to ship, covers the approving review and the merge at the end of the pipeline.

### 5. Give the stages the configuration your commands read

The section above settles what a session may *run*. This settles what those commands can *read*.

**Everything you set on the runner reaches every stage's session**, under the same names you set it under. A suite that connects to `DATABASE_URL` finds `DATABASE_URL`; an integration test that reads `API_BASE_URL` finds that. This is deliberate rather than incidental: jen has no way to enumerate what your toolchain reads — `NODE_OPTIONS`, `CARGO_HOME`, `VIRTUAL_ENV`, a proxy setting, your own variables — and a list of the ones it could think of would be wrong in a way that surfaces as a stage failing at the first command that needed the name jen left out, mid-run, with nobody watching.

**jen's own `JEN_*` namespace is the exception, and never reaches a session.** The nine role credentials are inside it, so the passthrough does not expose them: a session acts through a token minted for its own role, and cannot read the keys the runner holds for the other two.

#### Narrowing a variable to one stage

Some things should not reach every stage. A credential to a live environment belongs to the stage that tests, and not to the stage that merges. Name the variables that stage may have:

```
JEN_ENV_TEST_TASK=STAGING_SSH_KEY,SMOKE_TARGET
```

**The value is a list of variable *names*, not values.** `STAGING_SSH_KEY` and `SMOKE_TARGET` keep their own names and their own values, set on the runner as anything else is; this says only who may see them. Your secret stays written down in one place.

Both named variables now reach `test-task` and no other stage. The variable is named after the skill — `JEN_ENV_DESIGN_TASK`, `JEN_ENV_IMPLEMENT_TASK`, `JEN_ENV_REVIEW_TASK`, `JEN_ENV_TEST_TASK`, `JEN_ENV_DELIVER_TASK` — under the same rule as the credentials above, upper-cased with `-` written `_`. Declare nothing and nothing changes: an unnamed variable reaches every stage, as it does today.

**The narrowing is by stage, not by role.** Reviewing, testing, and delivering all act under the one `deliver` role, so nothing about the roles keeps `test-task`'s variable from `deliver-task` — the declaration is what does, and it is why this keys on the stage. A name you list under two stages reaches both.

A declaration that turns out to scope nothing — a stage name misspelt, or a variable the runner never held — is reported in the run's output and does not fail it. Nothing was withheld from anyone, so there is nothing to stop the pipeline over; the note is there because a restriction you believe is in force and is not is worth knowing about.

### 6. Take a later version

```bash
npm i -D @reveer/jen@latest && npx jen update
```

`update` refreshes every managed file and removes the ones jen no longer ships. It writes no scaffold — `registry.yaml` and `.claude/settings.json` stay yours, untouched, however many times you run it.

## Running the pipeline

Everything above installs the workflow and points it at your tracker. This is the step that makes it act on its own.

A **runner** drives one thing: `jen run`, a single pass over the tracker — poll, decide which tasks are ready for which stage, run a session for each, exit. It never loops. Driving that pass on a schedule is the runner's whole job.

jen ships one runner: `jen watch`, a process you start and keep up. A runner jen does not ship is equally valid — see *A runner jen does not ship* below.

**Running the pipeline from your own machine does not remove the git host from it.** The stages still open pull requests, push branches, submit review verdicts, and depend on the branch's merge gate to make that review load-bearing — so the three registered applications are exactly as necessary here as anywhere. What the runner decides is where the *poll* runs, nothing more.

### What the runner needs

**Claude Code 2.1.259 or later**, before anything else. jen launches every stage session with `--permission-prompts`, which an older CLI does not recognize — and an unrecognized option is refused before the session starts. There is no session, no transcript, and nothing in the run's output that distinguishes it from a stage that was dispatched and did nothing, so this is worth checking rather than discovering: `claude --version` on the machine the runner runs on, not on yours.

Eleven values, then. Three per role, for the three applications `setup-jen` walked you through registering:

```
JEN_GH_APP_ID_DESIGN         JEN_GH_APP_ID_DEV         JEN_GH_APP_ID_DELIVER
JEN_GH_INSTALLATION_DESIGN   JEN_GH_INSTALLATION_DEV   JEN_GH_INSTALLATION_DELIVER
JEN_GH_PRIVATE_KEY_DESIGN    JEN_GH_PRIVATE_KEY_DEV    JEN_GH_PRIVATE_KEY_DELIVER
```

plus `LINEAR_API_KEY` — your tracker agent's key, shared by all three roles — and one model credential. That last one has two accepted spellings, and they are two ways of writing one value, not two values to store:

```
ANTHROPIC_API_KEY            # an API key, billed per token
CLAUDE_CODE_OAUTH_TOKEN      # a token minted from a Claude subscription
```

**A runner holds exactly one of them.** Set both and every run refuses before it starts a session, names both, and stops. jen will not pick one for you: the two are not paid out of the same pocket, so choosing silently is wrong in both directions — it either bills a key you believed you had stopped using or spends a subscription window you meant to keep. Unset the one this runner is not to spend.

`claude setup-token` mints the subscription form and prints it; it requires a Claude subscription, and the value goes wherever your runner reads its secrets from, under `CLAUDE_CODE_OAUTH_TOKEN`. What it costs you is not money. **The subscription's usage limits are shared with your own interactive use of the same account** — a polling pipeline launching up to three sessions a tick can spend the window you were about to work in, and you meet that as a stage dying mid-run rather than as a bill. jen cannot see either credential's limit or its expiry, so nothing warns you first.

The two also differ in what they are bound to. The token is long-lived and belongs to the person who minted it and to that person's subscription; an API key is issued independently of any one person, and outlives whoever created it. That does not make the token the broader credential — it carries **inference-only** authority by design, which the CLI enforces: it refuses a `CLAUDE_CODE_OAUTH_TOKEN` for Claude in Chrome and for Remote Control, both of which require a full login. Inference is exactly what a pipeline session does, and less than a login grants.

If your Claude installation is managed, its policy may forbid minting one at all, and `claude setup-token` says so in as many words. That is a stated limit on your installation rather than a malfunction, and `ANTHROPIC_API_KEY` is still open to you.

jen writes none of these anywhere. A run reads them from its environment at the point of use, mints a short-lived installation token per session, and the run's working directory goes when the run does.

### Starting it

```bash
export LINEAR_API_KEY=…        # and the nine JEN_GH_* values
export ANTHROPIC_API_KEY=…     # or CLAUDE_CODE_OAUTH_TOKEN — whichever one you hold, never both
npx jen watch
```

Pointed at a checkout, it reads that checkout's `registry.yaml` for the team and project, so there is nothing else to configure. `--team` and `--project` override it, `--interval <seconds>` changes the pace — it defaults to 60 — and every flag `jen run` takes works here too.

If the checkout names no tracker project and you gave none, it refuses to start, names what is missing and the checkout it read, and polls nothing. That is the state a project is in between installing jen and binding it. Refusing beats polling an empty team name, which would be indistinguishable from a pipeline with nothing to do.

It writes no pidfile, keeps no log file, and rotates nothing — its output is stdout and stderr, and where that goes is yours to decide. Run it under whatever supervises processes on that machine.

### A runner jen does not ship

Anything that can invoke `jen run` on a schedule is a runner: a systemd timer, a cron entry, a container, a scheduled job on your git host, a scheduler jen has never heard of. Supporting one needs nothing added to jen — `jen run` is the entry point, and it is already published.

jen supplies no workflow file, template, or worked example for any of them. The file that drives the tick is yours.

That is a deliberate reversal. jen used to ship a scheduled GitHub Actions workflow and removed it, because `jen run` waits for the sessions it launches — so the job holds a paid runner for the entire life of every stage session, not just for the poll. At roughly five stages of about fifteen minutes, one task consumes something like 75 runner-minutes, which is agent sessions billed as CI compute on 2-vCPU hardware. Shipping a ready-made replacement would walk you back into that cost with jen's apparent endorsement. Writing your own is a choice you have made with the number in front of you.

### What the runner does not protect you from

**A session dies with the process that launched it.** Stop `jen watch`, or lose the machine, and every session it launched stops too. The task keeps the announcement its session wrote and never gets the closing comment, which every later tick reads as *a session is still working this* — so that task will not be picked up again until a person moves it. That is deliberate: nothing writes to the tracker on a dead session's behalf, because the alternative is a stage that reports completion while its commits go with the discarded run directory. When you kill a runner, check what it was working.

**A hung session hangs the loop.** The runner awaits each tick, and a tick waits for the sessions it launched, so a session that never finishes stops the next poll from happening at all. There is no timeout: stopping it is yours, and the pipeline has no liveness bound of its own.

### What it does while nobody is watching

- **Two transitions stay yours.** `Todo` → `In Design` starts a task's design, and `Pending` → `In Progress` starts its implementation. No runner makes either. From `In Progress` onward the pipeline drives itself: design → implement → review → test → deliver → merged.
- **Any stage can hand a task back to you.** `Pending` is where a stage parks anything only a person can settle — a decision it cannot make, a blocker it cannot clear, work that is finished and needs your eye, or a task it judges is circling. The comment the stage leaves says which. A task sitting in `Pending` is waiting for you and will not move on its own.
- **Three tasks at a time.** `--concurrency` caps how many sessions may be in flight, and it defaults to 3. The cap is derived from the announcements on the tasks themselves rather than from anything a runner remembers, so two runners pointed at one project share one ceiling.
- **Ticks do not overlap.** The interval is a floor between the *end* of one pass and the start of the next, never a promise of when a poll happens. A tick waits for the sessions it launched, so a long session delays the following poll.
- **Each run leaves a record.** Every dispatch and every finished session is a line of JSON on stdout — task, stage, role, outcome, cost, session id — beside a readable report on stderr. `jen run | recorder` works with no flag. Session transcripts are discarded unless `--transcripts <dir>` names somewhere to keep them.

### Stopping it

Move the **tracker project** to a status named `On Pause`. The next tick reads that before it polls, reports it, and dispatches nothing.

That status is one you create, once, in Linear's **workspace settings → Projects → Statuses**: a status named exactly `On Pause`, filed under the **`In Progress`** category. `setup-jen` tells you to create it but cannot check that you did — the Linear tools it works through offer no way to read a workspace's project statuses, let alone add one. Until it exists, the pipeline runs fine and has no off switch.

The name is what jen matches, and the category deliberately is not. `In Progress` is where every working project sits, so it carries nothing the halt could read; filing the pause under `Completed` or `Canceled` instead would let the category do the work, but only by making the tracker say your live project is finished or abandoned on every surface that shows its status. So: **rename that status and the halt stops working, silently.** It is the one piece of jen's configuration where a rename costs you something you only discover when you reach for it.

Those two categories do still halt, matched on the category rather than on any name — a project that is genuinely completed or cancelled dispatches nothing, which is what you want and needs no setup.

That is the halt under any runner, including one jen does not ship, and it is deliberately not a runner-level switch: no process to stop, no task's status to edit, and nothing to redeploy when you want it back. Move the project back to an active status and the next tick carries on. Sessions already running are not interrupted — a session that has announced itself owns its task until it reports.

For a preview rather than a stop:

```bash
npx jen run --dry-run
```

which polls and reports exactly what the pipeline would do right now, launching nothing, cloning nothing, and writing nothing anywhere.

## Which assistants this reaches

The instructions jen ships — the workflow document and the skills — go into `.claude/` and the repository root, and into no other assistant's directory. Claude Code picks the skills up with no further configuration.

For another assistant, symlink the directory it reads to jen's — substituting whatever directory yours actually uses:

```bash
mkdir -p .agents && ln -s ../.claude/skills .agents/skills
```

That symlink is yours. jen neither creates it nor reads it, and it survives every update because nothing jen ships knows it exists. Whether your assistant picks skills up that way is between you and it.

Point the link *at* `.claude/`, never the other way around. jen refuses to write through a symlinked directory on the way to one of its own paths, so making `.claude` itself a link stops `init` and `update` outright.

## What adoption does not cover

**A project that already has its own root `AGENTS.md` cannot be adopted as it stands.** `jen init` refuses it and writes nothing at all — no skills, no scaffold, nothing partial. jen owns that path wholesale and cannot tell your file from one it wrote earlier, and merging the two is a migration jen does not perform.

You have two ways forward, and both are decisions rather than workarounds:

- Move your file aside, run `jen init`, and fold what you need back into the workflow document knowing an update replaces it.
- Run `npx jen init --force`, which replaces your root `AGENTS.md` wholesale with jen's. `--force` applies to `init` only, and only to this one ambiguity — it never overrides a scaffold file that already exists, and it never makes jen delete something it did not write.

`jen init` also refuses a project that reaches a managed path through a symlinked directory, `--force` included. Everything below such a link belongs to wherever it points, possibly outside your project entirely.

## Changing jen itself

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
