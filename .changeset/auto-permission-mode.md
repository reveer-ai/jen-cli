---
"@reveer/jen": minor
---

Stage sessions launch under `auto` permission mode, and the scaffold grants nothing.

**Required action: Claude Code 2.1.259 or later on the machine that runs the pipeline.** The invocation now carries `--permission-prompts none`, which an older CLI rejects as an unknown option — and an unknown option is refused before the session starts, so it presents as a stage that was dispatched and produced nothing rather than as a version problem. Check with `claude --version` on the runner's host, not on yours.

`--permission-mode acceptEdits` auto-approved file writes and almost no command, so a stage could author any code it liked and could not run the commands that would check it. Anything not matched by an entry in `.claude/settings.json` was a hard denial, and an unattended session has nobody to ask. Two failures came out of that, both observed rather than predicted: implementation dispatched twice against a task whose first step was `npm install`, writing nothing either time, and design unable to sync its artifacts to the tracker because the upload is a `curl PUT` and `curl` was not on the list. Under `auto` each action is judged on what it is, so ordinary development work needs no entry at all.

`jen init` now writes `.claude/settings.json` with an empty `allow` list. The file stays — it is what the run establishes trust for, and the seat a project's own rules take — but jen grants nothing on a project's behalf. An entry there is not a redundant grant under the new mode; it resolves *before* the judgment is made, which is what makes the list worth emptying rather than trimming: the entries jen shipped included `Bash(gh:*)`, and that exempts the approving review and the merge at the end of the pipeline from any review at all.

**Anyone who installed an earlier version keeps the entries jen wrote.** `jen update` never rewrites that file, so nothing removes them for you. Removing them is worth doing rather than optional: every one of those entries is a step-1 bypass for as long as it sits there, and `Bash(gh:*)` is the one that matters — it exempts the pipeline's own approving review and merge from any judgment at all. Do not assume the new mode has already neutralised them for you; treat each entry as live until you have deleted it.

README §4 reverses with it. It told you to add your typecheck, lint, build and test commands and showed an example for anyone outside the ecosystem jen guessed at; it now says what a session may do and leaves the file to you.
