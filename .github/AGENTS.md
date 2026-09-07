# Releasing

`ci.yml` runs the checks. `release.yml` turns a merge into a published version. The
reasoning behind their shape is in the archived `release-pipeline` change; what is here is
what you need when something is wrong, or when you are about to change one of them.

## A change to shipped behaviour needs a changeset

`npm run changeset`, answer the prompts, commit the file it writes under `.changeset/`.

Nothing enforces this. A change merged without a changeset is not a failure and not a
release — it sits on `main`, shipped to nobody, until some later change carries a
changeset and takes it to the registry along with itself. That is the intended behaviour,
not a gap: a docs fix or a workflow tweak has nothing to tell an adopter.

The consequence worth knowing is the one that bites: **a change is not released when it
merges.** It is released when someone merges the Version PR, which is a separate, human
decision. If you shipped something and cannot find it on npm, check whether the Version PR
is still open before checking anything else in this file.

The Version PR itself is outside jen's own workflow — no Linear issue, no OpenSpec change,
no stage that owns it. Do not create one for it. The workflow governs *changes*; this is a
*release*.

## What the pipeline cannot set up for itself

Five things live in account settings, not in this repository. None of them is observable
from a green build — each is invisible until the run that needs it fails, and the failures
do not name themselves. Listed in the order they must be created.

| Precondition | What it is | What its absence looks like |
|---|---|---|
| **GitHub App** | Contents: write and Pull requests: write, installed on this repository only. Id in the `APP_ID` variable, key in the `APP_PRIVATE_KEY` secret. | The `version` job fails to authenticate and **no Version PR appears at all**. Nothing publishes, and nothing explains why. |
| **`release` environment** | Deployment branches restricted to `main`, no required reviewers. | The publish fails at the OIDC exchange. npm reports a 404 naming the package, because the claim it was matching is missing. |
| **The package exists on npm** | `@reveer/jen@0.0.0` published by hand, then `npm deprecate`d. | The trusted-publisher form cannot be reached — it is per-package and only exists for a package that exists. This is why the pipeline does not publish the first version. |
| **Trusted publisher entry** | On the package's settings page: owner `reveer-ai`, repo `jen-cli`, workflow filename `release.yml`, environment `release`, allowed action `npm publish` (not `npm stage publish`). | The publish fails as a 404 naming the package. |
| **Required status check on `main`** | Naming the CI job. | Nothing fails. Releases keep shipping, ungated, and the gap is silent — which is the reason it is on this list. |

*"Allow GitHub Actions to create and approve pull requests" is deliberately **off**.* The
App replaces it and holds two permissions on one repository where the toggle is a blanket
grant to every workflow here. If you find it switched on, that is a regression, not a fix.

**One deferred step, still open.** The npm package should also *require 2FA and disallow
tokens* — neither affects OIDC, and together they make trusted publishing the only way in.
It was held back until the automated path had proven itself, because applying it early
narrows the manual fallback at the moment it is most likely to be needed. Apply both once a
version has published through the pipeline with provenance.

## A publish failed

