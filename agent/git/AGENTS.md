# The repository backend

Where a managed project's repository lives, and every operation jen performs on it. The
supervisor is the only caller. `cli/` does not import this, and this does not import `cli/`.
jen's own repository is not one of these: it stays on GitHub.

## The decision: bare repositories on disk, operated by a local `git`, and no server

Each project is `<root>/<project>.git`, a bare repository. Every operation is a `git`
subprocess started by the supervisor. There is no git server process, no forge, and no git
library. An embedded Gitea/Forgejo was weighed against this and rejected on all four of
ENG-201's criteria:

| Criterion | Bare repos + supervisor | Embedded Gitea/Forgejo |
|---|---|---|
| Isolation | One directory per project with its own object store. An agent cannot name a repository at all, because the supervisor resolves which one. | Per-repo permissions enforced by the forge's own user and token model, which is a second authority to keep in agreement with the supervisor. |
| Scale | Per-repo overhead is one directory: no process, no database row. Backup is copying a directory, or `git bundle --all`. | A server, a database, and rows per repository. Backup has to capture the database and the repositories consistently. |
| Fit with `git_fetch` / `git_push` | The supervisor produces and consumes bundles in-process. The agent never holds a URL or a credential. | Either the agent reaches the server over the network with a token, which contradicts the capability model, or the supervisor proxies everything and the server does nothing this couldn't. |
| Operational surface | `git` on the host. | A server to run, upgrade, secure and monitor, with its own auth and its own CVEs. |

What a forge adds beyond that is pull requests, review, branch protection and a web UI. That
is exactly the layer ENG-200 is replacing, so adopting one would bring it back as a
dependency to route around.

**No git library either.** isomorphic-git and nodegit would each be a reimplementation of
exactly the parts where reimplementations diverge: merge, pack handling, fsck and the
bundle format. A subprocess costs a process per operation, which is nothing next to a
model turn.

**Nothing is shared between repositories: no alternates, no common object store.** Git
lets anyone who can name an object read it by id. A shared store would make one project's
objects fetchable from another's by sha, and that leak is what one-directory-per-project
exists to prevent.

**Nothing is ever deleted.** `archive` renames a repository into `<root>/.archive/`.
Removing a project's history is for a person with a shell.

## Insulation: neither the host nor the repository's contents may change what an operation does

The host belongs to whoever runs jen, and the repository's contents were written by agents.
Every call is insulated from both:

- **The environment is built, never inherited.** It contains `PATH`, `HOME` set to the
  root, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
  and `LC_ALL=C`. Inheriting would pass through `GIT_DIR`, `GIT_EXTERNAL_DIFF`, and a
  user's `diff.noprefix`, which changes the diff output ENG-204 anchors comments to. The
  insulation test sets all three in the supervisor's environment.
- **`-c core.hooksPath=/dev/null` on every call.** Global config is already gone, so this
  holds against a hook that lands in the repository's own `hooks/`. `update-ref` runs
  `reference-transaction`, so a hook would otherwise run on every branch write. The
  repository is also created with `--template=`, so it starts with no sample hooks.
- **`gc.auto=0` and `maintenance.auto=false`.** A fetch would otherwise start a detached
  gc that prunes a repository some other call is still using.
- **Attributes are read from the empty tree, pinned per call, and never from the
  repository's contents.** "A driver runs only if config defines it" is not a defence:
  built-in values need no config. `merge=union` concatenates both sides of a conflict and
  reports it clean, and `-diff` turns a file's changes into `Binary files differ`. An
  agent's `.gitattributes` merged once would resolve every later conflict at the gate and
  blank out the review record. That a bare repository reads no in-tree attributes is only
  git's default. 2.46.0 read `HEAD`'s, and `attr.tree` in a repository's own config turns
  it on. So every call against a repository passes `--attr-source=<empty tree>`, which
  outranks both. The empty tree's id depends on the repository's hash, so `hash-object`
  names it, once per repository path; `archive` forgets it, since the path can be created
  again. The system
  attributes file (`GIT_ATTR_NOSYSTEM=1`) and the home one (`core.attributesFile=/dev/null`)
  are off as well. Diff also passes `--no-ext-diff --no-textconv`. The attribute tests set
  `attr.tree` in the repository's config **on purpose**, and each has a control showing
  plain git merging clean and hiding the diff.

## Names never reach an option position

