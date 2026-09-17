## 1. Let a supervised capability compose local work with its request

- [x] 1.1 Extend `SupervisedCapability` so a declaration may act on the supervisor's answer before the result reaches the loop, and may raise more than one request within a single invocation. Keep `supervised()` generic — it must not learn what `read` is.
- [x] 1.2 Confirm nothing in `loop.ts`, `capability.ts` or `protocol.ts` needs to change for a composing capability to dispatch, and that a declaration without the new hook behaves exactly as before.

## 2. Fetch a transcript and write it to the workspace

- [x] 2.1 Add the module that turns a `read` answer into a file: request the target's transcript from the supervisor, page it with the wire's `from`/`count` so the whole log is never held at once, and write it as JSONL to `.transcripts/<id>.jsonl` under the record's workspace.
- [x] 2.2 Write each page as it arrives rather than accumulating and writing once, and replace any previous transcript for that target so a repeated read leaves exactly one file.
- [x] 2.3 Preserve every stored event verbatim, reasoning `opaque` payloads included — nothing selected, elided or summarized.
- [x] 2.4 Return a failed result naming what happened when the write fails, and let the agent continue. A supervisor refusal passes through as a failed result unchanged.

## 3. Declare `read` to the model

- [x] 3.1 Add the `read` entry to `main.ts`'s `SUPERVISED` list with input schema `{ id }` and nothing else — no offset, count or bound the model supplies.
- [x] 3.2 Write `read`'s description: that it answers with a location in the workspace rather than the transcript itself, that the file is JSONL and one event per line, that it is a snapshot as of the call and re-reading refreshes it, that only descendants can be read, and that the answer is unusable without `fs` or `exec`.
- [x] 3.3 Extend `spawn`'s `tools` description so a model granting `read` is told it must grant a means of reading a file alongside it.

## 4. Tests

- [x] 4.1 A record naming `read` is offered it; a record not naming it is not, on the same runtime.
- [x] 4.2 The result names a location and does not carry the transcript's events.
- [x] 4.3 A transcript far larger than a result may carry is written whole, while what the model receives stays bounded by the location.
- [x] 4.4 Reading the same descendant twice leaves one file, holding the transcript as most recently fetched.
- [x] 4.5 A reasoning event with an `opaque` payload survives into the file unchanged.
- [x] 4.6 A failed write returns a failed result naming the reason, the agent continues, and the transcript is still readable afterwards.
- [x] 4.7 A read of a non-descendant reaches the model as a normal failed result and the turn continues.
- [x] 4.8 A composing capability is dispatched by the same path as every other, with nothing in the loop, dispatcher or protocol distinguishing it.

## 5. Checks and notes

- [x] 5.1 Run the substrate's typecheck, lint and build, then the full suite as a regression net.
- [x] 5.2 Add to `agent/AGENTS.md` only what a future session would otherwise rediscover the hard way — the workspace being a named volume the supervisor cannot reach is the candidate. Skip it if nothing clears the bar.
