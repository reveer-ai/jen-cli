# Workflow

jen is the workflow layer for automated, agentic software development — task-anchored, spec-driven, and git-reviewed. Any agent acting within this project must strictly adhere to this workflow.

jen is not a hub that points at separate project repos — a project installs jen into its own repository. Installing carries the workflow — this file and the skills — directly into the project.

# Source of truth

The task — tracked in project management software (Linear today, others later) — is the source of truth. OpenSpec changes, git branches, and PRs all trace back to a task and exist to serve it. Git accurately records the history of both code and specs — proposals, designs, and code are all reviewed and merged as PRs — but the task is still what everything reports back to, and the durable narrative of a project's work (the why, not just the what) lives there, not in git log.

# Projects are monorepos

A project installs jen into its own repository, and that repository *is* the project's monorepo. The root is jen's — this file, `.claude/`, `openspec/`, and `registry.yaml` — and `src/` holds what a repository root would conventionally hold: the project's own sources, tracked right there beside the workflow that governs them. Fill in `src/`, `openspec/`, and `.claude/skills` with what makes it that project. Source, specs, and history stay unified in one repo, however many things deploy out of it on however many different pipelines/cadences.

Linear projects and repositories aren't 1:1 — multiple Linear projects can, and probably will, point at the same repository.

# Artifact progression

OpenSpec drives spec-driven development through an ordered set of artifact stages, defined by whatever schema the project uses. A task's status mirrors its current stage, and a task sitting in a stage's status is the trigger for an agent to do that stage's work.

Each task carries one branch and one PR from end to end. The PR opens during design, holding nothing but the OpenSpec artifacts; implementation, review fixes, and test fixes all land on that same PR; merging it is the pipeline's last act and what closes the task out. Specs and code are reviewed together, in one place.

# Stages

One skill per stage, each triggered by the task sitting in that stage's status.

| Status | Skill | Work | Hands off |
|---|---|---|---|
| — | `refine-epic` | Turn an idea into an epic and its sub-issue tasks | tasks land in `Todo` |
| `In Design` | `design-task` | Create the OpenSpec artifacts, open the draft PR, sync each artifact to the issue | → `Pending` — the user promotes |
| `In Progress` | `implement-task` | Implement `tasks.md`, write unit tests, mark the PR ready for review | → `In Review`, or `Pending` |
| `In Review` | `review-task` | Review the diff against its own design — correctness, security, quality | → `In Testing`, back to `In Progress`, or `Pending` |
| `In Testing` | `test-task` | Exercise the change for real beyond unit scope; route anything only a human can judge | → `In Delivery`, back to `In Progress`, or `Pending` |
| `In Delivery` | `deliver-task` | Sync specs, archive the change, merge the PR | → `Done`, or `Pending` |

Every session ends in one of exactly two ways: it moves the task to the next stage's status, or it moves the task to `Pending`. No stage ever finishes leaving the task in its own status. So a task found in a stage's status is one a session is working or one a session died working — never one at rest — and that is what makes presence a sound trigger.

`Pending` means the task is a human's. It's where a stage puts anything only a person can settle: a decision the stage can't make, a blocker it can't clear, work that's finished and needs a person before it goes on, or a task it judges should stop circling. The status carries only that a human is needed, so the comment that accompanies the move is what says which.

`Backlog` holds unrefined placeholders; `Todo` holds refined tasks, ready to design. Two transitions are the user's, and no stage makes either: `Todo` → `In Design`, which starts design, and `Pending` → `In Progress`, which starts implementation. Every later transition is a stage's.

Design confirms with the user before each artifact when confirmation is available to it. When it isn't, design writes the set without confirming and the draft PR carries the confirmation afterward. Which one applies is discovered from whether asking works, never read from a flag or an environment variable.

# Conventions

Shared by every stage, so no stage restates them.

