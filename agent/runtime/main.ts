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
import { transcribe } from './transcript.ts';
import { local } from './workspace.ts';
import { encode, lines, parseToAgent, type FromAgent } from '../protocol.ts';

import type { CapabilityResult } from './capability.ts';
import type { Raise, SupervisedCapability } from './supervised.ts';

/**
 * The capabilities this runtime asks the supervisor for.
 *
 * **Not all of them, since ENG-211.** `fs` and `exec` do their work in this process and
 * raise nothing, so they are built by `workspace.ts` from the record and composed into the
 * same list below. Where a capability's work happens is the only difference between the two
 * kinds, and `resolveCapabilities`, `dispatch` and the loop are all written not to know it.
 *
 * **Declarations and nothing else.** Each entry is a name, a description the model reads,
 * and a JSON Schema for its input; `supervised()` turns it into something `dispatch` cannot
 * tell from work done inside the sandbox. There is no `spawn` branch in the loop, in the
 * dispatcher or in the protocol — which is what keeps a runtime at depth four byte-identical
 * to the one nobody spawned. `send` and `await` were added as one entry here and nothing
 * else, and the diff that added them touched no other file under `runtime/`.
 *
 * **`read` is one entry here too, and it is the one that does something in place.** Its
 * `compose` fetches the transcript it asked for and writes it into this agent's workspace
 * before answering with the path — see `transcript.ts` for why the runtime is what writes
 * it. The loop, the dispatcher and the protocol still cannot tell it from `spawn`; what a
 * capability's own body does is not a thing any of the three can observe.
 *
 * **Registering is not granting.** `resolveCapabilities` builds an agent's registry from
 * its *record*, so an agent whose record does not name `spawn` is never offered it, and an
 * agent whose record does is offered the same declaration its parent was. The supervisor
 * checks the record again at the request boundary, because a schema is a guide to the model
 * and not a trust boundary — a raw frame reaches the supervisor without passing through any
 * of this.
 *
 * **The schemas are written for a reader who has only them.** A model choosing what to put
 * in `tools` cannot see the supervisor's subset rule, so the description says it; a model
 * that would otherwise send a whole model configuration is told that `model` is an
 * identifier and that the endpoint and credential are not its to choose. Every one of these
 * is enforced at the supervisor regardless. Saying it here is what makes a refusal rare
 * rather than what makes it safe.
 */
