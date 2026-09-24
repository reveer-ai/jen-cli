---
"@reveer/jen": minor
---

`jen run` and `jen watch` are removed, along with every option only they took (`--dry-run`, `--team`, `--project`, `--concurrency`, `--issue-page`, `--comment-page`, `--transcripts`, `--interval`). Invoking either now reports `Unknown command`. The GitHub App role identities they ran stages under, the `JEN_GH_*` and `LINEAR_API_KEY` environment they read, and the `On Pause` project halt go with them. None of it was ever used. `jen init`, `jen update`, `--help` and `--version` are unchanged.

The `setup-jen` skill is no longer shipped, and `jen update` removes the stamped copy from a project that has one. Fill in `registry.yaml` by hand instead. The stub no longer describes identity entries, and an existing project's own `registry.yaml` is left alone, as it always is.

`yaml` is no longer a runtime dependency.