- **Input.** A stage takes a Linear task, given directly or inferred from context — ask if it's unclear. If asking isn't available and no task can be identified, there's nothing to act on: say so and stop.
- **Read the record.** Before acting, read the task's status history, its comments, and its PR with the threads on it. That's what tells you whether you're resuming an interrupted run, picking up work a later stage routed back and why, what a human has already said, and whether the task has been circling the pipeline. It's context, never a gate — a stage doesn't decline its work over what it reads there, and it can say on the task that something looks stuck. Whether a task should be worked at all is decided by whoever starts the stage, not by you.
- **Resume, don't restart.** Assume you may be re-entering a task a killed run already worked. Every completion marker — a checked box in `tasks.md`, a status command reporting an artifact complete, a file that exists — records an intent that was true at some moment, so treat it as a claim and check it against the evidence: the commits on the branch, the state of the PR, the threads on it, the comments on the task. Where they disagree, the evidence wins. A run is a fresh checkout, discarded when it ends, so work that was never committed didn't survive the session that made it and a marker can outlive what it claims.
- **Naming.** A task's branch and its OpenSpec change name both derive from the issue's Linear-suggested branch name (`get_issue`): branch as-is, change name lowercased with any leading `<username>/` stripped. OpenSpec requires lowercase, and a slash left in the name nests the change directory and breaks every `--change` lookup.
- **Where the work goes.** The pull request is the git host's and the task is the tracker's. Reading the threads on a PR, anchoring a comment to a line of the diff, replying to a thread, resolving it, recording a verdict, and merging are all `gh`; status, comments, and artifact attachments are all Linear's tools. The issue's suggested branch name is the one value that crosses. Never reach for the tracker's diff tooling even where it offers what you need: its contents come from an integration binding a tracker user to a git-host account, so an identity with no linked git-host account, such as one acting as an application, reads empty rather than failing. No error, just nothing, and nothing distinguishes it from a PR that genuinely had nothing on it. Runtime won't tell you; this line is where the division is held.
- **One PR per task.** It opens during design as a draft and stays open until deliver-task merges it. Update it; never open a second. Opening it is `gh pr create --draft`, and every act upon it afterward is `gh` too.
- **Artifact sync.** Each artifact uploads to the issue as a file attachment once it's finalized, never as a draft in progress. `prepare_attachment_upload` with the file's exact byte size, PUT the raw bytes to the signed URL replaying every header it hands back verbatim, then `create_attachment_from_upload` with the returned `assetUrl`, titled with the artifact's name. One artifact at a time — a signed URL expires in 60 seconds, so preparing several up front expires the early ones. There is no update call: a stage that revises a finalized artifact deletes the stale attachment and uploads the replacement in the same run, leaving exactly one copy of each and that copy current. Once the change is archived the task is the durable record of it, so a stale attachment is a lie about what shipped.
- **The issue's own text is the humans'.** No stage overwrites the description — it holds the original ask, and that's what the artifacts are answering. Comments carry the running narrative: blockers, handoffs, and whatever needs a person.
- **Commits.** Lead with the issue identifier — `ENG-135: add resource loader`. Any stage that writes files commits and pushes them before handing off.
- **Threads.** Push a fix before replying to and resolving its thread. Never resolve against unpushed work — it tells the reviewer something untrue. Read the threads with their resolution state and the comment id a reply needs:

  ```bash
  gh api graphql -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$number){
      author{login}
      reviewThreads(first:100){ nodes{
        id isResolved path line
        comments(first:1){ nodes{ databaseId author{login} body } } } } } } }' \
    -F owner=OWNER -F repo=REPO -F number=N
  ```

  Then reply, then resolve:

  ```bash
  gh api repos/OWNER/REPO/pulls/N/comments/COMMENT_ID/replies --method POST -f body='…'
  gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=THREAD_ID
  ```

  `COMMENT_ID` is the `databaseId` of the thread's first comment; `THREAD_ID` is the thread's node id (`PRRT_…`). Both come from the read, because both are needed and neither is reachable from the other. Use the GraphQL read rather than the REST comments endpoint: `isResolved` exists only on this connection, so a stage reading REST cannot tell an answered thread from an open one. Resolution is likewise only the mutation — there is no REST equivalent to reach for.

  Opening a *new* thread — what a stage leaves when something needs a person, anchored to what it concerns — is a different endpoint, and `commit_id` is the part that isn't guessable:

  ```bash
  gh api repos/OWNER/REPO/pulls/N/comments --method POST \
    -f commit_id="$(gh pr view N --json headRefOid --jq .headRefOid)" \
    -f path=PATH -F line=LINE -f side=RIGHT -f body='…'
  ```

  `LINE` has to be part of the diff. A line outside the changed hunks is refused with a `422` and no comment — including a line in a file this change edits, which is the case that looks anchorable and isn't. When the host refuses the anchor the note goes on the Linear issue, naming the file and line there instead; it is the same note, and **No stage waits on a human** already sends it to either place.

  `gh pr comment` is not this: it takes no path or line and posts to the conversation, which is the unanchored comment the anchor was for. It's the wrong answer where an anchor is possible, which is what makes the issue the right one where an anchor isn't. Anchoring costs one empty-bodied `COMMENTED` review in the PR's reviews listing — the host wraps every standalone comment in one. It is an artifact of the endpoint, never a verdict, and a stage reading that listing for a verdict reads the body.
