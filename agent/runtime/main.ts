#!/usr/bin/env node
/**
 * The substrate's entry point: the executable a sandbox starts, and the only way a runtime
 * is launched.
 *
 * **It is not a subcommand of `jen`.** `agent-substrate` forbids any module under `cli/`
 * importing one under `agent/`, and a `jen agent` subcommand would have to import this to
 * launch it. So the substrate declares its own executable in its own manifest, which is
 * also the shape it needs independently: this is installed into an agent's sandbox image
 * rather than delivered through the CLI's published package.
 *
 * **Nothing is read from argv.** The record and the log arrive together on standard input —
 * see `boot.ts` for why neither could travel any other way.
 *
 * **It is a peer on a channel rather than a program that prints a result.** It used to run
 * one turn and write `{ message, events }` as it exited, which was enough while there was
 * nothing to converse with. That shape cannot append a transcript as it happens, cannot
 * raise a request mid-turn, and cannot suspend without destroying the agent it is — an
 * entry point that speaks only by ending can say one thing, once.
 *
 * What is still deliberately not here: persisting the log, routing the message to the
 * parent, provisioning anything. Those are the supervisor's, and the supervisor is a
 * component this one must not grow into.
 */
import { readBootFrame } from './boot.ts';
import { Runtime } from './index.ts';
import { openAIClient } from './model.ts';
import { supervised } from './supervised.ts';
import { encode, lines, parseToAgent, type FromAgent } from '../protocol.ts';

import type { CapabilityResult } from './capability.ts';
import type { Raise, SupervisedCapability } from './supervised.ts';

/**
 * The capabilities this runtime asks the supervisor for.
 *
 * **Empty, and this is the seam rather than a placeholder.** `spawn` and `stop` are
 * ENG-197's, `send` and `await` are ENG-198's, `read` is ENG-212's; each arrives as one
 * entry here and nothing else in this file changes. Leaving it empty keeps the behaviour
 * `agent-runtime` specified — a record naming a capability fails construction rather than
 * starting an agent reduced — while settling the shape before five are written against it.
 */
const SUPERVISED: SupervisedCapability[] = [];

/** One frame out, as one line. Every write in this file goes through here. */
function say(frame: FromAgent): void {
  process.stdout.write(encode(frame));
}

try {
  const frame = await readBootFrame(process.stdin);

  /**
   * Requests raised and not yet answered, by id.
   *
   * A map rather than a single slot, because an agent may raise several before any is
   * answered — the model can call more than one capability in a step — and each answer has
   * to reach the one that is waiting for it. The id is the whole of the correlation.
   */
  const outstanding = new Map<string, (result: CapabilityResult) => void>();
  let raised = 0;

  const raise: Raise = (kind, input, residency) =>
    new Promise<CapabilityResult>((resolve) => {
      const id = `${frame.record.id}:${++raised}`;
      // Registered before the frame goes out, because the answer can arrive on the next
      // tick and an answer to a request nobody is waiting for is an answer dropped.
      outstanding.set(id, resolve);
      say({ t: 'request', id, kind, input, residency });
    });

  const runtime = new Runtime({
    record: frame.record,
    events: frame.events,
    capabilities: SUPERVISED.map((declaration) => supervised(declaration, raise)),
    client: openAIClient(frame.record),
    emit: (event) => say({ t: 'event', event }),
  });

  /**
   * Turns, one after another.
   *
   * A message that arrives mid-turn is queued onto this rather than starting a turn beside
   * the one running: an in-flight turn is not interrupted by a message's arrival. The
   * supervisor holds messages for a working agent as well, so this is the second of two
   * guards rather than the only one — and it is the one that holds if the first is ever
   * relaxed.
   */
  let turns = Promise.resolve();
  let failure: unknown;

  const take = (work: () => Promise<string>): void => {
    turns = turns.then(async () => {
      if (failure !== undefined) return;
      try {
        // Zero, always. An agent at a turn boundary has asked for nothing about its body,
        // and saying so here is what keeps the supervisor from having a default to supply.
        say({ t: 'turn', message: await work(), residency: 0 });
      } catch (error) {
        failure = error;
      }
    });
  };

  /**
   * Whether a step is owed is the boot frame's to say, and this is worth knowing why.
   *
   * It used to be read from the log here: something is owed when an input sits after the
   * `usage` that closed the last step. That is right for two of the three logs a body can
   * boot on and silently wrong for the third. An agent suspended on `await` and one killed
   * mid-call both leave a call with no result, and both get an answer — the supervisor's or
   * `answerInterrupted`'s — so both read as owing a step. The third is an agent whose turn
   * *ended* in a step the supervisor never heard the end of: its log ends at a `usage` with
   * nothing after it, which is the same shape as a log at a turn boundary, and the predicate
   * said wait. Nothing was ever going to arrive. The agent sat in a live container having
   * emitted nothing, its stored state still saying `working`, every message addressed to it
   * held for the boundary it would never reach — a tree stopped, with nothing reported
   * anywhere.
   *
   * Which of the three this is lives in the supervisor's stored state, and the design put it
   * there precisely because the log cannot carry it. A predicate here was inferring the one
   * thing the design says is not inferable.
   *
   * **This is still not a flag that means "was resumed".** It is set for an ordinary
   * delivery to a dormant agent, which is the common case and no more a resumption than any
   * other message; it is unset for a body woken at a boundary, resumed or not. Nothing here
   * has a resume path either way: there is one entry — `run()` — and it works from wherever
   * the log stands, which is the property that mattered.
   */
  if (frame.owed) take(() => runtime.run());

  for await (const line of lines(process.stdin)) {
    if (failure !== undefined) break;

    let received;
    try {
      received = parseToAgent(line);
    } catch (error) {
      // The supervisor's own frame, unreadable. Said on stderr and not on the channel:
      // answering a frame we could not read with a frame of our own is how two peers talk
      // past each other forever.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }

    if (received.t === 'stop') break;

    if (received.t === 'answer') {
      const waiting = outstanding.get(received.id);
      outstanding.delete(received.id);
      waiting?.({ content: received.content, ok: received.ok });
      continue;
    }

    if (received.t === 'message') {
      const content = received.content;
      take(() => runtime.turn(content));
      continue;
    }

    process.stderr.write(`the supervisor could not read a frame: ${received.reason}\n`);
  }

  await turns;
  if (failure !== undefined) throw failure;
} catch (error) {
  // The message, not the stack. Every failure that can reach here already names what it
  // could not read or could not resolve, and a stack trace above it buries that under
  // frames from inside this file. What reads these is a supervisor collecting stderr from a
  // process it started.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  // **And the process has to actually end.** The channel is a pipe the supervisor is
  // holding open, and a read from it keeps this process alive on its own — so an agent that
  // failed to boot would sit there having said what was wrong and never exit, which the
  // supervisor reads as an agent still working. Setting an exit code is not exiting.
  process.stdin.destroy();
}
