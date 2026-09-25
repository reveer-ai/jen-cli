## ADDED Requirements

### Requirement: Managed-project repositories are bare repositories on disk, operated by the supervisor alone

jen SHALL host each managed project's repository as a bare git repository on the host's filesystem. Every operation on it SHALL be performed by a local `git` subprocess started from the supervisor process. jen SHALL NOT run a git server or an embedded forge for managed projects. No agent SHALL be handed a repository's path, a URL to it, or a credential for it.

The backend SHALL live under `agent/git/`. It SHALL NOT import from `cli/`, and no module under `cli/` SHALL import it. The decision and its rationale, weighed against an embedded forge, SHALL be recorded in `agent/git/AGENTS.md`.

jen's own repository is out of scope and stays on its existing host.

#### Scenario: No server process is involved

- **WHEN** any backend operation runs
- **THEN** it completes by spawning `git` against a repository directory under the backend's root
- **AND** no network listener is opened

#### Scenario: The decision is recorded beside the code

- **WHEN** `agent/git/AGENTS.md` is read
- **THEN** it states the bare-repository model and why an embedded forge was rejected, on the criteria of isolation, scale, fit with routed fetch/push, and operational surface

### Requirement: One repository per project, isolated by layout

A backend SHALL be constructed with a root directory, and a project's repository SHALL live at `<root>/<project>.git`. A project id SHALL match `^[a-z0-9][a-z0-9-]{0,62}$`. Any other id SHALL be refused before any filesystem or git operation.

Repositories SHALL NOT share an object store: no alternates, and no common object directory.

#### Scenario: An id that could escape the root is refused

- **WHEN** an operation is called with the project id `../other`, `.archive`, `-x`, or `Upper`
- **THEN** it fails with a backend error naming the invalid id
- **AND** nothing under the root is created, read, or changed

#### Scenario: One project's objects are unreachable from another

- **WHEN** a commit exists only in project A's repository
- **THEN** reading that commit's sha as a revision in project B's repository reports it absent

### Requirement: Repositories are created atomically and archived, never deleted

`create(project)` SHALL produce an empty bare repository whose `HEAD` names `refs/heads/main`. Creation SHALL be atomic: a repository appears at its final path complete or not at all. Creating a project whose repository already exists SHALL fail and leave the existing repository unchanged.

`archive(project)` SHALL move the repository to `<root>/.archive/<project>-<UTC timestamp>.git` by rename. The backend SHALL offer no operation that deletes a repository.

#### Scenario: Create makes an empty repository on main

- **WHEN** `create('demo')` is called
- **THEN** `<root>/demo.git` is a bare repository with no branches
- **AND** its `HEAD` is `refs/heads/main`

#### Scenario: Creating twice is refused

- **WHEN** `create('demo')` is called and `demo` already exists with branches
- **THEN** the call fails
- **AND** the existing repository's branches are unchanged

#### Scenario: Archive moves rather than deletes

- **WHEN** `archive('demo')` is called
- **THEN** `<root>/demo.git` no longer exists
- **AND** a repository under `<root>/.archive/` beginning `demo-` holds the same branches at the same shas

### Requirement: Git is insulated from host configuration and from repository contents

Every `git` invocation SHALL run with an environment the backend builds rather than inherits. It SHALL ignore system and global git configuration, SHALL run no hooks, and SHALL NOT prompt. Diff SHALL disable external diff drivers, textconv, and color, and SHALL use fixed `a/` and `b/` prefixes.

Branch names SHALL be validated with git's own ref-format rules and SHALL NOT begin with `-`. A revision SHALL be either a valid branch name or a full-length hexadecimal object id. Every caller-supplied operand SHALL follow `--end-of-options`.

The backend SHALL require git 2.38 or later, and SHALL refuse construction against an older git with an error naming the requirement.

#### Scenario: A hostile global config changes nothing

- **WHEN** `GIT_CONFIG_GLOBAL` in the supervisor's environment points at a file setting `diff.noprefix=true` and a `core.hooksPath` holding a hook that writes a marker file
- **THEN** `diff` output still uses `a/` and `b/` prefixes
- **AND** no operation writes the marker

