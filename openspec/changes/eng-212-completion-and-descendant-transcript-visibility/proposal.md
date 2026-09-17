## Why

A parent cannot tell a crash, or a confident lie, from an answer. A child that never ran the
tests can still report "tests pass", and a field the child fills in is exactly as forgeable as
the prose beside it. The substrate's answer is that a parent can see everything its descendants
did — so it never has to take a child's word for anything.

The supervisor already holds that record and already serves it: ENG-213 built `read` at the
request boundary, descendant-only, in ranges, with a refusal that is distinguishable from an
empty transcript. What is missing is that **no agent can reach it.** The runtime declares
`spawn`, `stop`, `send` and `await`, and its own comment says "and where `read` will be." Until
it is declared there, the verification surface the epic rests on exists and is unreachable.

## What Changes

- **`read` becomes an agent-facing capability**, declared in the runtime's supervised set and
  offered to an agent if and only if its record names it. One entry in a list; no branch in the
  reasoning loop, the dispatcher, or the protocol.

- **A read writes the transcript into the caller's workspace and returns its path**, not its
  content. The agent-facing call is `read(id)` and nothing else. This is what makes the epic's
  test hold: reading a 50,000-token transcript must not put 50,000 tokens into the caller's
  context. Bytes crossing a pipe are free; bytes entering a model's context are not, and the
  parent then interrogates the file with the tools it already has — `grep -c 'npm test'` answers
  the question that matters for a handful of tokens.

- **`read` is the first capability that both raises a request and does work in place.** Today the
  substrate has two disjoint kinds: supervised capabilities that raise and do nothing locally,
  and workspace capabilities that work locally and raise nothing. `read` is both, and the spec
  says so rather than leaving a third shape undescribed.

- **Nothing is written unless a parent asks.** `read` stays pull. A child that finishes and is
  believed never has its transcript materialized anywhere.

- **The description says what withholding costs.** A parent granted `read` but no way to read
  files receives a path it cannot open, so `read`'s description and `spawn`'s guidance say so.

Not changing, and worth stating because each looks like scope and is already settled:
completion (a turn ending *is* the signal — there is no second channel to build), failure
reporting (the supervisor already synthesizes a termination into the parent's mailbox), reasoning
capture (`ReasoningEvent` already stores what the provider returns), and the supervisor's
authorization and range handling (ENG-213's, unchanged — the runtime uses the ranges to page the
file down without buffering it whole).

## Capabilities

### New Capabilities

None. Every behavior here belongs to a capability that already exists.

### Modified Capabilities

- `agent-runtime`: `read` is added to the record-selected capabilities the runtime declares, on
  the same terms as `spawn`, `stop`, `send` and `await`; a capability may do local work and raise
  a request in one invocation; a read's answer is written to the caller's workspace and the model
  is given the path rather than the transcript.

## Impact

- `agent/runtime/main.ts` — the `read` declaration, its schema and its description.
- `agent/runtime/supervised.ts` — a supervised capability may compose local work with its request.
- `agent/` — where the transcript is written and under what name.
- No change to `agent/supervisor/` behavior; its `read` handling, authorization and ranges stand
  as ENG-213 shipped them.
- An agent holding `read` without `fs` or `exec` can call it and cannot read the result. That is
  a grant the spawning agent chooses, made visible in the descriptions rather than prevented.
