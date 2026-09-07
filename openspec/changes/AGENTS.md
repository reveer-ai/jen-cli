# Authoring OpenSpec changes in jen

## This note cannot live at `openspec/AGENTS.md` — the tooling deletes that path

Put it one level down, here, beside the change directories it describes. `openspec/AGENTS.md`
is OpenSpec's own, and `openspec init` removes it.

That matters more than a misplaced file usually would, because of *when* it happens. jen's
`package.json` has `"prepare": "openspec init --tools claude --no-animation"`, and npm runs
`prepare` on `npm pack` — which `test/package.test.ts` runs. So `npm test` silently deletes an
untracked `openspec/AGENTS.md`, and the natural order of work is to write the note, run the
suite, then commit. The note is gone before `git add` ever sees it, and nothing reports it: the
suite passes, `git status` is clean, and the commit looks complete.

Verified rather than reasoned about — writing the file, running `npx openspec init --tools
claude --no-animation`, and finding it gone; and bisecting `npm test` to `test/package.test.ts`
for the same result. ENG-190 lost this exact note that way and spent a review round trip on it,
with the session's own closing comment reporting a file that no longer existed.

Anything at or below `openspec/changes/` survives, which is why this is here.

## `--strict` checks a delta against nothing the delta did not name

`openspec validate --strict` validates a change for *internal* consistency: every delta parses,
every requirement carries a scenario, every `MODIFIED` header matches something in the spec it
names. It does not read the capabilities the change left alone, so a main spec that flatly
contradicts the change passes validation by being absent from it.

That is not a hypothetical. ENG-190 emptied the permissions jen writes into a project, and
shipped a delta touching three capabilities. Two others — `stage-conventions`
("Permissions … SHALL be granted in the assistant configuration jen writes") and
`project-install` (".claude/settings.json SHALL be seeded with the permissions the workflow's
stages depend on") — asserted the behaviour being deleted, in their own words, and were named
nowhere. `--strict` passed. Review caught it; the round trip cost a full cycle.

What makes it worth a note rather than a lesson learned once: **the failure is silent and it is
permanent.** `deliver-task` archives the change by applying the deltas, so an unnamed capability
survives verbatim into `openspec/specs/`, and the specs then assert both that jen SHALL grant the
workflow's tooling and that it SHALL NOT. Nothing downstream re-reads them against each other.
The next change to touch permissions inherits a spec set that contradicts itself and no record of
which half was meant.

**So the check is: grep the main specs for the *behaviour* you are changing, not for the files you
are editing.** Those are different searches and only the first one works — the capability that
contradicts you is by definition one you were not already thinking about. For a permissions
change that is `grep -ril "permission\|grant" openspec/specs/`, then reading each hit and asking
whether it stays true, rather than assuming the three you had open are the three that exist.
Cheap, and it is the only thing standing between a contradiction and the archive.

**Run it at requirement granularity, not capability granularity.** ENG-190 hit this trap twice —
the second time *after* naming the capability. The delta modified `adoption-docs`, and a different
requirement in that same file still described its neighbour as the neighbour used to read
("the permissions section says a project's own checks must be granted the commands they run"),
which the change had just made false. `--strict` passed, because the delta was internally
consistent; the grep hit the file, and the reading stopped at *that capability is already in the
delta*. It is not. Only the requirements you named are. A capability you are editing is exactly
where a stale cross-reference hides, because sibling requirements quote each other's rationale
and nothing checks that the quote still holds — so read every requirement in a capability you
touch, not only the ones you are rewriting.

## A scenario heading is its identity, so renaming one reads as deleting it

`RENAMED Requirements` exists, and it binds `### Requirement:` headers only — a `FROM`/`TO` pair.
There is no scenario-level equivalent. A `MODIFIED` requirement replaces its whole block, and
scenarios inside it are matched by heading, so changing a `#### Scenario:` line is indistinguishable
from dropping that scenario and adding an unrelated one.

Verified on openspec 1.8.0 — renaming one scenario heading inside an otherwise-untouched `MODIFIED`
block fails `--strict` with:

```
✗ [ERROR] repo-scaffold/spec.md: MODIFIED "…" omits scenario(s) the current spec still has:
  "A clone needs the permissions the stages use". Copy them into the MODIFIED block
  (a MODIFIED requirement replaces the whole block, so archive refuses to drop them).
```

The error is accurate and the refusal is right — it is what stops a careless `MODIFIED` from
silently deleting scenarios. It just means a stale heading has no cheap fix. The only expressible
route is `REMOVED` plus `ADDED` on the entire requirement, which churns the requirement's identity
to correct a line of prose.

**Usually: leave the heading and let the body carry the meaning.** ENG-190 did, deliberately, and
review agreed. Worth knowing before you start, because the natural move — fix the wording, then
validate — makes the change look broken and invites reworking a delta that was already correct.
