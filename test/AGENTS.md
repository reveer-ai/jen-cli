# jen's own tests

## The credential scan reads the git index, so an unstaged rename fails it

`registry.test.ts`'s *tracks no credential in any file* enumerates paths with `git ls-files`
(via `trackedFiles()` in `helpers.ts`) and then opens each one. That is the right source —
the rule it enforces is about what a clone receives, and the index is what a clone receives
— but it means the test reads the index while `readRepoFile` reads the working tree, and
those disagree for exactly as long as a rename sits unstaged.

Delivery walks into this every time. Archiving a change moves its directory under
`openspec/changes/archive/`, and the suite run straight afterwards fails with
`ENOENT: no such file or directory` on the pre-move path — pointing at
`.openspec.yaml` or whichever file the scan reaches first, in a test about credentials,
naming a path the change never touched. `git add -A` makes it pass; nothing is wrong with
the test or the archive.

Worth knowing because of how it presents: the failure names the *old* path, so it reads as
though the move was incomplete or something deleted a file, and the honest fix is to stage
the move rather than to touch either the test or the archive. If a run reaches for
`readFileSync` guards here, it is solving the wrong problem — the scan must keep failing on
a file it cannot open, or a credential in an unreadable file would pass silently.

## A symlinked `node_modules` fails the `.gitignore` test, and blames `.gitignore`

Testing a change in its *merged* state means a throwaway worktree, and the cheap way to make
one runnable is to symlink the main checkout's `node_modules` into it rather than install
again. That one shortcut fails `repo-layout.test.ts` — `ignores build output, dependencies,
and local agent scratch`, on the `node_modules/anything/index.js` line — in a worktree where
`.gitignore` is byte-identical to the one that passes.

`isIgnored` shells out to `git check-ignore --no-index` and treats any throw as *not ignored*.
Git refuses to answer for a path that traverses a symlink at all: `fatal: pathspec
'node_modules/anything/index.js' is beyond a symbolic link`, exit 128. So the helper reports
`false`, the assertion reads `expected false to be true`, and nothing anywhere names the
symlink. Every other path in that test is a real directory, which is why exactly one line
fails and the failure looks like a rule went missing.

Copy `node_modules` into the worktree instead, or install into it. Don't reach for a
`try`/`catch` refinement in `isIgnored` — collapsing "git says not ignored" and "git refused
to look" is what hid the cause here, but widening the helper to distinguish them buys nothing
for the suite's real job and adds a branch no assertion exercises. The fix is to stop handing
git a path it will not answer for.
