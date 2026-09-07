---
"@reveer/jen": patch
---

The repository is now `reveer-ai/jen-cli`. The package is still `@reveer/jen` and the binary is still `jen` — only the repository moved, so nothing about installing or running jen changes.

`repository.url` in the manifest tracks the new name. That field is what `npm publish --provenance` attests against the workflow's own repository, so it is not cosmetic metadata: left stale it is a mismatch at publish time rather than a wrong link on the registry page.

GitHub redirects the old repository URL, so existing clones, links and the git remote keep working — but a redirect is a courtesy, not a binding, and anything that matched the old name exactly does not follow it. The npm trusted-publisher entry is the one that matters: it names owner, repository, workflow and environment, and a repository that no longer matches fails the OIDC exchange as a 404 naming the package.