const SUPERVISED: SupervisedCapability[] = [
  {
    name: 'spawn',
    description:
      'Create a new agent below you and return its id, without waiting for it to do anything. ' +
      'Use it to delegate work you want done beside your own, and spawn several before you ' +
      'collect any of them. The child is an agent exactly like you: it reasons with a model, ' +
      'holds a workspace, and can spawn agents of its own if you grant it `spawn`. It reaches ' +
      'the same provider under the same credentials you do, and you never see or supply those. ' +
      'The id it returns is how you address the child afterwards.',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: 'What to call the child, for you and anyone reading the transcript.',
        },
        charter: {
          type: 'string',
          minLength: 1,
          description:
            'What the child is for. It becomes the first thing in its conversation and never ' +
            'changes, so write what would still be true at the end of its work.',
        },
        opening: {
          type: 'string',
          minLength: 1,
          description:
            'The first message to send it, as though you had sent it yourself. Leave this out ' +
            'to create the child without starting it; it waits until you address it.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          uniqueItems: true,
          description:
            'The capabilities the child may reach. Every one must be a capability you hold ' +
            'yourself — you can create an agent narrower than you or equal to you, never a ' +
            'wider one, and a name you do not hold is refused rather than dropped. Leaving ' +
            'this out grants none, including `spawn`. Withholding narrows a child rather ' +
            'than silencing it: one you do not grant `send` still reports to you when its ' +
            'turn ends, because reporting at a turn boundary is not a capability and cannot ' +
            'be withheld — what it loses is the ability to speak in the middle of its work. ' +
            'One capability depends on another to be worth anything: `read` answers with a ' +
            'path to a file in the child\'s own workspace rather than with the transcript, ' +
            'so a child granted `read` and no `fs` or `exec` is handed a location it has no ' +
            'way to open. Grant it a means of reading a file alongside `read`, or grant ' +
            'neither. ' +
            'And if what you want is a child that answers once and stops, write that in its ' +
            'charter: a grant says what a child may reach, not what shape its conversation ' +
            'with you should take.',
        },
        model: {
          type: 'string',
          minLength: 1,
          description:
            'Which model the child reasons with, as the provider spells it. Leave it out to ' +
            'give it yours. This is an identifier only: the provider, the endpoint and the ' +
            'credential are inherited from you and cannot be set here.',
        },
      },
      required: ['name', 'charter'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop',
    description:
      'Dismiss one of your own children, and with it every agent below that child. Their ' +
      'bodies end; their records, transcripts and workspaces are kept, so whatever they built ' +
      'is still there to read. A child that has reported to you is not finished — it is ' +
      'waiting, and stays available until you stop it. You can only stop your own children.',
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'The id of the child to dismiss, as `spawn` returned it.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    description:
      'Send a message to your parent or to one of your own children, and carry on working. ' +
      'Those are the only agents you can address — there is no channel to a sibling, and ' +
      'work that has to pass between two of your children passes through you. It is what ' +
      'lets you say something before your turn is over: a word to your parent while your ' +
      'own children are still out is this call and nothing else. It is ' +
      'fire-and-forget: it returns once the message has been stored for the other agent, ' +
      'not once that agent has read it, and it never waits for a reply. Waiting for one is ' +
      '`await`, and the two being separate calls is what lets you send to four children ' +
      'before you collect from any of them.',
    schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          minLength: 1,
          description:
            'Who to address: one of your children, by the id `spawn` returned, or your ' +
            'parent. If nobody spawned you, your parent is the human — address them as ' +
            '`human`, and what you say reaches a person by the same call and in the same ' +
            'shape it would reach an agent.',
        },
        content: {
          type: 'string',
          description:
            'What to say. It reaches the other agent as an ordinary message with your id on ' +
            'it, so it always knows the words are yours.',
        },
      },
      required: ['to', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'await',
    description:
      'Wait for the next message addressed to you, and return it. Whichever message arrives ' +
      'first is the one you get, whoever sent it — a child reporting, your parent asking for ' +
      'something else — and what you read names its sender, so you decide what to do about ' +
      'it once you can see who spoke. You cannot wait for a particular agent and you cannot ' +
      'set a deadline: this returns when a message arrives, and messages already waiting for ' +
      'you come back immediately.',
    schema: {
      type: 'object',
      properties: {
        keep: {
          type: 'integer',
          minimum: 0,
          description:
            'How long to keep your container while you wait, in milliseconds. This is about ' +
            'your body and not your memory. Letting the container go costs you nothing you ' +
            'know: you resume holding your whole conversation and everything in your ' +
            'workspace, and the only thing lost is whatever was still running inside the ' +
            'container — a process you started, work you had not written down. So name a ' +
            'small number when you expect an answer in a moment and want to keep something ' +
            'running across it, and name nothing at all for a wait that could last minutes ' +
            'or hours. Leaving it out is the ordinary case.',
        },
      },
      additionalProperties: false,
    },
    // Read from the model's own input, which is the only place it can come from without a
    // constant about an agent's body living somewhere no charter can reach. Guarded rather
    // than trusted: nothing validates a call's arguments against the schema, and a `keep`
    // that is not a duration would make the request frame itself unreadable at the
    // supervisor — an `await` that never returns instead of one that kept nothing.
    residency: (input) => {
      const keep = (input as { keep?: unknown }).keep;
      return typeof keep === 'number' && Number.isFinite(keep) && keep >= 0 ? keep : 0;
    },
  },
  {
    name: 'read',
    description:
      'Read the transcript of an agent below you: every message, every tool call, every ' +
      'result, and the reasoning the provider returned — what that agent actually did, ' +
      'rather than what it told you it did. A child that never ran the tests can still ' +
      'report that they passed, and this is how you check. Only your own descendants are ' +
      'readable — a child, a child of that child, anything below you — and never a sibling, ' +
      'never the agent that spawned you, never yourself. ' +
      'It does not return the transcript. It writes it into your workspace and answers with ' +
      'the path, because a transcript in a result would be re-sent to the model on every ' +
      'step you take afterwards, for the rest of your life, however long the transcript was. ' +
      'The file is JSONL — one JSON event per line, oldest first — so ask it the question ' +
      'you actually have: `grep` for a command you were told was run, `tail` for how the ' +
      'work ended, `jq` to pick the tool calls out. **You need `fs` or `exec` to open it**; ' +
      'without one of them this answers with a path you cannot read. ' +
      'It is a snapshot taken when you call, so an agent still working has moved on since; ' +
      'call again to refresh it, which replaces the file rather than adding another.',
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'The agent whose transcript to read, by the id `spawn` returned for it.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    compose: transcribe,
  },
];

