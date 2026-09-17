## 1. Adapter contract

- [ ] 1.1 Define neutral request, allowed workspace operations, progress, usage, success/failure result, and handle interfaces under `agent/` with no provider-specific fields.
- [ ] 1.2 Implement a deterministic non-Claude adapter that supports progress, results, and a controllable stop; test that the same contract accepts both implementations.

## 2. Claude Code adapter

- [ ] 2.1 Start Claude Code headlessly in the caller's workspace, translating abstract operation grants into an explicit allowed-tool set and passing only the required credential through the child environment.
- [ ] 2.2 Parse streamed output into neutral progress, result, and observed usage; test success, reported error, malformed or missing final result, and process failure with a stub executable.
- [ ] 2.3 Implement idempotent stop that ends the process tree and progress stream, waits for exit, and preserves a result already settled; verify release of a resource held by a live stub child.

## 3. Runtime capability and verification

- [ ] 3.1 Compose a local `assistant` capability at runtime boot and grant it only from the agent record, with no change to the reasoning loop or dispatcher; bridge the adapter result and abort signal to normal capability behavior.
- [ ] 3.2 Exercise a complete agent turn through the ordinary capability path with the non-Claude adapter, including a record that withholds `assistant` and an agent at non-root depth.
- [ ] 3.3 Run the substrate typecheck and relevant tests, and verify that adapter arguments, result, and transcript contain no credential value.
