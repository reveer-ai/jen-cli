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
- A model credential. The records below reach OpenRouter, so `OPENROUTER_API_TOKEN` in the
  environment you start the operator from. Any OpenAI-compatible endpoint works — the
  provider is a value on the record and not a commitment in code.

  **A key that authenticates is not a key that can pay, and the two fail differently.**
  `/api/v1/key` reports the key's own limit and says nothing about the account's balance;
  `/api/v1/credits` is what holds that. The runtime sets no `max_tokens`, so every request
  asks for the model's whole output window and OpenRouter refuses it up front when *that
  window* costs more than the balance left — `402 … you requested up to 65536 tokens, but
  can only afford 36320` — before a token is generated and before any agent reasons. The
  refusal is per-model, so a balance that cannot afford `claude-opus-5`'s window still runs
  `claude-haiku-4.5`'s, and a pass that switches models to get moving is watching a
  different model than the one it set out to. Check `/credits` before starting, and read a
  mid-run `402` the same way: *exceed your available credits given your current in-flight
  requests* is the concurrency form and settles on its own, *requires more credits, or fewer
  max_tokens* does not.

  **At fan-out it is concurrency and not usage that empties the account**, which is the
  form that surprises. Every in-flight request reserves its whole output window, so eleven
  `claude-opus-5` bodies at once reserve about $18 against whatever the balance actually is,
  and each one dies with the concurrency `402` while the spend to that point is a fraction
  of it. Budget a wide pass as *peak containers × the model's output window × its completion
  price*, not as what you expect it to cost. The tree does not spin when this happens — the
  revival bound holds each bodiless agent at one body per message — so what you see is a
  tree of agents recorded `working` with mail queued and almost no containers up, and the
  stall line naming them the moment the last body goes.
- For §3 only: `CLAUDE_OAUTH_TOKEN` in that same environment, which `claude setup-token`
  mints from a Claude subscription. **It must be a value an environment variable can
  carry.** `agent-sandbox` forbids a secret reaching a file, inside the sandbox or outside
  it, so there is no login-file fallback and this is the whole question §3 asks.

  **The two names each appear twice here and mean different things both times, so check
  which one you are reading.** The records' `ref` is the variable on *your* machine —
  `OPENROUTER_API_TOKEN`, `CLAUDE_OAUTH_TOKEN` — and their `name` is the variable inside
  the sandbox, where `claude` requires `CLAUDE_CODE_OAUTH_TOKEN` exactly. Getting the `ref`
  wrong fails at creation, in the credential prologue, before any agent runs: an unresolvable
  reference is refused rather than substituted, so the pass stops at the first record instead
  of part way through a tree.

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
  "credentials": [{ "name": "MODEL_API_KEY", "ref": "env:OPENROUTER_API_TOKEN" }],
  "parent": null
}
```

Then:

```bash
node agent/operator.ts ~/.jen live-1 chief.json \
  'Draft a complete employee handbook for a 200-person company, covering three areas: workplace policies, compensation and benefits, and IT and security practices. Each area is large — it has many distinct sections that different people would need to write.'
