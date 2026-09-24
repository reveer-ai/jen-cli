# jen

The workflow layer for automated, agentic software development — task-anchored, spec-driven, and git-reviewed.

jen installs a workflow into your project's repository: a workflow document every agent working there is bound to, and a set of skills that carry it out. Work is anchored to a task in your tracker, specified before it is written, and reviewed as a pull request that holds the specs and the code together. Each stage is a skill, and the status a task sits in says which one it needs next.

jen does not host your project or point at it from somewhere else. It installs *into* your repository — the root becomes jen's (`AGENTS.md`, `.claude/`, `openspec/`, `registry.yaml`), and your own sources live under `src/`, tracked right there beside the workflow that governs them.

## What jen owns, and what you own

Read this before you install. jen overwrites its own files on every update, and an edit to one of them is gone the next time you take a version — so where the boundary falls decides where it is safe to work.

| Path | Who owns it | What an update does |
|---|---|---|
| `AGENTS.md` (root) | jen | **Replaced wholesale.** This is the workflow document. Notes you write here are lost. |
| `.claude/skills/<stage>/SKILL.md` (the six shipped skills) | jen | **Replaced wholesale.** A skill jen stops shipping is deleted. |
| `registry.yaml` | you, from the moment it exists | Nothing. Written once when it is absent, then never rewritten or deleted. |
| `.claude/settings.json` | you, from the moment it exists | Nothing. Same once-only rule. |
| `src/`, your `openspec/` content, skills you write yourself | you | Nothing. jen does not touch them and never deletes an unstamped file. |
| your `.gitignore` | you | Nothing. jen writes no ignore rules and imposes no arrangement on what you track. |

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

Writes the workflow document, the six skills, and a scaffold your project owns from then on, then initializes OpenSpec in the project. It prompts for nothing, is safe to re-run, and is safe in CI. It reports every path it wrote, refreshed, or left alone.

### 3. Fill in `registry.yaml` — your step, not a command

`jen init` leaves the workflow pointing at nothing: `registry.yaml` is a stub. Record your project's repository and the tracker project that tracks it there, by hand. The comment at the top of the file shows the shape of each entry, and the stages consult it for the resources a task acts on.

Your tracker also needs the statuses the stages move tasks through (`Backlog`, `Todo`, `In Design`, `Pending`, `In Progress`, `In Review`, `In Testing`, `In Delivery`, `Done`) and the `epic` and `task` labels. Nothing creates them for you.

From there, a stage is a skill you ask your assistant to run against a task — `Run design-task on ENG-123`.

### 4. Permissions — what a session may run

A stage may run with nobody watching, and a denied action is not a prompt an unattended run can wait out. That is why this section exists — but it is no longer a list you have to write.

**Run a stage in a permission mode that judges each action on what the action is**, rather than matching it against permissions named in advance — in Claude Code, that is auto mode. Under it, installing your declared dependencies, running your typecheck, your linter, your build, your tests, the one-off command a task turns out to need — ordinary development work needs no entry anywhere, and nothing about your project has to be enumerated for the pipeline to run it.

That judgment belongs to the mode, not to jen: jen launches no session, so it is whoever starts a stage who chooses it. A session in the default mode asks before each such command instead. With you watching, that is only a prompt to answer; an unattended invocation has nobody to answer it, so it has to select the judging mode itself (`claude --permission-mode auto …`).

jen grants nothing on your behalf, deliberately. It chooses what it ships long before your project exists, so any list it wrote would be a guess at a toolchain it never saw — granting entries you have no use for while missing every one you depend on.

**`.claude/settings.json` is still yours, and still read.** `jen init` writes it with an empty `allow` list, as the seat for a rule you actually want: something to permit that a per-action judgment would otherwise stop, or to deny that it would otherwise let through. An entry you put there is in force in a stage's session wherever your assistant reads this project's settings — for Claude Code, once the project is trusted, which it asks the first time you open the project interactively.

```json
"Bash(terraform state:*)"
```

Entries you add, not a file to paste over the one jen wrote — replacing it drops whatever else the file holds, and that loss surfaces as behaviour in the middle of a run rather than as an error. A rule to permit goes in the empty `allow` list jen leaves you; a rule to deny goes in a `deny` list beside it, which you add, since jen ships no `deny` key to fill in.

The tracker's own tools come from your assistant's own MCP configuration — the tracker server you have connected to it — rather than from this file, since their identifiers differ per install. jen neither ships that configuration nor supplies it at launch; a stage can reach the tracker only if the session you invoke it from already can.

**On a project installed before this changed, the entries jen once wrote are still in your file, and they are yours** — to keep or to remove. `.claude/settings.json` is yours from the moment it exists and `jen update` never rewrites it, so no version you take will empty it for you. Removing them is the better default. A matching entry resolves *before* the judgment is made rather than alongside it, so each one exempts everything it covers from review for as long as it sits there — and `Bash(gh:*)`, which jen used to ship, covers the approving review and the merge at the end of the pipeline. Treat every entry as live until you have deleted it; do not assume the newer mode has already made one inert.

### 5. Take a later version

```bash
npm i -D @reveer/jen@latest && npx jen update
```

`update` refreshes every managed file and removes the ones jen no longer ships. It writes no scaffold — `registry.yaml` and `.claude/settings.json` stay yours, untouched, however many times you run it.

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
