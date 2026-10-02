## Why

The substrate knows `run` and `agent` and nothing above them, so nothing ties an agent to the repository its work belongs in. ENG-201 built that repository, but no agent can reach it. ENG-204's review gate and ENG-206's chief both need an agent bound to a project and a task, and they need git capabilities that work out their target from that binding instead of from an argument.

It is one change because storing the binding and pushing through it use the same resolution path: agent → run → project → repository, and agent → task → branch.

## What Changes

- **Projects and tasks as stored objects.** A project owns exactly one repository, and the binding is a field on the project, not a directory convention. A task belongs to one project and carries an id, a title, the ask, a status, its branch, and an optional OpenSpec change name. Both live in a jen-side store beside the existing runs. They can be queried, and nothing is ever deleted.
- **A run belongs to one project.** The run's header names it, and every agent in the run carries it.
- **The record gains `project` and `task`** (`task` nullable). `project` is the supervisor's to set and joins `OWNED`, so a spawn naming it is refused. `task` narrows the way `tools` does. A parent with no task may give a child any task in its project. A parent with a task may give only that task. Leaving it out means the parent's task. Anything else is refused, never dropped.
- **BREAKING: `jen-operator` takes a project.** Its arguments become `<store-root> <project> <run> <record.json> [opening]`. A new run is bound to the named project. Resuming a run under a different project is refused.
- **`create_task` and `list_tasks` as routed capabilities.** The chief creates tasks from conversation and has no other way to reach the store. `list_tasks` is read-only, so a chief in a later run can see the tasks that already exist. Both are scoped to the caller's project, and neither takes a project argument.
- **`git_fetch` and `git_push` as routed capabilities, with no repository or branch parameter.** The supervisor resolves the repository from the agent's project and the branch from its task. Fetch fills a checkout in the agent's workspace. Push publishes the checkout's `HEAD` to the task's branch.
  - An agent with no task can fetch but cannot push, so the chief never pushes.
  - Read-only access is a record naming `git_fetch` without `git_push`, narrowed by the `tools` rule spawn already enforces.
  - There is no commit capability. Every agent holds `exec`, and a commit stays inert until it is pushed.
- **Pushes are fast-forward only.** A push must descend from the task branch's current tip. A task branch is created by its first push, which must descend from the project's default branch (when that branch exists). This keeps a parent's and child's pushes to one task from discarding each other.
- **Attribution has two parts.** Fetch sets the checkout's git author to the agent's id. The supervisor also records every push: agent, run, task, branch, and old and new tips. Agents can rewrite the author field, but not the push record, which is what ENG-204's author rule will read.
- **git in the agent image**, pinned to an exact version like everything else there.
- **An ancestry check on `GitBackend`**, which the fast-forward rule needs and the backend doesn't have.
- **Linear is not touched on the managed path.** There is no mirror, and nothing in the pipeline reads a status to decide what to do. Visibility comes with jen's own interface in a later epic.

## Capabilities

### New Capabilities
- `agent-projects`: projects and tasks. The store and its layout, the project → repository binding, a run's project, task CRUD, the record's `project` and `task` fields and how spawn narrows `task`, and the `create_task` and `list_tasks` capabilities.
- `agent-git-capabilities`: `git_fetch` and `git_push`. How their target is resolved without an argument, how a bundle crosses the sandbox boundary, the fast-forward rule, the checkout's author, and the push record.

### Modified Capabilities
- `agent-runtime`: the one agent record gains `project` and `task`.
- `agent-supervisor`: spawn refuses a named `project` and narrows `task`. The run's durable header names its project.
- `agent-operator`: the operator takes a project, binds a new run to it, and refuses to resume a run under a different one.
- `agent-image`: the image carries a pinned git.
- `agent-git-backend`: the backend answers whether one commit is an ancestor of another.

## Impact

- **Code**, all under `agent/`, which sits outside CI (typecheck and tests are run by hand, per `agent/AGENTS.md`):
  - `record.ts`: the new fields and their parsing.
  - `supervisor/index.ts`: `OWNED`, `ROUTED`, the spawn handler, and four new request handlers.
  - `supervisor/store.ts`: the run header, plus a new project/task store beside it.
  - `runtime/main.ts`: model-facing declarations for the four capabilities.
  - `operator.ts`: the new arguments.
  - `git/index.ts`: the ancestry check.
  - `Dockerfile`: git.
  - `fixture.ts`: `EVERY_CAPABILITY`.
- **Store layout:** `<store-root>/projects/<project>/` and `<store-root>/repos/` appear beside `<store-root>/runs/`. Existing runs have no project and are not migrated. jen has no adopters, and the substrate's runs are disposable test runs.
- **Throughput:** a transfer runs outside the supervisor's serial queue, so one agent's push doesn't stall every other agent's delivery.
- **Unblocks** ENG-204 (the author rule reads the push record, and the merge targets the task branch) and ENG-206 (the chief creates and lists tasks, then spawns one agent per task).
- **Not here:** onboarding a project into the backend (ENG-209; ENG-206 provisions its project by hand), review state and statuses beyond `open` (ENG-204), and recursion bounds (ENG-206).
