# The live pass

The automated tier (`acceptance.test.ts`) proves the substrate. This proves the two things
it deliberately cannot: that a **model** decides for itself to delegate when a charter asks
it to, and that a **coding assistant** authenticates inside a sandbox from its environment
alone. Both cost tokens, neither can be asserted without making a test depend on reasoning,
and both need a person watching. So this is a procedure and a place to write down what
happened, rather than a suite.

Nothing in the automated tier runs a model or an assistant. If this pass fails, every
structural criterion is unaffected.

## What you need

- A container runtime, and the image: `docker build --tag jen/agent:latest agent`.
- A model credential. The records below reach OpenRouter, so `OPENROUTER_API_KEY` in the
  environment you start the operator from. Any OpenAI-compatible endpoint works — the
  provider is a value on the record and not a commitment in code.
- For §3 only: whatever the image's assistant authenticates with, in that same environment.
  **It must be a value an environment variable can carry.** `agent-sandbox` forbids a secret
  reaching a file, inside the sandbox or outside it, so there is no login-file fallback and
  this is the whole question §3 asks.

Credentials reach an agent by *reference*: the record names a variable, the operator's own
environment holds the value, and the sandbox writes it onto each process's standard input as
that process starts. Nothing is in an argument, in a file, or in the container's
configuration. A record is inert and is safe to keep beside the project.

## 1. A tree that decides to delegate

Write `chief.json`, adjusting the model identifiers to what your provider spells:

```json
{
  "id": "live-chief",
  "name": "chief",
  "charter": "You lead a small team. Work you can hand off, hand off: spawn an agent for each piece, give it a charter that would still be true at the end of its work, and collect what they report. Do not do their work yourself. When you have everything, answer the person who asked.",
  "model": {
    "provider": "openrouter",
    "baseURL": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-opus-5",
    "credential": "MODEL_API_KEY"
  },
  "workspace": "/workspace",
  "environment": "jen/agent:latest",
  "tools": ["spawn", "await", "send", "stop", "read", "fs", "exec"],
  "credentials": [{ "name": "MODEL_API_KEY", "ref": "env:OPENROUTER_API_KEY" }],
  "parent": null
}
```

Then:

```bash
node agent/operator.ts ~/.jen live-1 chief.json \
  'Find out what this repository builds, how it is tested, and what its riskiest untested area is. Three separate questions — do not answer them yourself.'
```

Type into it to answer the root; end its input to end the run. Watch a second terminal:

```bash
watch -n1 'docker ps --filter label=jen.run=live-1 --format "{{.Label \"jen.agent\"}} {{.Status}}"'
```

**What each criterion looks like when it passes.** The structural ones are the tier's, and
seeing them here is confirmation rather than evidence:

| | Passing looks like |
|---|---|
| Depth ≥ 2 | `~/.jen/runs/live-1/agents/` holds an id of the form `live-chief-N-M`. Its `record.json` has `parent` set to `live-chief-N`, whose own parent is `live-chief`. **This is the criterion of the pass**, and it is the one a model can fail: a chief that did the work itself, or fanned out one level and stopped, is a finding about the charter rather than about the substrate. |
| Parallelism | `docker ps` shows two or more agents at once, each with its own container, while the chief's own is gone. |
| One messaging path | The chief's transcript shows `spawn`, `send` and `await` calls and nothing else reaching its children; your typed lines arrive in its transcript as `message` events with `from: "parent"`, exactly as a child's do. |
| Suspension | `docker ps` is **empty** whenever every agent is waiting — including while the chief waits for you. |
| No per-agent skill file | `grep -rl charter ~/.jen/runs/live-1/agents/*/record.json` finds every agent's purpose, and there is no other file anywhere that carries one. Children's charters were written by their parent, at run time. |
| One type throughout | Every `record.json`, the root's included, has the same keys. The root's `parent` is `null`; nothing else differs in kind. |
| Clean exit | After the operator ends: `docker ps -a --filter label=jen.run=live-1` is empty. `docker volume ls --filter label=jen.run=live-1` is **not** — see below. |

**Record as findings, not as assertions:** whether the chief chose to delegate; whether any
child chose to delegate further; how many children it ran at once; and anything it did that
the scripted tier could not have produced.

## 2. Resume, and a body that dies

Both are asserted in the tier against the real runtime, so this is only worth doing to see
them happen with a model that is really thinking.

- **Resume.** While a child is mid-turn, `kill -9` the operator's process group
  (`kill -9 -$(pgrep -f 'operator.ts ~/.jen live-1')`). Start the operator again with the
  **same command line** — nothing on it says begin or resume. The tree comes back from the
  store, the swept containers are replaced, and the work finishes. The model is not told;
  compare `~/.jen/runs/live-1/agents/<id>/events.ndjson` before and after and the earlier
  lines are unchanged.
- **A body that dies.** `docker rm --force $(docker ps -q --filter label=jen.agent=<child>)`
  while its parent is waiting. The parent is woken with a `[substrate] <id> terminated: …`
  message and decides what to do. **What it decides is the finding** — retry, replace,
  escalate, give up — and it is the thing no test can assert.

## 3. Does the assistant authenticate from the environment alone?

The one open question this pass exists to answer. Add the assistant's credential to the
record and tell the agent what its image has:

```json
  "charter": "…\n\nYour image provides the `claude` command, run headlessly as `claude -p '<prompt>'`. Its credentials are already in your environment — you never supply one. Check it is there before you rely on it.",
  "credentials": [
    { "name": "MODEL_API_KEY", "ref": "env:OPENROUTER_API_KEY" },
    { "name": "ANTHROPIC_API_KEY", "ref": "env:ANTHROPIC_API_KEY" }
  ]
```

The charter is where this belongs and nowhere else — `WORKSPACE_CHARTER` in
`runtime/workspace.ts` is the template, and it is a template *for the caller* rather than
something the runtime prepends. Which assistant an image holds is a thing the substrate may
not know.

Then ask the agent to run `claude -p 'reply with the word ready'` through `exec`, and read
its transcript.

- **It works** → record the variable it read and the version it ran, and the assistant half
  of ENG-194 is done.
- **It does not** → record the exact failure, verbatim. **Do not reach for a login file.**
  `agent-sandbox` forbids a secret reaching a file and leaves no fallback, so this becomes
  its own task rather than a workaround, and nothing else in the substrate depends on it.
  Codex is deliberately not installed for the same reason: its only documented headless path
  is an API key, and a subscription authenticates through a refreshed `~/.codex/auth.json`,
  which that rule forbids. Revisit if it ships an environment-variable path.

## Afterwards: the workspaces are yours

A run's workspaces outlive the run, on purpose, and nothing in the substrate deletes one.
The operator has no verb for it either. When you are done with a live run:

```bash
docker volume ls --filter label=jen.run=live-1 --format '{{.Name}}' | xargs -r docker volume rm
```

Read one first if you want to see what an agent actually built:

```bash
docker run --rm -v "$(docker volume ls -q --filter label=jen.agent=<id>):/w" busybox:stable ls -la /w
```

## Where the result goes

On the Linear issue, as a comment — the run's own findings, and anything it showed that the
automated tier cannot see. It is a record of what happened once, not a check that passes.