- **Verdicts and merges.** Of the six stages, only review-task submits an approving review, and only deliver-task merges. This is the one rule here the host does not enforce for us: the branch can ask for an approval and cannot ask *which* identity gives it. design-task is excluded whatever it does, since the host refuses a review from a pull request's own author and design opened it — but implement-task holds the same pull-request write access the reviewer does, and nothing on the branch stands between it and approving what it just pushed. Its restraint is the rule. A breach isn't silent, though: the PR timeline records every approval with its actor and the point it landed, so an approval that follows implementation with no review between reads as out of place there. That timeline is where this gets audited, not the branch protection.
- **Notes as you work.** A convention this change establishes, or a gotcha a future session would otherwise rediscover the hard way, goes in the AGENTS.md nearest the code it applies to — written by the stage that learned it, at the point it learned it, so it rides in the diff and gets reviewed and tested like everything else. Never the root AGENTS.md: that's the workflow, and the next `jen update` replaces it wholesale — a note written there isn't impolite, it's lost. They live at or below `src/`, as deep as the thing they describe. Skip it when nothing clears the bar — a note nobody needed is worse than no note.
- **Announce yourself before you act.** Comment on the issue before you produce anything — which stage is running, and that you've picked the task up. That comment is what marks the task as being worked, to a person and to a stage alike; the status can't, because it stays actionable until you move it. Nothing writes the announcement on your behalf. An announcement you find already on a task is a claim like any other completion marker, not proof; establish from the evidence what that run actually did.
- **Comment at the end of every session.** Whatever the outcome — finished, stopped early, or blocked — comment on the issue before you exit. Never finish silently, including when nothing went wrong. Carry what the stage did, what it decided, where it stopped and why, and what the next stage picks up; a bare "done" satisfies the letter of this and is worth nothing. Where you parked the task at `Pending`, this comment is the only thing carrying *why* — the status can't express it. An announcement with no closing comment after it is a session that died, and the task still sitting in that stage's own status says the same thing: a stage re-entering it reads that pairing as an interrupted run whose markers are all unverified.
- **Don't route a task back for something that already sent it back.** Before routing backward, read what the record says sent the task back before. Where the objection you're about to raise is one that has already returned it once, move it to `Pending` instead and name in your comment what sent it back each round. Judging whether two objections are the same one is yours — you're reading the record anyway, and counting transitions can't make that comparison.
- **No stage waits on a human.** A run may have nobody watching it, and a denied question is not a prompt you can wait out. What needs a human goes on the Linear issue or the PR, anchored to what it concerns; then move the task to `Pending` and stop. Leaving it in your own status would tell the pipeline a session is still working it.

# Resources

All work happens in the context of resources defined in `registry.yaml`. A resource can be a project's repo, a project-management entry pointing at the repo it tracks, or anything else worth registering.

```
registry.yaml     # All registered resources with access and setup info
src/              # The project's own sources, tracked in this repository — whatever a skill acts on
```

Check `registry.yaml` for the resources relevant to the current task.
