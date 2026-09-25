## 1. Foundation

- [ ] 1.1 Create `agent/git/index.ts` with `GitBackendError` and a `StaleRefError` subclass carrying the branch's actual sha. Add the exported result types (`MergeResult` = `merged` | `conflict` | `up-to-date`, tree entry, bundle tip) and the attribution type (name, email, date).
- [ ] 1.2 Implement the internal `run(args, options)` helper. It spawns `git` with no shell, uses a from-scratch environment (`PATH`, `HOME`=root, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`), and always passes `-c core.hooksPath=/dev/null`. It puts `error` listeners on the child and on every pipe, drains stdout (Buffer) and stderr fully, and resolves `{ code, stdout, stderr }`. The caller decides which codes are outcomes.
- [ ] 1.3 Implement validation: project id against `^[a-z0-9][a-z0-9-]{0,62}$`; branch name via `git check-ref-format --branch`, plus no leading `-`; a revision is a valid branch or a full-length hex id. Invalid input throws before any git or filesystem call.
- [ ] 1.4 Implement the async factory `GitBackend.open(root, { git? })`. It runs `git version`, parses the version, refuses anything below 2.38 with an error naming the requirement, and rejects (without crashing) when `git` can't be spawned.

## 2. Repositories and branches

- [ ] 2.1 `create(project)`: `git init --bare -b main` into a temp dir under the root, then rename into `<root>/<project>.git`, refusing if the target exists. Remove the temp dir on failure.
- [ ] 2.2 `archive(project)`: rename into `<root>/.archive/<project>-<UTC timestamp>.git`, creating `.archive/` if needed. Fail if the project doesn't exist.
- [ ] 2.3 `listBranches(project)` via `for-each-ref refs/heads/` → `{ name, sha }[]`.
- [ ] 2.4 `createBranch`, `moveBranch`, and `deleteBranch` via `update-ref` with the old value (empty for create). Check that the new value is an existing commit. Map git's "is at X but expected Y" failure to `StaleRefError` carrying X (or its absence), and put `--end-of-options` in the right position on each command.

## 3. Transfer

- [ ] 3.1 `bundle(project, branch, path, { basis? })` via `git bundle create <path> <branch> ^<basis>…`. Surface git's empty-bundle refusal as a distinguishable error.
- [ ] 3.2 `importBundle(project, path)`: `bundle list-heads` for the tips, then `git -c transfer.fsckObjects=true fetch --no-tags --no-write-fetch-head <path> <heads…>`. Return the tips, and write no ref.

## 4. Merge and reads

- [ ] 4.1 `merge(project, source, target, { author, committer, message })`: resolve both tips; return `up-to-date` if the source is an ancestor of the target (`merge-base --is-ancestor`). Otherwise run `merge-tree --write-tree -z --name-only`: exit 1 parses into `conflict { paths, messages }`, and exit 0 is followed by `commit-tree -p target -p source` with `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, then a compare-and-swap `update-ref` against the tip that was read.
- [ ] 4.2 `diff(project, from, to)` with `--no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/`. Return the full string. An oversized output is an error, never truncated.
- [ ] 4.3 `tree(project, rev, dir?)` via `ls-tree -z` over one level, returning `null` for a missing directory. `blob(project, rev, path)` returns a Buffer after a `cat-file -e` existence check, and `null` when absent.

## 5. Tests (`agent/git/index.test.ts`, real repositories in a temp dir)

- [ ] 5.1 Validation and construction: bad project ids and option-shaped names are refused with nothing touched; an old git version is refused (use an injected `git` stub script printing `git version 2.37.0`); an unspawnable `git` rejects cleanly.
- [ ] 5.2 Repository lifecycle: create is empty with `HEAD` → main; a second create is refused and leaves the repo intact; archive moves it with branches intact; one project's commit is absent from another project's repo.
- [ ] 5.3 Branch compare-and-swap: create, move, delete; stale-expectation failures report the actual value and change nothing; a non-fast-forward move succeeds; a move to a missing sha is refused.
- [ ] 5.4 Transfer: a full bundle round-trips into a fresh clone; an incremental bundle carries its prerequisite and imports; import leaves `listBranches` unchanged; a bundle with a malformed commit (built with `hash-object --literally`) is refused and unreadable; missing prerequisites are refused.
- [ ] 5.5 Merge: a clean merge has exact parents and attribution; a fast-forwardable merge still produces a two-parent commit; a conflict reports its paths and moves nothing; a repeat merge is `up-to-date`; a target moved between the read and the update yields `StaleRefError` (inject the race through the `run` seam or a hook-free concurrent `update-ref`).
- [ ] 5.6 Reads: diff headers and lines; one-level tree; non-UTF-8 blob bytes preserved; missing paths are `null`.
- [ ] 5.7 Insulation: with the supervisor's own env pointing `GIT_CONFIG_GLOBAL` at a file setting `diff.noprefix=true` and a marker-writing `core.hooksPath`, the diff keeps its prefixes and no marker appears; a branch whose `.gitattributes` names an undefined merge driver/textconv merges and diffs without running anything.

## 6. Notes and verification

- [ ] 6.1 Write `agent/git/AGENTS.md`: the hosting decision and the forge comparison; the insulation rules; `fetch` over `unbundle` and why (fsck is ignored by `unbundle`, as probed); `--end-of-options` must follow every real option; always a merge commit; no deletion.
- [ ] 6.2 Run `npm install --prefix agent`, `npx tsc -p agent/tsconfig.json`, and `npx vitest run --config agent/vitest.config.ts agent/git`, then the full substrate suite, including `boundary.test.ts`. Report which suites couldn't run for lack of a container runtime rather than implying they passed.