- **Validation comes before any filesystem or git call.** The synchronous checks (project
  id, object id, path) run before the one that runs git (branch name). The test watches a
  logging wrapper and asserts that an invalid name produced no git call at all.
- **A project id is `^[a-z0-9][a-z0-9-]{0,62}$`.** It is one path segment, and it can't be
  `.`, `..`, or `.archive`, or start with `-`.
- **Branch names go through `git check-ref-format --branch`, and git has to print them back
  unchanged.** `--branch` expands `@{-1}` rather than refusing it, so the round trip is what
  catches an expansion. A bare `@` passes through untouched and is refused by name, because
  every other command reads it as `HEAD`.
- **git is always handed `refs/heads/<name>` or a full object id, never a short name.**
  Branch tips are resolved by listing `refs/heads/` and matching exactly. `rev-parse`
  guesses (`refs/heads/x` is also tried as `refs/tags/refs/heads/x`), and a `for-each-ref`
  pattern matches by prefix (`refs/heads/task` lists `task/a`). Revisions are resolved to
  shas before they reach `diff`, `merge-tree` or `ls-tree`.
- **`--end-of-options` has to come after every real option.** git stops parsing options
  there, so a flag placed after it is read as an operand. Check the placement on each new
  command. `bundle create` takes its output path *before* the marker, which is why that
  path has to be absolute.

## Transfer: `fetch`, never `bundle unbundle`

A push is `importBundle` followed by a compare-and-swap `moveBranch`. Import runs `git -c
transfer.fsckObjects=true fetch --no-tags --no-write-fetch-head <bundle> <sha>…`.

- **`unbundle` ignores `transfer.fsckObjects`.** It stored a commit with a malformed author
  line that `fetch` refuses (`missingEmail … index-pack died`). This was probed on 2.54, and
  the malformed-bundle test fails if `unbundle` is swapped back in.
- **`fetch` honours it only from git 2.46, and that is the floor.** Before 2.46 a fetch
  from a bundle ignores `transfer.fsckObjects` too. Reproduced with plain git: on 2.45.3
  the fetch exits 0 and `cat-file -t` finds the malformed commit stored; on 2.46.0 it is
  refused with `missingEmail`. The malformed-bundle test fails on every git from 2.38.5 to
  2.45.3. `open` refuses anything older than 2.46, and that one floor also covers
  `merge-tree --write-tree` (2.38) and `--attr-source` (2.40), so nothing here is
  version-gated. The cost is Apple's and Debian bookworm's git 2.39.
- **Tips are fetched by sha, not by the names the bundle gives them.** A bundle's header is
  text an agent's workspace wrote, and a refspec is a syntax: a "ref" named
  `+refs/heads/main:refs/heads/owned` would be an instruction. The names are returned as
  data, and which tip becomes which branch is the caller's decision.
- A fetch with no destination refspec and no `FETCH_HEAD` writes no ref. Imported objects
  stay unreferenced until the caller's `moveBranch`, well inside gc's prune grace.

## Absence is not failure: `cat-file --batch-check`, not `cat-file -e`

`cat-file -e <rev>:<path>` exits **128** for a missing path, the same code a corrupt
repository produces. Design §7 named it as the absence check, and probing showed it can't
be one. Lookups go through `cat-file --batch-check` instead, which exits zero either way
and prints `<expr> missing`. So a non-zero exit means only that git failed. This is the
same shape as `volume ls` in `agent/AGENTS.md`, for the same reason.

`tree` and `blob` return `null` for an absent repository, revision or path, and for a path
that names the wrong kind of object. `diff` has no way to say "absent" that couldn't be
read as "no changes", so an absent revision is an error there.

## Merge: always a merge commit

`merge-tree --write-tree` builds the merged tree, `commit-tree` makes the commit with the
given author and committer, and `update-ref` moves the target, compare-and-swap against the
tip it merged. **A fast-forward is never performed.** A merge commit is the one commit jen
makes, and it records who passed the gate. A conflict is returned as a result with the
paths and git's messages, and nothing is resolved. `merge-tree --write-tree` needs
git 2.38, which the 2.46 floor already covers.

## Output is whole or an error

Every call's output is capped (64 MiB by default, `outputLimit` in tests). Going over the
cap is an error, never a truncation. A truncated diff would be a false review record, and
a truncated blob would be a file nobody committed. `diff` decodes as UTF-8, so a non-UTF-8
text file's lines lose bytes in the diff. `blob` is the exact-bytes path.
