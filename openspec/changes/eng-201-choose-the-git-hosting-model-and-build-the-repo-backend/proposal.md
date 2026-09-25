## Why

ENG-200 moves managed projects onto a git backend jen hosts itself. Every later task in that epic drives one: ENG-202 pushes and fetches through it, and ENG-204 diffs and merges through it. None of them can start until two things exist: a decision on how jen stores and operates a project's repository, and the code that does it. This change settles the hosting model and builds that backend. It adds no agents, no capabilities, and no review concepts.

## What Changes

- **The hosting model is decided: bare repositories on disk, one per project, operated only by the supervisor through a local `git` subprocess.** No git server process, no forge. Gitea/Forgejo are weighed and rejected. The decision and its rationale are recorded in an `AGENTS.md` beside the backend.
- A new `GitBackend` under `agent/git/`, a supervisor-only primitive like `agent/sandbox/`. It never imports `cli/`, and nothing in `cli/` imports it. Its operations:
  - **Repositories.** Create a project's repository, and archive one. Archiving moves the repository aside rather than deleting it.
  - **Refs.** List branches. Create, move, and delete a branch, each compare-and-swap against the value the caller expects, so a push becomes a ref move that cannot clobber a concurrent one.
  - **Transfer.** Write a bundle of a branch for filling an agent's workspace, and import a bundle's objects so that its tip can then be moved onto a branch. This is how the backend fills a workspace from the repository and takes a ref back out, with no URL and no credential involved.
  - **Diff.** A unified diff between two revisions.
  - **Merge.** Merge one branch into another as a merge commit, with an explicit author and committer, compare-and-swap on the target. A conflict is reported as a result naming the conflicting paths. The backend never resolves one.
  - **Read.** A directory's tree listing and a blob's contents at a revision.
- **Every git invocation is insulated from the host.** The host's user and system git configuration are never read, hooks never run, and caller-supplied names are validated so that none can be read as an option. The repository contents are agent-written, so they are treated as untrusted input.
- Unit tests against real repositories in a temp dir, run by hand like the rest of `agent/`.

## Capabilities

### New Capabilities

- `agent-git-backend`: the jen-hosted repository backend. Covers the hosting model, per-project isolation and layout, the operation set (repository lifecycle, compare-and-swap ref moves, bundle transfer, diff, attributed merge with conflicts reported, tree and blob reads), insulation from host configuration and repository content, and the supervisor as the only caller.

### Modified Capabilities

None. `agent-substrate`'s boundary requirements (the `agent/` root, no `cli/` ↔ `agent/` imports, outside CI) already cover a new directory under `agent/` unchanged.

## Impact

- **New code:** `agent/git/` holds the backend, its tests, and `AGENTS.md` with the decision record. No changes to existing `agent/` modules. Nothing calls the backend until ENG-202 wires it into the supervisor.
- **Dependencies:** no npm dependency. It needs a host `git` of at least 2.38, for `merge-tree --write-tree`, which is what makes a merge possible without a working tree. The backend checks the version when it is constructed and refuses an older one.
- **Not covered here:** how a bundle crosses into and out of a sandbox. The sandbox's input channel is text, and the `git_fetch`/`git_push` wiring belongs to ENG-202. So do the store root that repositories live under and the project ↔ repository binding. Onboarding an existing repository is ENG-209's. Repository maintenance (gc, backup scheduling) is not needed at this scale.
- **Checks:** `agent/` is outside CI. The typecheck and tests are run by hand (`agent/AGENTS.md`).
