# Contributing to jen

This is for someone changing jen. If you are adopting jen into a project, [`README.md`](README.md) is your document.

## Working on jen

```bash
npm install
```

The seven skills work straight out of a clone — no build, no install, no init. They are the same files the package ships; editing one is editing a file.

OpenSpec's own skills and commands are **not** vendored. `npm install` runs `openspec init` for you through `prepare`, writing `.claude/skills/openspec-*` and `.claude/commands/opsx/*` from the version in the lockfile. Both are gitignored — committing them re-vendors the frozen snapshot this repository deliberately dropped.

`openspec init` also writes `openspec/config.yaml`, and that one **is** tracked. It is seeded by init but owned by the project: it declares the schema and carries the project's context and per-artifact rules, so it is config a human edits rather than a snapshot to regenerate. Gitignoring it would leave every clone reporting a dirty tree and hide the schema declaration from anyone who has not run an install.

`prepare` rather than `postinstall` on purpose: `postinstall` fires for anyone installing jen as a dependency, and would run `openspec init` inside their project uninvited. `prepare` only runs for a local install here.

## Checks

```bash
npm run build && npm run typecheck && npm test
```

CI runs the same three on every pull request, on the minimum Node version `engines.node` allows.

**None of them reach `agent/`.** The agent substrate is deliberately outside the build, the checks, and the tarball — see below.

## The agent substrate

`agent/` holds the substrate: a ground-up redesign of how work gets coordinated, built while its shape is still unsettled. It is not part of the CLI, does not import it and is not imported by it, and has checks of its own:

```bash
npx tsc -p agent/tsconfig.json
npx vitest run --config agent/vitest.config.ts
```

It is kept outside `npm run build`, `npm run typecheck`, `npm test`, CI, and `files` on purpose: wiring an unfinished experiment into the checks that gate every pull request would make it a condition of merging unrelated work. The cost is that **nothing automated covers it** — a green pull request says nothing at all about `agent/`, so the two commands above are run by hand by anyone changing it, before merging. Its sandbox tests need a running container runtime, and its configuration is its own rather than an extension of the repository's.

That arrangement is temporary, and the condition for ending it is definite: when something depends on the substrate, or when it is to be published, it gets wired into the checks in the same change that makes either true. [`agent/AGENTS.md`](agent/AGENTS.md) has the rest.

## Packaging

`npm pack` compiles the CLI to `dist/` and stages the payload into `dist/templates/` — the seven skills, stamped, plus the workflow document and the once-only scaffold `jen init` writes. `files: ["dist"]` ships that and nothing else, though the registry adds `package.json`, `README.md`, and `LICENSE` to every tarball regardless.

See [`cli/AGENTS.md`](cli/AGENTS.md) for how the payload declaration and staging fit together, and [`.github/AGENTS.md`](.github/AGENTS.md) for releasing — including the changeset a change to shipped behaviour needs.

## Validating the adoption path

The tests inject a staged payload and never see a tarball, a real `openspec init`, or an adopter's `node_modules`. Nothing automated covers adoption end to end, and nothing can: it needs a packed tarball, a real tracker, and a conversation with a user. So it is a ritual rather than a job, run by hand when the payload, the CLI's commands, or the adoption docs change.

**Pack, never run from the working tree.** `prepack` is what stages the payload, so the tarball is built and staged by construction. A run out of the working tree skips staging entirely and proves nothing about what ships.

```bash
npm pack --pack-destination /tmp
```

Then, in a directory that has never held jen:

```bash
mkdir /tmp/proj && cd /tmp/proj && git init && npm init -y && npm i -D /tmp/reveer-jen-*.tgz && npx jen init
```

Work through the rest as an adopter does:

1. **Check what landed** — root `AGENTS.md`, the seven skills under `.claude/skills/` each carrying the stamp, `registry.yaml`, `.claude/settings.json`, and OpenSpec's own skills written beside jen's.
2. **Bind it** — run the `setup-jen` skill. Point it at a team that already carries the pipeline's statuses and labels, so every check reports already-satisfied and the run creates nothing on the tracker. A fresh team would exercise label *creation*, which is a mutation on a real tracker to validate documentation.
3. **Read the scaffold as an adopter receives it** — `registry.yaml` and root `AGENTS.md`. Nothing in this repository reads `scaffold/`, so this is the only place its text is ever checked against the model it is supposed to teach.
4. **Test the boundary** — edit one of the installed skills, run `npx jen update`, and confirm the edit is gone. Test it unstamped too: a file still in the payload is rewritten and re-stamped either way, and the README has to keep saying so.

A step that behaved differently from its description in `README.md` is a documentation defect, and fixing it is part of whatever change the run was validating.