Every misconfiguration in the OIDC exchange reports the same one or two errors
([npm/cli#9088](https://github.com/npm/cli/issues/9088)): `E404` naming the package, or
`ENEEDAUTH`. Neither names its cause. Work the list in order — it is sorted by how cheap
each cause is to rule out, not by how likely it is.

1. **npm too old.** Needs >= 11.5.1 to perform the exchange at all; an older one declines
   it and reports the 404. The workflow asserts this in its own step, so if that step
   passed, this is ruled out — read its output rather than assuming.
2. **A stray `.npmrc`.** npm prefers any token it can see over an OIDC exchange, including
   a placeholder. The usual source is `registry-url` on `setup-node`; it is deliberately
   absent, and `test/release.test.ts` fails if someone adds it back.
3. **`id-token: write` missing** from the publish job's permissions. Without it there is no
   token to exchange.
4. **`environment:` missing, or not matching** the trusted-publisher entry. Both sides must
   say `release`. Also asserted by `test/release.test.ts`, because removing it leaves a
   pipeline that works — right up until it does not.
5. **Workflow filename mismatch.** The entry names `release.yml` as a filename, not a path.
   Renaming this file breaks publishing and nothing else, so nothing else will warn you.
6. **Owner or repository mismatch**, including `repository.url` in `package.json` — which
   must be the normalized `https://` form, never `git+https://`. Asserted in
   `test/package.test.ts`.
7. **The OIDC env vars not reaching npm.** `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and
   `ACTIONS_ID_TOKEN_REQUEST_URL` have been reported not surviving a wrapper chain from a
   JS action through a package script ([npm/cli#8976](https://github.com/npm/cli/issues/8976)).
   The publish here is a bare shell step for exactly this reason, so it should not apply —
   which is why it is last.

**A different symptom, a different cause.** No Version PR at all — as opposed to a failed
publish — is almost always the App private key: expired, rotated, or the App uninstalled.
App keys do not announce their own expiry, and the failure is loud in the `version` job but
looks like a broken pipeline rather than an expired credential.

## A run published and then failed

The publish, the tag, and the GitHub Release share one guard: is this version already on
the registry. That is what stops the pipeline recording releases it did not make, and it is
why a re-run recovers from any failure *before* the publish — the version is still absent,
so the guard is still true and the whole sequence runs again.

**After a successful publish it works the other way.** The guard has flipped, and a re-run
skips the tag and the Release exactly as it skips the publish. The run goes green having
done nothing. If a run published and then failed at either later step, **create the tag and
the Release by hand** — nothing will do it for you, and a re-run will tell you everything is
fine.

This is the one partial failure that does not recover on its own. Every other one does.

## Changing these workflows

- **Nothing in the release path runs on a pull request.** The first push to `main` after a
  merge is the first execution, every time. `test/release.test.ts` exists because that is
  the only pre-merge check there is.
- **Actions in `release.yml` are pinned by commit SHA; `ci.yml` is left on tags.** The
  asymmetry is deliberate, not an oversight: `release.yml` can publish to the registry, so
  any code it runs can too, while `ci.yml` runs tests with a read-only token and no way to
  reach npm. Do not resolve the difference in a consistency pass.
- **`ci.yml` has no `push: main` trigger and must not regain one.** The release invokes it
  as a called workflow, which is what puts it in the release run's dependency chain. A
  second run triggered by the same push races the release rather than gating it, while
  looking authoritative.
- **The publish job installs nothing and builds nothing.** It downloads the tarball
  `ci.yml` packed on Node 20.19.0 and uploads that exact file, so the artifact that ships
  is the one the checks verified. Building in the publish job would ship an artifact
  produced by a Node the test suite never ran under.

There are three kill switches outside this repository, none needing a commit: revoke the
trusted publisher entry, uninstall the App, or remove `main` from the `release`
environment's deployment branches. They sever different links — publishing, Version PRs,
and the credential itself.

## Running a stage from a workflow

No workflow here runs a stage, and jen ships none that does. The two in this directory are
jen's own CI and release. jen used to ship a scheduled runner to adopters at
`.github/workflows/jen.yml`; that was removed in ENG-188, and jen now ships no workflow file
for any runner — `jen run` is the entry point, and an adopter who drives it from a scheduled
job owns the file that does so.

The rules below therefore describe a workflow an adopter might write, not one in this
repository. They are kept because the pipeline's own stages hit the same two rules however
they are dispatched.

Both of the rules below fail silently when they are got wrong, which is why they were written
down before the code that could trip on them existed.

**The review verdict must never be submitted under `GITHUB_TOKEN`.** A review submitted
with the default workflow credential is recorded and rendered exactly like any other, and
satisfies no approval requirement — so the pull request shows a review, the gate stays
unsatisfied, and delivery blocks on an approval that appears to already be there. It is the
worst shape a failure can take: not an error, a lie. The verdict goes out under the
`deliver` role's own installation token, minted from its App's private key.

**`GH_TOKEN`, not `GITHUB_TOKEN`, is the name a stage's credential is supplied under.** This
is not a style preference. `gh` prefers `GH_TOKEN` when both are set, and on an Actions
runner `GITHUB_TOKEN` is present whether or not anyone put it there — it is the very
credential above, sitting in the variable a stage would otherwise read. Naming the good
credential so that it *wins* is what keeps the default from silently taking over. If you
find a stage reading `GITHUB_TOKEN`, that is the bug, not the fallback.

Which surface a stage reaches for its pull-request work is not a workflow question — see
`.claude/skills/AGENTS.md` for why the tracker's diff tools are inert under the pipeline's
own identity, and why that is invisible from their output.
