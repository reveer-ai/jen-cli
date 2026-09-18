# @reveer/jen

## 0.5.1

### Patch Changes

- [#30](https://github.com/reveer-ai/jen-cli/pull/30) [`755c494`](https://github.com/reveer-ai/jen-cli/commit/755c49480150543fbc9ba313e158c4af9e393b1c) Thanks [@joshtgi](https://github.com/joshtgi)! - The repository is now `reveer-ai/jen-cli`. The package is still `@reveer/jen` and the binary is still `jen` — only the repository moved, so nothing about installing or running jen changes.

  `repository.url` in the manifest tracks the new name. That field is what `npm publish --provenance` attests against the workflow's own repository, so it is not cosmetic metadata: left stale it is a mismatch at publish time rather than a wrong link on the registry page.

  GitHub redirects the old repository URL, so existing clones, links and the git remote keep working — but a redirect is a courtesy, not a binding, and anything that matched the old name exactly does not follow it. The npm trusted-publisher entry is the one that matters: it names owner, repository, workflow and environment, and a repository that no longer matches fails the OIDC exchange as a 404 naming the package.

## 0.5.0

### Minor Changes

- [#28](https://github.com/reveer-ai/jen/pull/28) [`4c5e3db`](https://github.com/reveer-ai/jen/commit/4c5e3db3d5da8f9f5f1dc099c33c6117898f28c5) Thanks [@joshtgi](https://github.com/joshtgi)! - Stage sessions launch under `auto` permission mode, and the scaffold grants nothing.

  **Required action: Claude Code 2.1.259 or later on the machine that runs the pipeline.** The invocation now carries `--permission-prompts none`, which an older CLI rejects as an unknown option — and an unknown option is refused before the session starts, so it presents as a stage that was dispatched and produced nothing rather than as a version problem. Check with `claude --version` on the runner's host, not on yours.

  `--permission-mode acceptEdits` auto-approved file writes and almost no command, so a stage could author any code it liked and could not run the commands that would check it. Anything not matched by an entry in `.claude/settings.json` was a hard denial, and an unattended session has nobody to ask. Two failures came out of that, both observed rather than predicted: implementation dispatched twice against a task whose first step was `npm install`, writing nothing either time, and design unable to sync its artifacts to the tracker because the upload is a `curl PUT` and `curl` was not on the list. Under `auto` each action is judged on what it is, so ordinary development work needs no entry at all.

  `jen init` now writes `.claude/settings.json` with an empty `allow` list. The file stays — it is what the run establishes trust for, and the seat a project's own rules take — but jen grants nothing on a project's behalf. An entry there is not a redundant grant under the new mode; it resolves _before_ the judgment is made, which is what makes the list worth emptying rather than trimming: the entries jen shipped included `Bash(gh:*)`, and that exempts the approving review and the merge at the end of the pipeline from any review at all.

  **Anyone who installed an earlier version keeps the entries jen wrote.** `jen update` never rewrites that file, so nothing removes them for you. Removing them is worth doing rather than optional: every one of those entries is a step-1 bypass for as long as it sits there, and `Bash(gh:*)` is the one that matters — it exempts the pipeline's own approving review and merge from any judgment at all. Do not assume the new mode has already neutralised them for you; treat each entry as live until you have deleted it.

  README §4 reverses with it. It told you to add your typecheck, lint, build and test commands and showed an example for anyone outside the ecosystem jen guessed at; it now says what a session may do and leaves the file to you.

## 0.4.0

### Minor Changes

- [#26](https://github.com/reveer-ai/jen/pull/26) [`279b626`](https://github.com/reveer-ai/jen/commit/279b626325577c4b544bcf40524d9e24f39a459c) Thanks [@joshtgi](https://github.com/joshtgi)! - Remove the scheduled git-host runner. jen ships one runner: `jen watch`.

  **Required action for anyone who installed an earlier version:** delete `.github/workflows/jen.yml` from your repository by hand. jen no longer writes or removes that path, so an installed copy keeps polling — and keeps billing a git-host runner for the whole life of every stage session it launches — until you delete it.

  The workflow held a paid runner for the entire life of every session, not just the poll: at roughly five stages of about fifteen minutes, one task cost around 75 runner-minutes of agent sessions billed as CI compute. It could also be disabled silently by the git host after 60 days of repository inactivity, which is indistinguishable from a pipeline with nothing to do.

  Anything that can invoke `jen run` on a schedule is still a runner, a scheduled git-host job included — jen simply ships no workflow file or template for one, so choosing that cost is explicit. `jen watch` is now called _the runner_, without the _local_ qualifier; the command name is unchanged. Write-time substitution is gone with the file that used it: nothing jen writes carries a value from `registry.yaml`, and the runner reads the tracker team and project from its checkout when it starts, refusing to start rather than polling an unbound project.

## 0.3.2

### Patch Changes

- [#24](https://github.com/reveer-ai/jen/pull/24) [`3de5c7c`](https://github.com/reveer-ai/jen/commit/3de5c7c938a83d0b1ab5bca444a2ccf1da85becc) Thanks [@joshtgi](https://github.com/joshtgi)! - Make the OpenSpec CLI reachable inside dispatched stage sessions.

  A stage session runs `claude` in a bare clone with no dependency install, so neither `openspec` (a dependency's bin, never linked by a global install of jen) nor `npx openspec` (which then reaches the registry) resolved — blocking every stage, on both runners. The run now writes an `openspec` shim into a per-run `bin/` prepended to the session `PATH` and into a sibling `node_modules/.bin/` that `npx`'s walk-up finds, invoking the same entrypoint jen resolves from its own dependency tree: no separate install, network fetch, or version pin.

## 0.3.1

### Patch Changes

- [#22](https://github.com/reveer-ai/jen/pull/22) [`f4e3206`](https://github.com/reveer-ai/jen/commit/f4e32068087e57fac23df314cc157d9d01bd9397) Thanks [@joshtgi](https://github.com/joshtgi)! - Launch dispatched Claude sessions with the supported `acceptEdits` permission mode.

## 0.3.0

### Minor Changes

- [#20](https://github.com/reveer-ai/jen/pull/20) [`b60251c`](https://github.com/reveer-ai/jen/commit/b60251caccb2f1d81bb8e09b570409e1aaeae7a1) Thanks [@joshtgi](https://github.com/joshtgi)! - Accept a Claude subscription token as model access, alongside an API key.

  A run reaches a model under either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` — the latter minted by `claude setup-token`, which requires a Claude subscription. The two are peers: neither is the default and neither is the fallback, and the choice is the adopter's. **Nothing changes for an adopter running on an API key today.**

  A runner holds exactly one. Setting both is refused before a session starts, naming both, rather than resolved by a precedence: one form bills a key and the other spends a usage window shared with the adopter's own interactive work, so choosing silently would be wrong in both directions and wrong invisibly. Setting neither is refused the same way it always was, except that the message now names both accepted forms. The session receives only the name its run holds; the other is removed from its environment.

  The managed workflow passes both secrets through, so `jen update` is what carries this to a scheduled runner. An unset secret expands to an empty value, which reads as absent — an adopter who never stores a token sees no difference.

  `README.md` states what choosing the subscription costs before an adopter chooses it: its usage limits are shared with their own interactive use of the same account, so a polling pipeline can exhaust a window they were about to work in — surfacing as a stage dying mid-run rather than as a bill, since jen can observe neither credential's limit. It also states that the token is long-lived and bound to the person who minted it, that its authority is inference-only by design, and that a managed installation's policy may refuse to mint one at all.

## 0.2.0

### Minor Changes

- [#11](https://github.com/reveer-ai/jen/pull/11) [`1280f80`](https://github.com/reveer-ai/jen/commit/1280f80eb8c22d81166bbbeed4d431cf03c2a280) Thanks [@joshtgi](https://github.com/joshtgi)! - Harden the stages for unattended runs.

  Every stage is now re-enterable: each one states what a killed run can leave behind, and treats a completion marker as a claim to check against the commits, the PR, and the threads rather than as proof. Every session ends with a comment on the task, which is what makes a finished run distinguishable from a crashed one.

  `design-task` no longer requires a user. It confirms before each artifact when confirmation is available and otherwise writes the set and lets the draft PR carry the confirmation, discovering which applies rather than reading a flag. It also stops advancing the task: design ends at `In Design`, and promoting to `In Progress` is the user's call, alongside `Todo` → `In Design`.

  `test-task` no longer blocks on a missing staging routine. Staging leaves the stage entirely and gets its own task; what remains is the full suite, the integration and e2e checks the project defines beyond unit scope, and the spec's scenarios worth confirming end to end.

  The churn ceiling leaves the skills for the dispatcher to enforce, replaced by reading the task's record on entry as context.

  The scaffold's `.claude/settings.json` now permits the standard check-script names alongside `git`, `gh`, and `openspec`, and the README states which permissions an adopter has to add themselves — an existing install has to be edited by hand, since jen never rewrites that file.

- [#14](https://github.com/reveer-ai/jen/pull/14) [`784ff5e`](https://github.com/reveer-ai/jen/commit/784ff5e9433f7e76021a9b351eb800869550b0de) Thanks [@joshtgi](https://github.com/joshtgi)! - `jen run` — one dispatch pass over the tracker, and the `Pending` status that makes it possible.

  The pipeline gains a status. Every stage now ends in one of exactly two ways: it hands the task to the next stage, or it parks it at `Pending` and says why. No stage finishes leaving a task in its own status, so a task found in a stage status is one a session is working or one a session died working — never one at rest. `design-task` ends at `Pending` rather than resting at `In Design`, and promotion to `In Progress` is still the user's. `Pending` has to exist on the tracker team before any of this works; binding reports it missing rather than creating it, and `jen run` refuses a team without it.

  Every session now announces itself on the task before it produces anything, carrying a `jen:run` marker that its closing comment counterparts. That pairing is what tells a dispatcher a task is being worked, since the status alone stays actionable right up until the stage moves it.

  `jen run` performs a single poll-map-gate-dispatch pass and exits. The loop belongs to whatever runner drives it, so a scheduled job and a long-running local process are both thin wrappers over the same entry point. It polls the tracker for issues sitting in a stage status, maps each to a skill and an identity role from a compiled table, declines anything a session has announced itself against or that would exceed the concurrency cap, prints a run request per dispatch to stdout as JSON, and writes its report to stderr — so `jen run | executor` works with no flag.

  The tick writes nothing: not to the tracker, not to the git host, not to the filesystem. It is safe to run at any time, twice, and before anything exists to consume what it emits. Its credential and its project identity both arrive from the environment or as flags and are never read from a file, and a run leaves nothing behind on the host.

  `init` and `update` are unchanged and stay filesystem-only.

- [#9](https://github.com/reveer-ai/jen/pull/9) [`44d99ef`](https://github.com/reveer-ai/jen/commit/44d99efc3791463b12a2634ec119a8f7504df3ed) Thanks [@joshtgi](https://github.com/joshtgi)! - Teach `setup-jen` to establish the identities the pipeline acts under, and document them in the `registry.yaml` stub. A pipeline that authenticates as the person who launched it cannot review its own work — GitHub refuses a review from a pull request's own author — so the review stage records advisory prose where a merge gate belongs.

  Binding now covers four identities: a GitHub App per role in your own organization — `design` for `design-task`, `dev` for `implement-task`, `deliver` for `review-task`, `test-task`, and `deliver-task` — and one Linear agent shared by all six stages. Each is registered by you, on the host, with the skill pre-filling what it can and then verifying what was actually granted rather than that something exists: an App created with no repository permissions installs cleanly and mints tokens that can do nothing, and nothing downstream reports it. Registration spanning two hosts and four browser visits is expected to take more than one sitting, so a half-registered project is a supported state — the run names exactly what is outstanding, leaves what exists alone, and completes the rest of the binding.

  `setup-jen` also checks that your default branch requires **at least one approving review** before a pull request may merge, which is what makes a review verdict load-bearing rather than advisory. Two settings that look like the obvious next tightening must stay off: requiring the approval to postdate the most recent push, and dismissing stale reviews on push. Either one makes the gate unsatisfiable by any pipeline role — delivery syncs the specs and archives the change before it merges, so the delivering role is the last pusher on every pull request it completes, and every task would park waiting on an approval nothing can give. The skill reads both, reports a branch carrying either as _not_ satisfying the gate, and never turns one on. It presents the exact change and applies it only if you agree; declining leaves the gate reported as outstanding.

  One approval from anyone with write access is the whole of what a branch can be asked for. The host's protections subtract actors from the eligible set — the author, and optionally the last pusher — and cannot name an approver, so **which** role approves and which merges is workflow convention rather than branch configuration: it is stated once in `AGENTS.md` and honoured by the stages, and nothing rejects a breach. This is the one place the change accepts less than it set out to. It is visible rather than silent — the roles are distinct identities, so the approving identity is on the pull request timeline — but the timeline is where you would have to look, and a reader who assumes the branch enforces it never would.

  No credential is written to `registry.yaml` or to any other file. The registry names identities; your environment supplies what authenticates them.

  Projects already on jen pick this up with `jen update`, and then a re-run of `setup-jen`. If you registered the applications under an earlier version, that re-run reports what the granted permissions are missing against the current table rather than assuming they are still right — worth doing, because a missing permission is silent until the first task that needs it.

- [#19](https://github.com/reveer-ai/jen/pull/19) [`4479725`](https://github.com/reveer-ai/jen/commit/4479725e304b42a73bf599b816804fa6ee3283aa) Thanks [@joshtgi](https://github.com/joshtgi)! - Scope what a stage session inherits from the runner.

  **What you set on the runner reaches your stages, and that is now the documented mechanism rather than a side effect of how a session is started.** A suite that connects to `DATABASE_URL` finds `DATABASE_URL`; an integration test that reads `API_BASE_URL` finds that. Inverting this into a list of the variables jen can name was considered and rejected: no such list is complete for an arbitrary toolchain, and every name left out of one surfaces as a stage failing at the first command that needed it — mid-run, with nobody watching, presenting as a broken stage rather than as a list jen got wrong.

  **jen's own `JEN_*` namespace is withheld from every session, and the strip has widened to cover all of it** rather than the role credentials alone. jen defines that namespace, so withholding it by prefix is exhaustive rather than a guess at what a name might mean. The requirement that a run hold exactly one role's credentials and that a session be unable to obtain another's is unchanged — this is the category around it that the spec had never named.

  **A variable can now be narrowed to a single stage.** `JEN_ENV_TEST_TASK=STAGING_SSH_KEY,SMOKE_TARGET` gives those two variables to `test-task` and to no other stage. The value is a list of variable _names_, not values, so your secret stays written down in one place and reaches your commands under its own name. The narrowing keys on the **stage**, not the role — reviewing, testing, and delivering all act under the one `deliver` role, so nothing about the roles keeps testing's variable from the stage that merges, and keying on the role would hand it over. Declare nothing and nothing changes: an unnamed variable reaches every stage.

  **A declaration that scoped nothing is reported and does not fail the run.** A misspelt stage name, or a variable the runner never held, leaves every stage holding exactly what it would have held anyway — so the run says what it found, in the record and in the readable report, and carries on. Run records gained a field for this that is always present and may be empty, and it names a variable rather than carrying its value. Failing an unattended pipeline over a typo that changed nothing would be the worse trade.

  **This is the local runner's today.** `jen watch` reads the environment of the shell you started it in. The scheduled runner cannot carry your variables at all — Actions secrets are not ambient and `jen run` is handed a closed list of names in the managed `.github/workflows/jen.yml` — so a secret you store as `DATABASE_URL` was never on that runner to withhold. Giving the scheduled runner a way to carry your own configuration is its own piece of work, and nothing here changes when it lands.

- [#16](https://github.com/reveer-ai/jen/pull/16) [`b87553e`](https://github.com/reveer-ai/jen/commit/b87553eaa30ab68f4efe814fafe9e589b344b00c) Thanks [@joshtgi](https://github.com/joshtgi)! - The runners: what drives the tick on a schedule, and what a person reads afterwards.

  jen ships two runners, and neither is the fallback. A **scheduled GitHub Actions workflow** now lands in every project at `.github/workflows/jen.yml` — the first managed file jen writes outside `.claude/` and the repository root, declared as that one path rather than by claiming the directory. It polls every 30 minutes, queues rather than overlaps a tick already running, bounds its job at two hours, and **never checks the repository out**: everything the deciding pass needs arrives as environment or is compiled into the published CLI, so a poll costs the same on a repository of any size. The only clone in the pipeline is still the one a stage session makes for itself.

  **`jen watch`** is the other, and a peer rather than a lesser option: the same tick, on an interval, in a process you own. It reads the tracker team and project from the checkout it was pointed at — `--team` and `--project` override, `--interval` sets the pace, and every `jen run` flag works here too. It holds no lock file, no ledger, and no memory of what it launched, so a restart re-establishes everything from the tracker and two instances behave exactly as two runners do. Choosing it does not remove the git host from the pipeline: pull requests, review verdicts, and the merge gate are the same under both, and so are the identities they depend on.

  **Managed files can now carry values from the registry.** A closed set of names — the tracker team and project — resolved from `registry.yaml` when the file is written, with no template language behind it. A value that does not resolve is written empty and never as its placeholder, because a placeholder surviving into a workflow is a wrong project name that reads as a configured one; `init` and `update` name every value that did not resolve and why. Binding now finishes by refreshing them, so a project that has just been bound has a runner that polls it.

  **The pipeline gains a halt, and it is the tracker's own project status.** Move the project to a status named `On Pause` and dispatch stops: the tick reads the status before it polls, reports it, and launches nothing. That status is one you create — the Linear tools `setup-jen` works through can neither list a workspace's project statuses nor add one — under the **In Progress** category, where it describes the project truthfully rather than marking a live project cancelled to make a category match. It is matched by name for that reason, which is also what it costs: rename it and the halt stops working with no other symptom, so the README and `setup-jen` both say so. A project the tracker considers completed or cancelled halts too, matched on the category rather than on any name. It needs no schedule deleted, no runner stopped, and no task's status edited, it reads identically under both runners, and un-pausing resumes with nothing restarted. Resolving that status also closes a hole — the tick previously filtered issues by project _name_ and never resolved the project, so two projects sharing a name would have merged into one poll. It now refuses on the ambiguity.

  **Every finished dispatch is reported as a run record**: one JSON line on stdout naming the task, stage, role, outcome, cost, session id, whether it was stopped, and where its transcript went. Run requests and run records share the stream and each says which it is, so `jen run | recorder` still works with no flag. The readable report on stderr carries each run's cost beside its outcome, and distinguishes a session that reported none from one that reported zero. A session's transcript is discarded with the run unless `--transcripts <dir>` names somewhere to keep it — it is the session's entire stream, and a durable copy of that is the operator's decision rather than jen's default.

## 0.1.0

### Minor Changes

- [`bcb529d`](https://github.com/reveer-ai/jen/commit/bcb529ded69c712d4c4f53119a0a711d9b73c941) Thanks [@joshtgi](https://github.com/joshtgi)! - Publish jen under Apache-2.0 and document adopting it. `package.json` declared `UNLICENSED` — no rights granted, of a package anyone could already install — and now declares `Apache-2.0`, with the license text shipped in the tarball. `keywords` makes the package findable by something other than its exact name.

  `README.md` is now the adopter's document rather than jen's build notes, which is what the registry has been publishing as the package's front page all along. It leads with the ownership boundary, because the cost of learning it late is a lost edit: root `AGENTS.md` and the shipped skills are jen's and are replaced wholesale on every update, `registry.yaml` and `.claude/settings.json` are written once and then yours, and everything else jen never touches. It spells out what the ownership stamp actually governs — deletion, not overwriting, so removing it from a skill jen still ships does not keep your edit — then walks the path from `npm i -D @reveer/jen` through `jen init`, binding with the `setup-jen` skill, and `jen update`. Contributor material moved to `CONTRIBUTING.md`.

  Root `AGENTS.md` and the `registry.yaml` stub both described a project as a _fork_ of jen. Installing replaced forking, so both now state the installed model: jen owns the repository root, and the project's own sources are tracked under `src/` in that same repository. Both files are shipped payload, so `jen update` replaces them with the corrected text.

- [`bcb529d`](https://github.com/reveer-ai/jen/commit/bcb529ded69c712d4c4f53119a0a711d9b73c941) Thanks [@joshtgi](https://github.com/joshtgi)! - Release the package from GitHub Actions with no stored credential. A changeset on a merged pull request opens a Version Packages pull request; merging that publishes to npm, authenticating by trusted publishing rather than a token, and records the release as a git tag and a GitHub Release.

- [`bcb529d`](https://github.com/reveer-ai/jen/commit/bcb529ded69c712d4c4f53119a0a711d9b73c941) Thanks [@joshtgi](https://github.com/joshtgi)! - Ship a `setup-jen` skill, installed into `.claude/skills/` alongside the six stage skills. It is the step between `jen init` and a pipeline that can run: it confirms which Linear team and project the repository's work is tracked in, checks the team for the eight statuses the stages move tasks through, creates the `epic` and `task` labels if they are missing, and fills in the `registry.yaml` stub `init` left behind.

  Run it once after `jen init`. It is safe to run again — it reports what is already correct rather than redoing it, so a run that ends with a status still to add in Linear is resumed by running it again once you have added it. It verifies statuses and never creates, renames, or maps one; a missing status is reported by name for you to add.

  Projects already on jen pick it up with `jen update`.
