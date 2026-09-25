## Context

ENG-200 replaces the forge rather than git. The forge is the layer a host sells on top of git: the canonical repo, the change object, the review record, and the gate. That layer is where the unautomatable configuration lived. This change builds the bottom of the replacement: where a managed project's repository lives, and the operations jen performs on it. ENG-202 routes `git_fetch`/`git_push` through it. ENG-204 diffs, snapshots, and merges through it.

What the substrate already fixes:

- **The supervisor is the only process with authority outside a sandbox.** Agents run in containers with a per-agent workspace volume, and hold `exec`. A commit in a workspace is inert until the supervisor publishes it. There is no commit capability, and the one commit jen makes itself is the merge.
- **Neither routed git capability takes a repo or ref argument** (ENG-202). The supervisor resolves both. So the backend's callers are always supervisor code, never an agent's arguments passed through verbatim. Arguments are still validated: they come from records, and `agent/AGENTS.md` records three places where record fields taken literally became instructions.
- **The sandbox's channel is text.** `Input.send(text)` and line-delimited output. Moving binary data into or out of a workspace is ENG-202's to solve (base64 over the channel is the obvious candidate). This backend's job is to produce and consume a self-contained transfer form, whatever carries it.
- `agent/` sits outside CI, and its tests run by hand.
- Host git on the development machine is 2.54.

## Goals / Non-Goals

**Goals:**

- Decide the hosting model on the ticket's criteria, and record it beside the code.
- A `GitBackend` covering: repository create and archive, branch list, and create/move/delete, bundle out and bundle in, diff, attributed merge with conflicts reported, and tree and blob reads.
- Every operation is safe against a concurrent caller, and against hostile repository contents and host configuration.

**Non-Goals:**

- Carrying bundles across the sandbox boundary, the store root, and the project ↔ repository binding (ENG-202).
- Review rounds, snapshots, and the gate (ENG-204). The backend offers `diff`, and freezing its output is ENG-204's.
- Importing an existing repository or seeding a new one (ENG-209). `create` makes an empty repository.
- Tags, notes, and any ref outside `refs/heads/`. Nothing in the epic needs them.
- Maintenance: gc scheduling, repacking, and backup automation.
- Rendering non-text diffs.

## Decisions

### 1. Bare repositories on disk, operated by a local `git` subprocess. No server.

Weighed against an embedded Gitea/Forgejo, on the ticket's criteria:

| Criterion | Bare repos + supervisor | Embedded Gitea/Forgejo |
|---|---|---|
| Isolation | One directory per project with its own object store. Agents can't address a repo at all. The supervisor resolves it. | Per-repo permissions enforced by the forge's own user/token model, a second authority to keep in agreement with the supervisor's. |
| Scale | Per-repo overhead is one directory, with no process and no database row. Backup is copying a directory or `git bundle --all`. | A server process, a database, and per-repo rows. Backup has to cover the database and the repos together, consistently. |
| Fit with `git_fetch`/`git_push` | The supervisor produces and consumes bundles in-process. The agent never holds a URL or a credential. | The agent would have to reach the server over the network with a token, which contradicts the capability model. Otherwise the supervisor proxies every request, and the server does nothing the backend couldn't. |
| Operational surface | `git` on the host. | A server to run, upgrade, secure, and monitor, with its own auth and its own CVEs. |

What a forge adds on top is exactly what ENG-200 is replacing: PRs, review, branch protection, and a web UI. Adopting one would bring that layer back as a dependency to route around. The only thing given up is a ready-made browsing UI, and ENG-205 defers the human surface to jen's own UI anyway.

**Why a subprocess and not a library** (isomorphic-git, nodegit): the substrate carries one npm dependency, and adding one for git would mean trusting a reimplementation's merge and pack handling over git's own. `merge-tree`, `fsck`, and the bundle format are exactly where a reimplementation diverges. The subprocess costs a process per operation, which is negligible next to a model turn.

### 2. Layout: `<root>/<project>.git`, with archive as a rename into `<root>/.archive/`

The backend is constructed with a root directory. Where that root lives is ENG-202's decision. A project id must match `^[a-z0-9][a-z0-9-]{0,62}$`. That makes it a single path segment, it can't be `.` or `..` or `.archive`, and it can't start with `-`. So nothing a record carries can escape the root or be read as an option.

