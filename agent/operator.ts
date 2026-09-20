#!/usr/bin/env node
/**
 * The operator: the program a person sits in front of while a tree of agents works.
 *
 * **It is the substrate's second executable and not a subcommand of anything.** `cli/` may
 * not import `agent/`, so a `jen agents` subcommand would have to reach across the boundary
 * `agent-substrate` draws; and the substrate is installed into an agent's image rather than
 * delivered through the CLI's package, so it needs its own name there regardless.
 *
 * **It is the first consumer `onMessage`, `onStalled` and `onFailure` have ever had.** Until
 * now the supervisor was reachable only from its own tests, and a component with no way to
 * run it is one whose behaviour is known through doubles.
 *
 * What it deliberately is not: a tree view, a persistence layer of its own, a command
 * language, or a way to address any agent but the root. Reaching an agent below the root
 * goes through its parent, exactly as it does for every agent in the tree — the person is a
 * participant in the message graph rather than an exception to it, which is the whole reason
 * the root is not structurally special.
 *
 * ## Four verbs and no fifth
 *
 * Start a run, speak to its root, watch what comes back, shut it down. In particular there
 * is no way to release a workspace: `destroy` ends a body and a workspace outlives it, a
 * run is ended for every reason including the ordinary one, and a shutdown that took
 * workspaces with it would destroy a day of work through the action a person takes to stop
 * for the day. A run's workspaces therefore outlive the run and removing them is the
 * person's own act — recorded in `agent/AGENTS.md` rather than left to be discovered.
 */
import { DockerSandboxDriver } from './sandbox/docker.ts';
import { parseRecord } from './record.ts';
import { describeStall, render, Store, Supervisor } from './supervisor/index.ts';

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const USAGE = `usage: jen-operator <store-root> <run> <record.json> [opening]

  store-root  where runs are kept
  run         which run to work in
  record.json the root agent's record
  opening     the first message, for a run that does not exist yet

Nothing here says whether to begin or to resume. An absent run is created from the record
and an existing one is recovered from its own records and transcripts, because a run is
resumed most often directly after it died — which is the moment a person is least equipped
to answer a question about it, and the store already holds the answer.`;

const [root, run, path, opening] = process.argv.slice(2);
if (root === undefined || run === undefined || path === undefined) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const record = parseRecord(JSON.parse(await readFile(path, 'utf8')), path);
const store = await Store.open(root, run);

/**
 * What the person is shown, rendered the way every other recipient's message is.
 *
 * `onMessage` is handed the raw message — it is the one delivery path in the substrate that
 * skips rendering — so a consumer printing `message.content` would show a person an
 * unescaped `[substrate] …` that a child could have quoted, which is the one forgery every
 * other recipient in the tree is protected from, at the recipient least able to ask the
 * substrate a follow-up question. `render` is exported for exactly this.
 *
 * **Only the root's words, and nothing from below it.** Visibility here is pull: a
 * transcript is large, a parent reads a child's through `read` when the child's prose does
 * not satisfy it, and an operator streaming every agent's output would reintroduce push
 * visibility at the one seam where a human is watching. What a person wants to know about a
 * descendant, they ask the root.
 */
const supervisor = new Supervisor({
  store,
  driver: new DockerSandboxDriver({ run }),
  onMessage: (message) => {
    process.stdout.write(`${render(message)}\n`);
  },
  // Reported, and nothing else: no agent is woken, messaged or ended on account of it.
  // Breaking a deadlock is a judgment about the work, and the person is who the substrate
  // has for that. The agents are named because of what the person does next: one shape
  // this takes is a root that has correctly asked a question, resolved by answering it,
  // and another is a child whose body ended, resolved by telling it to carry on or by
  // replacing it. `describeStall` is what keeps those two apart in one line.
  onStalled: (stalled) => {
    process.stderr.write(`[substrate] ${describeStall(run, stalled)}\n`);
  },
  // The substrate's own trouble, which no agent can act upon. Said, and the run carries on.
  onFailure: (agent, error) => {
    process.stderr.write(`[substrate] the run could not carry on for ${agent}: ${said(error)}\n`);
  },
});

/**
 * Ending ends bodies and keeps every workspace.
 *
 * Reached from four directions — the person's input ending, an interrupt, a termination, and
 * the fall-through at the end — and each of them is the ordinary way to stop for the day
 * rather than a way to discard the run. Guarded because two of them can arrive together: a
 * terminal sends `SIGINT` and the input ends behind it, and two shutdowns would race the
 * store closed underneath the first.
 *
 * **Registered before anything is provisioned**, which is the part worth stating. Starting a
 * run boots the root, and resuming one boots a body per `working` agent — a tree of ten is
 * ten `docker create`s, an image resolution on a cold machine, and all of it awaited. A
 * `SIGINT` arriving in that window with no handler yet gets Node's default: the process dies
 * at once, with however many containers it had already created still running and the store
 * never closed. Ctrl-C while a start is taking longer than expected is not an exotic case;
 * it is the same slowness that widens the window. Arriving this early costs nothing, because
 * `shutdown()` over no bodies is a store close.
 */
let stopping: Promise<void> | undefined;
const stop = (): Promise<void> => {
  stopping ??= supervisor
    .shutdown()
    .catch((error: unknown) => process.stderr.write(`[substrate] shutting down: ${said(error)}\n`))
    .then(() => {});
  return stopping;
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
}

/**
 * Begin or resume, decided from the store and from nothing the person said.
 *
 * `Store.open` creates the run's directory whether or not it was there, so the question is
 * asked of what is *in* it: a run with a root has been started before. An option saying
 * which mode to use is one that can be given wrongly, and given wrongly in the reviving
 * direction it would begin a second run over an existing one's records.
 *
 * `resume()` reports what it could not recover through `onFailure` and carries on with the
 * rest, which is its own behaviour rather than anything arranged here.
 */
if (store.root === null) {
  await supervisor.add(record, opening);
} else {
  // **The opening is not delivered again**, and that is the half of this worth stating.
  // Resuming a run is done by re-running the command that started it — that is the whole
  // point of nothing on the line saying which is happening — so honouring the opening here
  // would put a duplicate instruction into the root's mailbox every time, at the moment
  // after a crash when a person is least likely to notice a message they did not mean to
  // send twice. An opening is a run's first message and a resumed run has already had one.
  // Anything the person wants to say now is typed, and reaches the root by the ordinary
  // path.
  await supervisor.resume();
}

/**
 * The person's lines, delivered on the path a parent's message takes.
 *
 * `tell` posts into the root's mailbox and settles, which is the same two steps a message
 * from a parent to its child takes — so what a person types occupies the position the root's
 * parent occupies in its conversation, and the root cannot tell the difference. That is what
 * keeps the root from needing a channel no other agent has.
 *
 * One line is one message. There is no command language here and there must not be: a word
 * the operator interpreted would be a word the root could never be told.
 */
const typed = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of typed) {
  if (line.trim() === '') continue;
  try {
    await supervisor.tell(line);
  } catch (error) {
    process.stderr.write(`[substrate] that could not be delivered: ${said(error)}\n`);
  }
}

await stop();

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