#### Scenario: A repository's own attributes cannot invoke a driver

- **WHEN** a branch's `.gitattributes` names a merge driver or textconv, and that branch is merged or diffed
- **THEN** no external program is run

#### Scenario: An option-shaped name is refused

- **WHEN** a branch name `--output=/tmp/x` or a revision `-p` is passed to any operation
- **THEN** the call fails as invalid before git is run

#### Scenario: An old git is refused up front

- **WHEN** the backend is constructed and `git version` reports a version below 2.38
- **THEN** construction fails with an error naming 2.38 as the requirement

### Requirement: Branches are listed and written by compare-and-swap

The backend SHALL expose branches only, by short name, mapping each to `refs/heads/<name>`. `listBranches(project)` SHALL return every branch with its sha.

`createBranch(project, name, sha)` SHALL succeed only if the branch does not exist. `moveBranch(project, name, sha, expected)` SHALL succeed only if the branch currently points at `expected`. `deleteBranch(project, name, expected)` SHALL succeed only if the branch currently points at `expected`. A new value SHALL name a commit present in the repository. When the current value differs from the one required, the call SHALL fail with a stale-ref error distinguishable from every other failure, carrying the branch's actual value, and the branch SHALL be unchanged.

Whether a move is a fast-forward SHALL NOT be checked. That is the caller's policy.

#### Scenario: A move against a stale expectation is refused and reported

- **WHEN** `moveBranch` is called with `expected` = X while the branch is at Y
- **THEN** the call fails with a stale-ref error reporting Y
- **AND** the branch is still at Y

#### Scenario: Create refuses an existing branch

- **WHEN** `createBranch` names a branch that exists
- **THEN** the call fails with a stale-ref error and the branch is unchanged

#### Scenario: A move may rewrite history

- **WHEN** `moveBranch` moves a branch to a commit that is not a descendant of its current value, with a correct `expected`
- **THEN** the branch moves

#### Scenario: A move to a missing object is refused

- **WHEN** `moveBranch` names a sha absent from the repository
- **THEN** the call fails and the branch is unchanged

### Requirement: Transfer in and out is by git bundle, and incoming objects are fsck-checked

`bundle(project, branch, path, { basis? })` SHALL write a git bundle of the branch to the given path, excluding every object reachable from the commits in `basis`.

`importBundle(project, path)` SHALL add the bundle's objects to the repository and return the refs and shas the bundle carries. It SHALL NOT create, move, or delete any ref, and SHALL NOT write `FETCH_HEAD`. It SHALL check every incoming object with git's fsck. A bundle containing a malformed object, or one whose prerequisites the repository lacks, SHALL be refused, and SHALL leave every ref unchanged.

A push SHALL be expressible as `importBundle` followed by `moveBranch` to a returned sha.

#### Scenario: A bundle round-trips into a fresh workspace

- **WHEN** a bundle of `main` is written, and a fresh clone is made from that bundle file
- **THEN** the clone's `main` is at the same sha as the repository's

#### Scenario: An incremental bundle carries only what is new

- **WHEN** `bundle` is called with `basis` naming the branch's parent commit
- **THEN** the bundle lists that commit as a prerequisite
- **AND** importing it into a repository that already has the basis succeeds

#### Scenario: Import touches no ref

- **WHEN** a valid bundle carrying a new commit on `task/x` is imported
- **THEN** the result reports that ref and sha
- **AND** `listBranches` is identical before and after
- **AND** the commit can then be placed with `createBranch` or `moveBranch`

#### Scenario: A malformed object is refused

- **WHEN** a bundle containing a commit with a malformed author line is imported
- **THEN** the import fails
- **AND** the malformed commit is not readable from the repository by revision

#### Scenario: Missing prerequisites are refused

- **WHEN** an incremental bundle is imported into a repository lacking its basis
- **THEN** the import fails and no ref changes

### Requirement: Merge is an attributed merge commit, compare-and-swap, and conflicts are reported and never resolved

