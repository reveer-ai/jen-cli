## 1. The agent image

- [ ] 1.1 Write `agent/.dockerignore` excluding `node_modules` and anything else that must not enter the build context, and confirm the context size is small enough that a rebuild is quick
- [ ] 1.2 Write `agent/Dockerfile`: a pinned base carrying a language runtime new enough to execute the substrate's TypeScript directly, the substrate copied in and installed so its agent entry point resolves by name, and its dependencies installed from the substrate's own manifest
- [ ] 1.3 Add the build-time check that the agent entry point *executes* — invoked with its input closed, required to exit non-zero with its own boot-frame error — and verify by hand that the build fails when a dependency is removed
- [ ] 1.4 Install a pinned headless coding assistant in the image and check it runs without a credential; confirm it appears nowhere in `agent/package.json`
- [ ] 1.5 Confirm the built image carries no credential in any layer or in its configuration, and that nothing in the build takes one as an argument
- [ ] 1.6 Build the image and provision one agent into it by hand, confirming the runtime boots, reads its frame, and reaches its model endpoint

## 2. The scripted model gateway

- [ ] 2.1 Write a small OpenAI-compatible server serving `POST /v1/chat/completions` and nothing else, dispatching on the request's model identifier
- [ ] 2.2 Register the sequences the acceptance run needs — one that spawns, sends and awaits; one that spawns once more; one leaf that ends its turn with a message — keyed by identifiers records name
- [ ] 2.3 Confirm a container reaches it on the host, and make the acceptance tier fail in its setup with a message naming this when it cannot, rather than failing inside a model call
- [ ] 2.4 Confirm the runtime's own source is unchanged by any of it — no branch, no environment variable, nothing `policy.test.ts` would find

## 3. The operator

- [ ] 3.1 Write the operator's entry point and declare it in the substrate's manifest beside the agent entry point
- [ ] 3.2 Construct a supervisor over the container driver from a root record, and decide from the run directory alone whether to add the root or recover the run — with nothing in the operator's inputs selecting between them
- [ ] 3.3 Show the person what the root says, rendered as any recipient's message is, so a child quoting the substrate's mark cannot be read as the substrate speaking
- [ ] 3.4 Read the person's input and deliver it to the root on the same path a parent's message takes
- [ ] 3.5 Report a stalled run naming the agents that are waiting, and report the substrate's own failures, resolving neither
- [ ] 3.6 End the run's sandboxes on shutdown and release no workspace; confirm by hand that a run ended this way can be taken up again with its work intact
- [ ] 3.7 Confirm the operator shows nothing from agents below the root

## 4. The acceptance run

- [ ] 4.1 Write the tier's setup: require a container runtime and the gateway, build or require the image, label everything with the run, and sweep containers *and* this tier's own volumes afterwards
- [ ] 4.2 Assert the real runtime boots in a real container, takes a turn, and reports it
- [ ] 4.3 Assert an agent spawns an agent that itself spawns — depth ≥ 2 through the real runtime
- [ ] 4.4 Assert two children are in flight at once, each in its own workspace, neither seeing the other's
- [ ] 4.5 Assert a child whose container is killed out from under it wakes its parent with a termination message rather than leaving it awaiting one
- [ ] 4.6 Assert the operator's process group killed mid-run comes back from records and transcripts alone and finishes the work, with each agent continuing from where it suspended
- [ ] 4.7 Assert the run leaves no container behind, and that its workspaces survived until the tier released them itself
- [ ] 4.8 Run the tier repeatedly to confirm it is deterministic, and fix or remove any assertion that is not

## 5. Fixes the run finds

- [ ] 5.1 Fix what the run breaks, keeping each fix to what the run actually demonstrated; where a fix changes a requirement, add a delta to the capability it belongs to rather than editing a spec in place
- [ ] 5.2 Record whether the supervisor's unbounded provisioning retry costs anything real — the question `supervisor/AGENTS.md` defers to this run — as a finding, without adding a backoff, a ceiling or any other constant to the supervisor

## 6. The live pass

- [ ] 6.1 Write down how to perform the live pass: the records, the credentials it needs, what to watch, and what each criterion looks like when it passes
- [ ] 6.2 Run it against real models with charters rather than scripts, and record whether an agent reaches depth 2 by its own judgment — as a finding, not an assertion
- [ ] 6.3 Verify a headless coding assistant authenticates inside a container from its environment alone, with no login file; if it cannot, record exactly how it failed and raise it as its own task rather than reaching for a file
- [ ] 6.4 Record the result of the live pass on the task, including anything it found that the automated tier cannot see

## 7. Notes and verification

- [ ] 7.1 Record in `agent/AGENTS.md` what the first real run taught, including that a run's workspaces outlive it and their removal is the person's, and that reaching a host service from a container is configured differently outside Docker Desktop
- [ ] 7.2 Run the substrate's typecheck and its full test suite, including both tiers that need a container runtime, and report which were actually run rather than reporting the ones that could be
- [ ] 7.3 Confirm the repository's own manifest, TypeScript configuration, test configuration, CI workflow and published tarball are unchanged on the substrate's account
- [ ] 7.4 Run `openspec validate --strict` on the change