- **No shared object store and no alternates, ever.** Git lets anyone who can name an object read it by id. A shared store would make one project's objects fetchable from another by sha, which is the isolation leak this layout exists to prevent.
- **`create` is atomic.** It runs `git init --bare -b main` into a temp directory under the root, then renames it into place, refusing if the target exists. A crash leaves a stray temp directory, never a half-initialised repository at a real project's path. HEAD points to `refs/heads/main`, which has no commit yet.
- **`archive` is a rename, never a delete.** It goes to `<root>/.archive/<project>-<UTC timestamp>.git`. Rename is atomic on one filesystem, and archiving is reversible by hand. Deleting a project's history is a decision for a person with a shell, not an API call.

### 3. Every invocation is insulated from the host and from the repository's contents

Repository contents are written by agents, and the host belongs to whoever runs jen. Neither may change what an operation does. Every call runs `git` with:

- `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`. A user's `diff.noprefix`, `merge.conflictStyle`, aliases, or `core.pager` would otherwise change output that ENG-204 anchors comments to.
- `-c core.hooksPath=/dev/null`. `init` writes sample hooks, and nothing here should ever run one.
- An environment built from scratch, not inherited: `PATH`, `HOME` set to the root, `GIT_TERMINAL_PROMPT=0`, and `LC_ALL=C`. Inheriting would pass through `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, and the rest.
- For diff: `--no-ext-diff --no-textconv --no-color`, and explicit `--src-prefix`/`--dst-prefix` values.

**Attributes in the tree are harmless under this config.** A `.gitattributes` can name a merge driver or a textconv, but a driver only runs if it is defined in config, and the config is ours alone.

**Revisions and names never reach an option position.** Branch names are checked with `git check-ref-format --branch` and must not start with `-`. Revisions are either a branch name or a full-length hex object id. Every command that takes one puts `--end-of-options` before its operands. Probed: that flag must come after all real options, which is a detail the implementation has to get right on each command.

### 4. Branches only, and every write is compare-and-swap

The API speaks branch names (`task/eng-42`) and maps them to `refs/heads/<name>` itself. Callers never pass a full ref.

- `createBranch(name, sha)`, `moveBranch(name, sha, expected)`, and `deleteBranch(name, expected)` all go through `git update-ref <ref> <new> <old>`. Create passes the empty old value, so it fails if the branch exists. Git takes a lock and checks the old value under it. Probed: a stale expected value fails with `cannot lock ref … is at X but expected Y` and exits 128. The backend reports that as a distinguishable `StaleRef` error carrying the actual value, so ENG-202 can tell a push that lost a race from a push that failed.
- **A push is: import the bundle (§5), then `moveBranch`.** Fast-forward or not is the caller's policy. The backend moves exactly what it is told, provided the expected value holds, and checks that the new value is a commit that exists.
- `listBranches()` returns `{ name, sha }[]` from `for-each-ref refs/heads/`.

### 5. Transfer is a git bundle, imported through `fetch` so that it is fsck-checked

A bundle is a single file holding a pack and the refs it carries. It can be incremental (it names prerequisite commits the receiver must already have), and it needs no connection, URL, or credential. That is exactly the shape of "fill a workspace from the repo, take a ref back out" when the carrier is a text channel owned by ENG-202.

- **Out:** `bundle(branch, path, { basis?: sha[] })` writes a bundle of the branch to a path the caller supplies, excluding everything reachable from `basis` so that a refill after the first fetch is small. Git refuses to create an empty bundle, and that surfaces as an error the caller can read as "already up to date".
- **In:** `importBundle(path) → { tips: { ref, sha }[] }` reads the bundle's heads, then brings its objects in with `git -c transfer.fsckObjects=true fetch --no-tags --no-write-fetch-head <path> <each head>`. **Not `git bundle unbundle`.** Probed on 2.54: `unbundle` ignores `transfer.fsckObjects` and accepted a commit with a malformed author line. `fetch` rejected the same bundle (`index-pack died`, exit 1). `fetch` also checks prerequisites (a bundle whose basis the repo lacks fails and writes nothing), and with no destination refspec and no FETCH_HEAD it touches no ref. The objects sit unreferenced until the caller's `moveBranch`, well inside gc's two-week prune grace.
- Import doesn't decide which tip becomes which branch. It reports what it received, and the caller (ENG-202) moves its task's branch to the tip it expects. So the "no ref argument" guarantee stays in the supervisor's resolution, not in a bundle's self-description.

### 6. Merge without a working tree: `merge-tree --write-tree`, `commit-tree`, compare-and-swap

`merge(source, target, { author, committer, message })`:

1. Resolve both branches to shas. If the source is already reachable from the target, return `{ kind: 'up-to-date' }`.
2. Run `git merge-tree --write-tree -z --name-only <target> <source>`. Probed: exit 0 prints the merged tree. Exit 1 prints the tree, the NUL-separated conflicted paths, an empty field, then the informational messages. Any other exit is an error.
3. On conflict, return `{ kind: 'conflict', paths, messages }`. The repository is unchanged, since the tree written is unreferenced, and nothing is resolved. A conflict is a result, not an exception, because it is an expected outcome ENG-204 reports back to an agent.
4. On success, run `commit-tree <tree> -p <target> -p <source>` with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set from the call (name, email, and a date, so tests are deterministic), then `update-ref` the target from the sha read in step 1. A target that moved meanwhile is `StaleRef`, and the merge commit is left unreferenced.

**Always a merge commit, never a fast-forward.** A fast-forward would put no jen-attributed commit on the target, and "who landed this" becomes unrecoverable from history. That is the one commit jen makes, and it is the record of the gate having passed.

**Requires git ≥ 2.38**, the release that added `--write-tree`. The constructor runs `git version`, parses it, and refuses an older git with an error naming the requirement. That is better than failing on the first merge in production.

### 7. Diff, tree, and blob are plain reads

- `diff(from, to) → string` runs `git diff --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ --end-of-options <from> <to>`. It is two-point by design: ENG-204 records a base sha per round and passes it. Output is returned whole. A diff too large to hold is an error, never a silently truncated string, because a truncated snapshot is a false review record.
- `tree(rev, dir?) → { mode, type, sha, name }[]` runs `ls-tree -z` over one directory level. A missing path returns `null`.
- `blob(rev, path) → Buffer | null` runs `cat-file blob <rev>:<path>`. Existence is checked first with `cat-file -e`, whose non-zero exit means only absence, so that "not there" and "git failed" are never the same answer. This is the `volume ls` lesson from `agent/AGENTS.md`, applied here.

### 8. One subprocess helper, following the substrate's pipe rules

All operations go through one internal `run(args, { input?, env? })`. It spawns `git` with no shell, listens for `error` on the child and on every pipe, reads stdout and stderr to the end, and resolves `{ code, stdout: Buffer, stderr }`. Callers decide which exit codes are outcomes (merge-tree's 1, `cat-file -e`'s 1) and which are failures. A failure becomes `GitBackendError` carrying the argv (never an environment) and the stderr tail. This is the `agent/AGENTS.md` rule that every pipe needs an `error` listener, applied again rather than rediscovered.

### 9. It lives at `agent/git/`, beside `agent/sandbox/`

It is a supervisor-only primitive, like the sandbox driver. It isn't part of the supervisor's state machine, and `supervisor/AGENTS.md` asks for the supervisor to be kept as small as possible. `agent/git/AGENTS.md` carries the decision record (§1), the insulation rules (§3), and the unbundle-vs-fetch finding (§5). Those are the things a future session would otherwise relearn.

## Risks / Trade-offs

- **[Unreferenced objects between import and move, or from a lost merge race]** → Harmless. They are unreachable, invisible to every read, and collected by gc after its prune grace. No cleanup is written.
- **[No repository maintenance]** → Loose objects accumulate with every push. At the epic's scale that is fine. `git gc`/`git maintenance` is a later, separate operation, and nothing here prevents it.
- **[Same OS user for all repositories]** → Isolation is enforced by the supervisor never handing an agent a path, not by filesystem permissions. The trust boundary is the same one the sandbox already relies on: nothing outside a container is reachable from inside it.
- **[Large diffs held in memory]** → Acceptable for review-sized changes. If it bites, `diff` can grow a streaming variant without changing its callers' semantics.
- **[git version drift on the host]** → The constructor's version check turns an old git into an immediate, named failure. Newer gits have kept `merge-tree -z --name-only` output stable since 2.38.
- **[Bundle path supplied by the caller]** → The backend reads and writes only the path it is given. That path is the supervisor's own temp file, never agent-named.

## Migration Plan

None. This is a new module with no callers until ENG-202, and there is no data to migrate.

## Open Questions

None blocking. The store root, and how a bundle rides the sandbox channel, are ENG-202's by design, not open here.