`merge(project, source, target, { author, committer, message })` SHALL perform the merge without a working tree. `author` and `committer` each carry a name, an email, and a date.

- If the source is already reachable from the target, the result SHALL be `up-to-date` and nothing SHALL change.
- If the merge is clean, the backend SHALL create a merge commit whose first parent is the target's tip, whose second parent is the source's tip, and whose author and committer are exactly those given. It SHALL then move the target to that commit by compare-and-swap against the tip it merged. The result SHALL be `merged` with the new sha. A fast-forward SHALL never be performed.
- If the merge conflicts, the result SHALL be `conflict` with the conflicting paths and git's messages, and no ref SHALL change. The backend SHALL NOT resolve a conflict by any strategy.
- If the target moved during the merge, the call SHALL fail with a stale-ref error and the target SHALL keep its new value.

#### Scenario: A clean merge is attributed as given

- **WHEN** `task/a` changes a file untouched on `main`, and `merge(…, 'task/a', 'main', { author: jen, committer: jen, … })` is called
- **THEN** the result is `merged`
- **AND** `main`'s new tip has parents (old `main`, `task/a`) and author and committer exactly as given

#### Scenario: A fast-forwardable merge still makes a merge commit

- **WHEN** `main` is an ancestor of `task/a` and they are merged
- **THEN** `main`'s new tip is a two-parent commit, not `task/a`'s tip

#### Scenario: A conflict is reported and nothing moves

- **WHEN** `main` and `task/b` change the same line of `f` differently, and they are merged
- **THEN** the result is `conflict` with paths including `f`
- **AND** `main` is unchanged

#### Scenario: Already merged is a no-op

- **WHEN** `task/a` is merged into `main` a second time with no new commits
- **THEN** the result is `up-to-date` and `main` is unchanged

#### Scenario: A racing move is not clobbered

- **WHEN** the target moves after the merge read it and before it is updated
- **THEN** the merge fails with a stale-ref error
- **AND** the target keeps the racing value

### Requirement: Diff, tree, and blob reads distinguish absence from failure

`diff(project, from, to)` SHALL return the unified diff from `from` to `to`, two-point, in full. Output SHALL never be truncated. An output the backend cannot hold SHALL be an error.

`tree(project, rev, dir?)` SHALL return one directory level's entries at `rev` (mode, type, sha, name), or `null` if the directory does not exist at `rev`.

`blob(project, rev, path)` SHALL return the file's exact bytes at `rev`, or `null` if no blob exists at that path.

An absent revision, path, or repository SHALL be reported as absence where the signature allows (`null`), or as a backend error otherwise. A git failure SHALL NOT be reported as absence.

#### Scenario: Diff between two revisions

- **WHEN** `diff` is called from `main` to `task/a`, where `task/a` changed `f`
- **THEN** the output is a unified diff with `a/f` and `b/f` headers and the changed lines

#### Scenario: Tree lists one level

- **WHEN** `tree` is called at a revision with `f` and `dir/g`
- **THEN** the root listing has `f` as a blob and `dir` as a tree, and does not list `g`

#### Scenario: Blob returns bytes exactly

- **WHEN** a file with non-UTF-8 bytes is read with `blob`
- **THEN** the returned bytes equal the committed bytes

#### Scenario: A missing path is null, not an error

- **WHEN** `blob` or `tree` names a path absent at the revision
- **THEN** the result is `null`

### Requirement: Subprocess failures are contained and reported

Every `git` subprocess SHALL have an `error` listener on the child and on each of its pipes, and SHALL have its stdout and stderr read to the end. A failure SHALL be reported as a backend error carrying the git arguments and the tail of stderr, never the environment. No failure in one operation SHALL raise an uncaught exception in the supervisor's process.

#### Scenario: git missing from PATH

- **WHEN** the backend is constructed with a `git` executable that cannot be spawned
- **THEN** construction rejects with a backend error
- **AND** the process does not crash

#### Scenario: A failing command reports its stderr

- **WHEN** an operation's git command exits non-zero for a reason that is not an expected outcome
- **THEN** the backend error's message includes git's stderr