/** One frame out, as one line. Every write in this file goes through here. */
function say(frame: FromAgent): void {
  process.stdout.write(encode(frame));
}

/**
 * The one way this process ends badly, and the only place a reason is written.
 *
 * Two callers, and they are the same event: an agent that cannot carry on. One is the boot
 * failure the outer `catch` has always handled. The other is a turn that threw part-way
 * through, which used to be recorded in a variable and said to nobody — and had nowhere
 * else to say it, because the supervisor holds a working agent's messages for a turn
 * boundary, so a runtime that kept reading after a failed turn was waiting for a frame that
 * only its own turn report could have caused. Ending is what reaches the parent: the body's
 * exit becomes a message the supervisor posts, and this line on standard error is the
 * account that message carries.
 *
 * **The order inside here is load-bearing, and the idempotence is what protects it.**
 * Destroying standard input while the `for await` over it is running makes that loop reject
 * with `ERR_STREAM_PREMATURE_CLOSE`, and that rejection reaches the outer `catch` — so a
 * path that destroyed first and reported afterwards would print *"Premature close"* where
 * the provider's reason belonged, handing a parent an account of how the process closed its
 * own input instead of why the agent stopped. The reason goes out before the destroy, and
 * the second call swallows what the destroy raises.
 */
let stopping = false;
function stop(reason: unknown): void {
  if (stopping) return;
  stopping = true;
  // The message, not the stack. Every failure that can reach here already names what it
  // could not read or could not resolve, and a stack trace above it buries that under
  // frames from inside this file. What reads these is a supervisor collecting stderr from a
  // process it started.
  process.stderr.write(`${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exitCode = 1;
  // **And the process has to actually end.** The channel is a pipe the supervisor is
  // holding open, and a read from it keeps this process alive on its own — so an agent that
  // failed would sit there having said what was wrong and never exit, which the supervisor
  // reads as an agent still working. Setting an exit code is not exiting.
  process.stdin.destroy();
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
    // Both sources, one list. `resolveCapabilities` selects from it by the record's `tools`
    // exactly as it did when there was only one source, so an agent granted neither `fs`
    // nor `exec` is offered neither and nothing else about it differs.
    capabilities: [
      ...SUPERVISED.map((declaration) => supervised(declaration, raise, frame.record)),
      ...local(frame.record),
    ],
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

  const take = (work: () => Promise<string>): void => {
    turns = turns.then(async () => {
      // **Not the failure guard this replaced.** That one held a diagnosis for a reader it
      // could not reach; this one declines to start work after the process has already
      // said why it is ending. A turn taken after `stop` would report a turn boundary on a
      // channel whose reader is about to be told the body ended — and a supervisor that
      // took that report would move the agent to `waiting` and read the exit as an agent
      // that had said its piece, which is the silence this whole change is about.
      if (stopping) return;
      try {
        // Zero, always. An agent at a turn boundary has asked for nothing about its body,
        // and saying so here is what keeps the supervisor from having a default to supply.
        say({ t: 'turn', message: await work(), residency: 0 });
      } catch (error) {
        // **What reaches here is the model client, and little else.** `dispatch` turns
        // every capability failure into an `ok: false` result the loop feeds back to the
        // model rather than throwing, so what escapes `run()` is a provider call that
        // failed past the SDK's retries — the 429 or 5xx this change is about.
        stop(error);
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
} catch (error) {
  // Including the `ERR_STREAM_PREMATURE_CLOSE` a failed turn's own destroy raises out of
  // the loop above, which arrives here after the reason has already been written and is
  // swallowed by the flag rather than printed over it.
  stop(error);
}