```

Type into it to answer the root; end its input to end the run. Watch a second terminal:

```bash
watch -n1 'docker ps --filter label=jen.run=live-1 --format "{{.Label \"jen.agent\"}} {{.Status}}"'
```

**The opening is chosen, and a different one can make the pass unanswerable.** Two things
about it are load-bearing, and both were learned by running something else first.

It asks for work the agent can do **from nothing**. A workspace is a fresh empty volume and
nothing mounts this repository, or any other, into it — so an opening that asks what "this
repository" builds asks the chief about something it has no way to look at, and what comes
back is a finding about the question.

And it asks for work that **nests**. Three independent questions decompose into three
self-contained pieces, and a chief that reads them correctly gives its children nothing:
run that way and both Opus-5 and Sonnet-5 fan out one level with every child `tools: []`,
Sonnet saying so in its own reasoning — *"since these are self-contained tasks needing no
further sub-spawning, I'll skip granting them spawn or extra tools."* That is the model
weighing the grant and declining, which is the criterion working; but it means depth 2 can
never be reached from that opening, and a reader following the document would write down
"fanned out one level and stopped" as a finding about the charter when it is a finding about
the question they were told to ask. The opening above produced 45 agents and 14 at depth 2
on the first run, with the chief granting `['spawn','send','await','read','stop']` downward
unprompted.

**Pick the subject carefully too.** An earlier attempt asked for sandbox-escape failure
modes; the provider refused two children under its content policy, and a provider refusal
arrives as an ordinary child report with nothing marking it as one — so the chief read the
refusals as truncated work and respawned into them. That is how one run reached ten children
and about $2.

**What each criterion looks like when it passes.** The structural ones are the tier's, and
seeing them here is confirmation rather than evidence:

| | Passing looks like |
|---|---|
| Depth ≥ 2 | `~/.jen/runs/live-1/agents/` holds an id of the form `live-chief-N-M`. Its `record.json` has `parent` set to `live-chief-N`, whose own parent is `live-chief`. **This is the criterion of the pass**, and it is the one a model can fail — but read a failure against the opening before reading it against the charter. Depth follows from work that genuinely nests; against work that does not, a chief which fans out one level and grants its children nothing has judged correctly, and that is a finding about what it was asked rather than about how it was told to lead. |
| Parallelism | `docker ps` shows two or more agents at once, each with its own container, while the chief's own is gone. |
| One messaging path | The chief's transcript shows `spawn`, `send` and `await` calls and nothing else reaching its children; your typed lines arrive in its transcript as `message` events with `from: "parent"`, exactly as a child's do. |
| Suspension | `docker ps` is **empty** whenever every agent is waiting — including while the chief waits for you. |
| No per-agent skill file | `grep -rl charter ~/.jen/runs/live-1/agents/*/record.json` finds every agent's purpose, and there is no other file anywhere that carries one. Children's charters were written by their parent, at run time. |
| One type throughout | Every `record.json`, the root's included, has the same keys. The root's `parent` is `null`; nothing else differs in kind. |
| Clean exit | After the operator ends: `docker ps -a --filter label=jen.run=live-1` is empty. `docker volume ls --filter label=jen.run=live-1` is **not** — see below. |

**Record as findings, not as assertions:** whether the chief chose to delegate; whether any
child chose to delegate further; how many children it ran at once; and anything it did that
the scripted tier could not have produced.

**And watch for a tree that has stopped without saying so**, which is not a criterion and is
the most valuable thing this pass has found. It looks like containers that stay up while
`docker stats` shows every one of them at 0%, no line added to any
`events.ndjson` for minutes, and the stored states still reading `working`. **The substrate
now says so itself**, which makes the silence the finding rather than the symptom. A stall is
reported when no live agent can make progress, and an agent whose body ended — or one that
cannot be given a body at all — counts as stopped rather than as work about to happen:
`[substrate] nothing in live-1 can make progress. stopped: …` names it on the operator's
standard error. Until that read existed, a tree stopped in any state but *waiting* said
nothing at all, and a single dead body kept the report from firing for the rest of the run.

Three causes of this shape have been found by a live pass, each fixed and tested: a body's
standard error with no reader, a write to a body awaited from inside the serial queue, and a
turn that failed inside a living body. So if you see the shape again **and the operator said
nothing**, it is a fourth cause and the most valuable thing this pass can bring back. What is
worth capturing is which agents were in which state, what `docker stats` said, and whether
anything was still being written.

## 2. Resume, and a body that dies

Both are asserted in the tier against the real runtime, so this is only worth doing to see
them happen with a model that is really thinking.

- **Resume.** While a child is mid-turn, `kill -9` the operator's process group
  (`kill -9 -$(pgrep -f 'operator.ts .*live-1')`; the pattern cannot carry the `~`, because
  the shell expanded it in the operator's argv and these quotes would preserve it here). Start the operator again with the
  **same command line** — nothing on it says begin or resume. The tree comes back from the
  store, the swept containers are replaced, and the work finishes. The model is not told;
  compare `~/.jen/runs/live-1/agents/<id>/events.ndjson` before and after and the earlier
  lines are unchanged.
- **A body that dies.** `docker rm --force $(docker ps -q --filter label=jen.agent=<child>)`
  while its parent is waiting. The parent is woken with a `[substrate] <id>'s body ended: …`
  message, which tells it the child's work is kept and that sending the child a message will
  have it carry on from where it stopped. **What it decides is the finding** — carry on,
  replace, escalate, give up — and it is the thing no test can assert.

  **Carrying on is the option to watch**, because it is the one that was not available before:
  an agent whose body ended used to be unreachable, so a parent told its child had stopped
  could only replace it and throw the work away. Watch for a child that continues from the
  same transcript and the same workspace rather than starting over — compare
  `~/.jen/runs/live-1/agents/<child>/events.ndjson` across the death and the earlier lines
  should still be there. Addressing it buys **one** body: if that one dies too, the parent has
  to say something again, and until it does the child reads as stopped, which is what puts the
  line above on standard error instead of leaving the tree quiet.

## 3. Does the assistant authenticate from the environment alone?

**Answered, and it costs nothing to repeat.** `claude` authenticates inside a container from
the environment alone, with no login file anywhere — confirmed through the substrate's own
credential path rather than through `docker run -e`: the value arrived by the sandbox's
standard-input prologue, `claude -p 'reply with the word ready'` answered `ready` with exit
0, and a filesystem scan found no `.credentials.json` and no `auth.json`. `agent-sandbox`'s
rule holds on the live path, which is the question this section exists to ask.

**The variable is `CLAUDE_CODE_OAUTH_TOKEN`, not `ANTHROPIC_API_KEY`.** That is worth more
than tidiness: an API key needs a paid API account, and this needs only a subscription,
because `claude setup-token` mints one from it. Add it to the record and tell the agent what
its image has:

```json
  "charter": "…\n\nYour image provides the `claude` command, run headlessly as `claude -p '<prompt>'`. Its credentials are already in your environment — you never supply one. Check it is there before you rely on it.",
  "credentials": [
    { "name": "MODEL_API_KEY", "ref": "env:OPENROUTER_API_TOKEN" },
    { "name": "CLAUDE_CODE_OAUTH_TOKEN", "ref": "env:CLAUDE_OAUTH_TOKEN" }
  ]
```

The `name` is what the variable is called *inside* the sandbox, where `claude` reads it; the
`ref` is where the value comes from on the machine running the operator. They need not match,
so `"ref": "env:WHATEVER_YOU_CALLED_IT"` works without renaming anything on the host.

The charter is where this belongs and nowhere else — `WORKSPACE_CHARTER` in
`runtime/workspace.ts` is the template, and it is a template *for the caller* rather than
something the runtime prepends. Which assistant an image holds is a thing the substrate may
not know.

Then ask the agent to run `claude -p 'reply with the word ready'` through `exec`, and read
its transcript.

- **It works** → record the variable it read and the version it ran, and the assistant half
  of ENG-194 is done. It did, on `2.1.277 (Claude Code)`.
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

That selects exactly the workspaces of `live-1` even if you have run the same record several
times: a workspace's name carries the run as well as the agent, so no two runs ever share one
and `jen.run` can only name the run that made it.

Read one first if you want to see what an agent actually built:

```bash
docker run --rm -v "$(docker volume ls -q --filter label=jen.run=live-1 --filter label=jen.agent=<id>):/w" busybox:stable ls -la /w
```

Both filters, because one agent id now names one workspace *per run*: with `jen.agent` alone
a second run of the same record returns two names and the `-v` argument becomes nonsense.

## Where the result goes

On the Linear issue, as a comment — the run's own findings, and anything it showed that the
automated tier cannot see. It is a record of what happened once, not a check that passes.
