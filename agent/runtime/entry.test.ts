/**
 * The program, end to end: a boot frame in on standard input, a conversation over the
 * channel that remains, a real turn against a real OpenAI-compatible endpoint.
 *
 * Everything else here runs the loop against a scripted client, which is right for the
 * properties those tests are about. It leaves one seam untested — the client itself, and
 * what it carries out of a completion — and that seam is the one place a mistake would be
 * invisible to every other test in this directory. So this runs the real entry point as a
 * real subprocess against a local server speaking the provider's wire format.
 *
 * A local server rather than a live model: the wire format is what is under test, and a
 * live model would make it non-deterministic for reasons unrelated to any of it.
 *
 * The test is the supervisor's half of the channel, played by hand. It is not the scripted
 * peer the supervisor's own suite uses — that one stands in for a *runtime*, and this one
 * stands in for the supervisor, so they face each other rather than overlapping.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { encode, lines, parseFromAgent, type FromAgent, type ToAgent } from '../protocol.ts';

import type { AddressInfo } from 'node:net';
import type { Event } from './events.ts';

const ENTRY = join(import.meta.dirname, 'main.ts');

/** Every request body the stub received, in order. */
let received: Record<string, unknown>[] = [];
let server: Server;
let baseURL = '';

/**
 * What the stub replies with. An ordinary message unless a test says otherwise.
 *
 * `refusal` and `annotations` are here because OpenAI puts them on an ordinary reply, and a
 * stub tidier than the thing it stands for is a stub that cannot fail. This one omitted
 * them, and the rule that mistook every unprojected field for the provider's reasoning
 * passed this suite all the way to review while writing phantom reasoning events and
 * echoing `annotations` back at whatever gateway `baseURL` named.
 */
const ORDINARY = {
  role: 'assistant',
  content: 'There is nothing here but thought.',
  refusal: null,
  annotations: [],
};

/** Replies in order; the last one stands for every request after it. */
let replies: Record<string, unknown>[] = [ORDINARY];

function reply(): Record<string, unknown> {
  return replies[Math.min(received.length - 1, replies.length - 1)] ?? ORDINARY;
}

/** One completion carrying the reply whole, as a gateway answers a request that did not stream. */
function completion(): string {
  return JSON.stringify({
    id: 'c-1',
    object: 'chat.completion',
    created: 1,
    model: 'stub-model',
    choices: [{ index: 0, message: reply(), finish_reason: 'stop' }],
    usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
  });
}

/**
 * The same reply streamed, one delta per field, ending the way a gateway ends.
 *
 * The runtime does not ask for this and the reason it does not is in `model.ts`: the SDK's
 * accumulator overwrites every field outside the standard set with each successive delta, so
 * a streamed extension arrives as its last piece. Serving it keeps the stub honest — a
 * process that starts streaming again meets what the wire really does, here as well as in
 * `model.test.ts`, rather than a stub tidy enough to pass either way.
 */
function streamed(): string {
  const head = { id: 'c-1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
  const standard = new Set(['role', 'content', 'refusal', 'function_call', 'tool_calls', 'audio']);
  const first: Record<string, unknown> = {};
  const rest: Record<string, unknown>[] = [];

  for (const [key, value] of Object.entries(reply())) {
    if (standard.has(key)) first[key] = value;
    else if (typeof value === 'string') {
      for (const character of value) rest.push({ [key]: character });
      rest.push({ [key]: null });
    } else rest.push({ [key]: value });
  }

  return [
    ...[first, ...rest].map(
      (delta) => `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason: null }] })}`,
    ),
    `data: ${JSON.stringify({
      ...head,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
    })}`,
    'data: [DONE]',
    '',
    '',
  ].join('\n\n');
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      const sent = JSON.parse(body) as { stream?: boolean };
      received.push({ path: request.url, authorization: request.headers.authorization, body: sent });

      if (sent.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(streamed());
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(completion());
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  replies = [ORDINARY];
});

/**
 * The supervisor's half of the channel: writes frames in, reads frames out, and can wait
 * for the process to have said something without polling for it.
 */
class Peer {
  readonly frames: FromAgent[] = [];
  stderr = '';
  readonly exit: Promise<number>;
  readonly #child: ChildProcess;
  #woken: (() => void)[] = [];
  #ended = false;

  constructor(boot: string, environment: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...environment } });
    this.#child = child;
    child.stdin?.write(boot);
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));

    this.exit = new Promise<number>((resolve) =>
      child.on('close', (code) => {
        this.#ended = true;
        this.#wake();
        resolve(code ?? 0);
      }),
    );

    void (async () => {
      for await (const line of lines(child.stdout!)) {
        this.frames.push(parseFromAgent(line));
        this.#wake();
      }
    })();
  }

  get running(): boolean {
    return !this.#ended;
  }

  #wake(): void {
    for (const wake of this.#woken.splice(0)) wake();
  }

  write(frame: ToAgent): void {
    this.raw(encode(frame));
  }

  /** Whatever the test wants on the wire, including something that is not a frame at all. */
  raw(line: string): void {
    this.#child.stdin?.write(line);
  }

  /** Everything the agent has emitted as its transcript, in the order it emitted it. */
  get events(): Event[] {
    return this.frames.flatMap((frame) => (frame.t === 'event' ? [frame.event] : []));
  }

  get turns(): string[] {
    return this.frames.flatMap((frame) => (frame.t === 'turn' ? [frame.message] : []));
  }

  async until(satisfied: () => boolean): Promise<void> {
    // A deadline that *rejects*, rather than one that throws out of a timer callback where
    // nothing is waiting for it: a hung expectation has to fail the test saying what the
    // agent had actually said, not hang the run until the suite's own timeout.
    const started = Date.now();
    while (!satisfied()) {
      if (Date.now() - started > 15_000 || this.#ended) {
        throw new Error(
          `${this.#ended ? 'the agent ended first' : 'the agent never got there'}. ` +
            `frames: ${JSON.stringify(this.frames)} stderr: ${this.stderr}`,
        );
      }
      await Promise.race([
        new Promise<void>((wake) => this.#woken.push(wake)),
        new Promise<void>((wake) => setTimeout(wake, 250)),
      ]);
    }
  }

  /** Give it a message and wait for the turn it ends with. */
  async tell(content: string): Promise<string> {
    const before = this.turns.length;
    this.write({ t: 'message', content });
    await this.until(() => this.turns.length > before);
    return this.turns[before]!;
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }

  async stop(): Promise<number> {
    this.write({ t: 'stop' });
    return this.exit;
  }
}

function frameFor(overrides: Parameters<typeof aRecord>[0] = {}, events: unknown[] = [], owed = false): string {
  const record = aRecord({ model: { ...aRecord().model, baseURL, model: 'stub-model' }, ...overrides });
  return `${JSON.stringify({ record, events, owed })}\n`;
}

function start(overrides: Parameters<typeof aRecord>[0] = {}, events: unknown[] = [], owed = false): Peer {
  return new Peer(frameFor(overrides, events, owed), { MODEL_API_KEY: 'sk-stub' });
}

describe('an agent that thinks and does nothing else', () => {
  it('boots, takes a turn on a message, and reports it without ending', async () => {
    const peer = start();

    expect(await peer.tell('Say something.')).toBe('There is nothing here but thought.');
    // The whole of what the rewrite is for: a turn ended and the agent is still there.
    expect(peer.running).toBe(true);

    expect(await peer.tell('Again.')).toBe('There is nothing here but thought.');
    expect(await peer.stop()).toBe(0);
    expect(peer.stderr).toBe('');
  });

  it('reports the turn carrying no instruction about its body', async () => {
    const peer = start();
    await peer.tell('Say something.');

    // Zero is the absence of a request, expressed by the runtime rather than left for the
    // supervisor to supply — a default chosen there would be policy about an agent's body
    // living somewhere no charter can reach.
    expect(peer.frames.filter((frame) => frame.t === 'turn')).toEqual([
      { t: 'turn', message: 'There is nothing here but thought.', residency: 0 },
    ]);
    await peer.stop();
  });

  it('emits its transcript as it happens rather than when it stops', async () => {
    const peer = start();
    await peer.tell('Say something.');

    expect(peer.events.map((event) => event.type)).toEqual(['charter', 'message', 'message', 'usage']);
    // Emitted before the turn was reported, which is what "as it happens" has to mean for a
    // process that may be killed at any moment.
    expect(peer.frames.map((frame) => frame.t)).toEqual(['event', 'event', 'event', 'event', 'turn']);
    await peer.stop();
  });

  it('sends the charter and offers no tools, because its record names none', async () => {
    const peer = start();
    await peer.tell('Say something.');

    const sent = received[0]?.body as { messages: { role: string; content: string }[]; tools?: unknown };
    expect(sent.messages).toEqual([
      { role: 'system', content: aRecord().charter },
      { role: 'user', content: 'Say something.' },
    ]);
    expect(sent.tools).toBeUndefined();
    await peer.stop();
  });

  it('authenticates with the credential the record named, taken from the environment', async () => {
    const peer = start();
    await peer.tell('Say something.');
    expect(received[0]?.authorization).toBe('Bearer sk-stub');
    await peer.stop();
  });

  /**
   * The whole completion, not a stream of it — asserted where the real process sends it.
   *
   * `model.test.ts` guards this over the source; this is the same rule seen from the other
   * end of the wire, on the request a subprocess actually put on it. The pair is worth having
   * because the defect underneath was found only on a live gateway: streamed, an extension
   * field arrives in pieces the SDK's accumulator overwrites rather than joins.
   */
  it('asks the provider for the whole completion rather than a stream of it', async () => {
    const peer = start();
    await peer.tell('Say something.');
    expect((received[0]?.body as { stream?: boolean }).stream).toBeUndefined();
    await peer.stop();
  });

  it('carries a provider’s reasoning into the log entire, not its last fragment', async () => {
    replies = [{ ...ORDINARY, reasoning: 'weighing it up, '.repeat(500) }];
    const peer = start();
    await peer.tell('Say something.');

    const reasoning = peer.events.find((event) => event.type === 'reasoning');
    expect(reasoning?.content).toBe(replies[0]?.reasoning);
    expect(reasoning?.opaque?.reasoning).toBe(replies[0]?.reasoning);
    await peer.stop();
  });

  it('records what the step cost, from what the provider reported', async () => {
    const peer = start();
    await peer.tell('Say something.');
    expect(peer.events.at(-1)).toMatchObject({ type: 'usage', in: 31, out: 7, model: 'stub-model' });
    await peer.stop();
  });

  // The log it emitted is what a supervisor hands back on a resume, so it has to be enough
  // on its own to continue from — and it has to survive JSON, which is the trip the
  // in-process resume comparison never takes.
  it('continues from the log it emitted last time', async () => {
    const first = start();
    await first.tell('Say something.');
    const log = JSON.parse(JSON.stringify(first.events)) as unknown[];
    await first.stop();

    const second = start({}, log);
    expect(await second.tell('And again.')).toBe('There is nothing here but thought.');

    const sent = received[1]?.body as { messages: Record<string, unknown>[] };
    expect(sent.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);

    // What goes back out is the whole point: the assistant message the runtime replays
    // carries the two fields the projection produces and not one field more. A response
    // field that rode along here would be going to a real gateway against a request schema
    // that does not define it, and every other test in this directory would stay green.
    expect(Object.keys(sent.messages[2] ?? {})).toEqual(['role', 'content']);
    await second.stop();
  });
});

/**
 * Whether a step is owed at boot, which is the one question about the log the entry point
 * does not answer for itself.
 *
 * **These two boot on byte-identical logs and must do opposite things.** A log that ends at
 * a complete step belongs either to an agent standing at a turn boundary, whose next move
 * arrives as a message, or to one whose turn ended in a step its supervisor never heard the
 * end of — and the second is owed a step that nothing else will ever prompt. Reading the log
 * cannot separate them, and the entry point used to try: it answered both "wait", and the
 * second sat in a live container having emitted nothing while every message addressed to it
 * was held for a boundary it would never reach.
 */
describe('a step at boot is owed or it is not, and the log cannot say which', () => {
  /** A whole turn, ending where the loop ends one: content, and the cost of the step. */
  async function afterATurn(): Promise<unknown[]> {
    const peer = start();
    await peer.tell('Say something.');
    const log = JSON.parse(JSON.stringify(peer.events)) as { type: string }[];
    await peer.stop();

    expect(log.map((event) => event.type)).toEqual(['charter', 'message', 'message', 'usage']);
    return log;
  }

  it('waits on a log that ends at a complete step, taking no step of its own', async () => {
    const log = await afterATurn();

    const peer = start({}, log);
    // Asserted by what reached the provider rather than by waiting to see nothing happen: a
    // spurious step would be a second request, and it would arrive *before* this one.
    expect(await peer.tell('And again.')).toBe('There is nothing here but thought.');
    expect(received).toHaveLength(2);

    const sent = received[1]?.body as { messages: { role: string; content: string }[] };
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'And again.' });
    await peer.stop();
  });

  it('takes one on that same log when the boot frame says a step is owed', async () => {
    const log = await afterATurn();

    const peer = start({}, log, true);
    // Nothing is sent to it. Without this, the process stays alive having emitted nothing,
    // called nothing and complained about nothing — which is what the supervisor's stored
    // `working` reads as an agent still thinking.
    await peer.until(() => peer.turns.length > 0);
    expect(peer.turns).toEqual(['There is nothing here but thought.']);
    expect(received).toHaveLength(2);
    expect(peer.stderr).toBe('');
    await peer.stop();
  });
});

/**
 * The channel is whatever followed the boot frame on the same pipe.
 *
 * Written as **one** write, which is the case that matters: the sandbox hands the runtime
 * its credentials and its boot frame as a single concatenated write, and the supervisor's
 * first message can be in that same buffer. A boot reader that consumed a byte past its own
 * newline would swallow the beginning of the conversation, and the symptom would be an
 * agent that booted perfectly and then never answered anything.
 */
describe('nothing of the conversation is consumed by reading the boot frame', () => {
  it('reads a message that arrived in the same write as the boot frame', async () => {
    const peer = new Peer(frameFor() + encode({ t: 'message', content: 'Riding along.' }), {
      MODEL_API_KEY: 'sk-stub',
    });

    await peer.until(() => peer.turns.length > 0);
    expect(peer.turns[0]).toBe('There is nothing here but thought.');

    const sent = received[0]?.body as { messages: { role: string; content: string }[] };
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'Riding along.' });
    await peer.stop();
  });
});

/**
 * A turn is several steps, and each one's events have to be out of the process before the
 * next begins — because the way a container ends is not by asking.
 *
 * The steps are produced with a capability the record does not name. `dispatch` answers a
 * call it cannot resolve with a result rather than failing, so the model takes another step
 * on it. That is a real multi-step turn with no capability registered, which is what this
 * change leaves the runtime holding.
 */
describe('an agent killed mid-turn has emitted what it already did', () => {
  const CALLS = {
    role: 'assistant',
    content: null,
    refusal: null,
    annotations: [],
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'nothing', arguments: '{}' } }],
  };

  it('has the completed step’s events out before the step after it', async () => {
    replies = [CALLS, ORDINARY];
    const peer = start();
    peer.write({ t: 'message', content: 'Take a few steps.' });

    // The first step: its call, its cost, and the result of the call.
    await peer.until(() => peer.events.some((event) => event.type === 'tool_result'));
    peer.kill();
    await peer.exit;

    expect(peer.events.map((event) => event.type)).toEqual([
      'charter',
      'message',
      'tool_call',
      'usage',
      'tool_result',
    ]);
    // Killed with the turn unfinished: no turn was ever reported, and the events are still
    // here. A transcript emitted at the end would be a transcript lost exactly here.
    expect(peer.turns).toEqual([]);
  });

  it('emits, across the whole turn, the transcript that turn produced', async () => {
    replies = [CALLS, ORDINARY];
    const peer = start();
    await peer.tell('Take a few steps.');

    expect(peer.events.map((event) => event.type)).toEqual([
      'charter',
      'message',
      'tool_call',
      'usage',
      'tool_result',
      'message',
      'usage',
    ]);
    // The synthesized answer to a call nothing could resolve is an event like any other and
    // is in the log the next boot reads.
    expect(peer.events[4]).toMatchObject({ type: 'tool_result', id: 'call-1', ok: false });
    await peer.stop();
  });

  /**
   * The collision the suspend/resume design is built around, seen from the runtime's side:
   * a log that ends in an unanswered call gets one synthesized on construction, and that
   * synthesized event is emitted like any other so the store has it.
   */
  it('emits the answer it synthesizes for a call the log left outstanding', async () => {
    replies = [CALLS, ORDINARY];
    const first = start();
    await first.tell('Take a few steps.');
    await first.stop();

    // Cut at the step's own cost, which is the last thing appended before the results are
    // dispatched — a log ending in a call nobody answered. Cut by hand rather than by
    // killing the process at the right moment: the window between the two is a few
    // microseconds wide, and a test that has to win a race is a test that will lose one.
    const log = JSON.parse(JSON.stringify(first.events)) as { type: string }[];
    const interrupted = log.slice(0, log.findIndex((event) => event.type === 'usage') + 1);
    expect(interrupted.at(-1)?.type).toBe('usage');
    expect(interrupted.some((event) => event.type === 'tool_call')).toBe(true);

    // Booted the way a supervisor resumes one: the agent was mid-turn when its body went, so
    // it owes a step, and the synthesized answer is what it takes that step on.
    replies = [ORDINARY];
    const second = start({}, interrupted, true);
    await second.until(() => second.events.length > 0);

    // Synthesized on construction, emitted like anything else, so the store has it — and so
    // a parent reading the transcript can see that the call went unanswered.
    expect(second.events[0]).toMatchObject({ type: 'tool_result', id: 'call-1', ok: false });
    await second.stop();
  });
});

/**
 * The model declining, all the way through: the real client, the real entry point, the log
 * it emits, and what that log sends back.
 *
 * Every `refusal` in this directory was `null` until this test, which is how a fix that
 * dropped a non-null one reached review with the suite green. It is the case the scripted
 * client cannot stand in for, because the question is what the wire format does with it.
 */
describe('a model that declines is still an agent that answered', () => {
  const DECLINED = { role: 'assistant', content: null, refusal: 'I will not do that.', annotations: [] };

  it('reports the refusal as its message rather than an empty string', async () => {
    replies = [DECLINED];
    const peer = start();

    expect(await peer.tell('Delete it all.')).toBe('I will not do that.');
    expect(peer.events).toMatchObject([
      { type: 'charter' },
      { type: 'message', from: 'parent' },
      { type: 'message', from: 'self', content: 'I will not do that.', refusal: true },
      { type: 'usage' },
    ]);
    expect(peer.stderr).toBe('');
    await peer.stop();
  });

  it('replays it from that log in the field it arrived in, and in no other', async () => {
    replies = [DECLINED];
    const first = start();
    await first.tell('Delete it all.');
    const log = JSON.parse(JSON.stringify(first.events)) as unknown[];
    await first.stop();

    const second = start({}, log);
    await second.tell('Then list them.');

    const sent = received[1]?.body as { messages: Record<string, unknown>[] };
    expect(sent.messages[2]).toEqual({ role: 'assistant', content: null, refusal: 'I will not do that.' });
    await second.stop();
  });
});

describe('a failure at the entry point says what it was, and not in a stack trace', () => {
  it('reports a credential that was not delivered', async () => {
    const peer = new Peer(frameFor(), { MODEL_API_KEY: '' });
    expect(await peer.exit).toBe(1);
    expect(peer.stderr.trim()).toMatch(/^the credential `MODEL_API_KEY` was not delivered/);
    expect(peer.stderr).not.toContain('    at ');
  });

  it('reports a record it could not read, naming the field', async () => {
    const incomplete = { ...aRecord({ model: { ...aRecord().model, baseURL, model: 'stub-model' } }), name: undefined };
    const peer = new Peer(`${JSON.stringify({ record: incomplete })}\n`, { MODEL_API_KEY: 'sk-stub' });
    expect(await peer.exit).toBe(1);
    expect(peer.stderr).toMatch(/record\.name is missing/);
  });

  it('reports a capability its record names that it cannot resolve', async () => {
    const peer = new Peer(frameFor({ tools: ['fs'] }), { MODEL_API_KEY: 'sk-stub' });
    expect(await peer.exit).toBe(1);
    expect(peer.stderr).toMatch(/"fs"/);
  });

  /**
   * A frame the supervisor sent that cannot be read is not a reason to end the agent. The
   * complement — a frame the *agent* sent that the supervisor cannot read — is the
   * supervisor's, and is tested there.
   */
  it('survives a frame from the supervisor that it cannot read', async () => {
    const peer = start();
    peer.raw('{not json at all\n');
    peer.raw(`${JSON.stringify({ t: 'something-else' })}\n`);

    expect(await peer.tell('Still there?')).toBe('There is nothing here but thought.');
    expect(peer.stderr).toMatch(/not valid JSON/);
    await peer.stop();
  });
});

/**
 * `spawn` and `stop`, from the model's side of the real entry point.
 *
 * This is the one place the registered declarations are exercised as the program actually
 * carries them: a record selects them, the client puts them on the wire, the model calls
 * one, and what comes back out of the process is an ordinary request frame. The supervisor's
 * half — what it does with that frame — is `supervisor/spawn.test.ts`'s.
 *
 * **What it is really holding is that there is no spawn path.** The entry point does not
 * know what spawning is: the call becomes a request because `supervised()` made it one, and
 * the answer becomes a tool result because `dispatch` cannot tell it from work done in the
 * sandbox. If the SDK's tool runner were ever used instead, the process would dispatch the
 * call itself and **no request frame would appear here at all** — so the frame these tests
 * wait for is the observable form of that rule. `model.test.ts` guards the same rule over
 * the source, which is what catches a runner used for a capability nothing tests.
 */
describe('a capability the agent does not hold is offered, called, and answered', () => {
  /** The model calling `spawn`, as a gateway reports one. */
  const SPAWNS = {
    role: 'assistant',
    content: null,
    refusal: null,
    annotations: [],
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'spawn', arguments: '{"name":"scout","charter":"Look around.","opening":"Begin."}' },
      },
    ],
  };

  /** The same for `stop`, which is answered with a refusal rather than an id. */
  const STOPS = {
    role: 'assistant',
    content: null,
    refusal: null,
    annotations: [],
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'stop', arguments: '{"id":"a-9"}' } }],
  };

  /** The declarations the provider was sent, by name, on the request numbered `at`. */
  function offered(at: number): string[] | undefined {
    const sent = received[at]?.body as { tools?: { function: { name: string } }[] };
    return sent.tools?.map((tool) => tool.function.name);
  }

  /** The first request frame the process raised, or nothing if it raised none. */
  function raised(peer: Peer): Extract<FromAgent, { t: 'request' }> | undefined {
    return peer.frames.find((frame) => frame.t === 'request');
  }

  it('offers exactly the capabilities the record names, in the order it names them', async () => {
    const peer = start({ tools: ['stop', 'spawn'] });
    await peer.tell('Say something.');

    // The record's order, not the registry's, because a re-ordered declaration list is a
    // prompt-cache miss on every resume rather than a cosmetic difference.
    expect(offered(0)).toEqual(['stop', 'spawn']);
    await peer.stop();
  });

  /**
   * Registering is not granting, which is the half that keeps unequal authority in the
   * record. Both processes run the same bytes; one is offered a capability and one is not.
   */
  it('offers only the one a record names, though both are registered', async () => {
    const peer = start({ tools: ['stop'] });
    await peer.tell('Say something.');
    expect(offered(0)).toEqual(['stop']);
    await peer.stop();
  });

  it('turns the model’s spawn call into a supervisor request carrying what it asked for', async () => {
    replies = [SPAWNS, ORDINARY];
    const peer = start({ tools: ['spawn'] });
    peer.write({ t: 'message', content: 'Delegate this.' });

    await peer.until(() => raised(peer) !== undefined);
    const request = raised(peer)!;
    expect(request.kind).toBe('spawn');
    expect(request.input).toEqual({ name: 'scout', charter: 'Look around.', opening: 'Begin.' });
    // Nothing was asked about the body: `spawn` is not a suspension, and zero is how the
    // absence of a request is written rather than something the supervisor fills in.
    expect(request.residency).toBe(0);

    // Not dispatched locally, which is the whole of it: the process is sitting on a call it
    // cannot answer, and has taken no second step.
    expect(received).toHaveLength(1);
    await peer.stop();
  });

  it('gives the model the supervisor’s answer as an ordinary tool result on its next step', async () => {
    replies = [SPAWNS, ORDINARY];
    const peer = start({ tools: ['spawn'] });
    peer.write({ t: 'message', content: 'Delegate this.' });
    await peer.until(() => raised(peer) !== undefined);

    peer.write({ t: 'answer', id: raised(peer)!.id, ok: true, content: 'a-1' });
    await peer.until(() => peer.turns.length > 0);

    const sent = received[1]?.body as { messages: Record<string, unknown>[] };
    expect(sent.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'a-1' });
    expect(peer.events).toMatchObject([
      { type: 'charter' },
      { type: 'message', from: 'parent' },
      { type: 'tool_call', name: 'spawn' },
      { type: 'usage' },
      { type: 'tool_result', id: 'call-1', ok: true, content: 'a-1' },
      { type: 'message', from: 'self' },
      { type: 'usage' },
    ]);
    await peer.stop();
  });

  /**
   * A refused capability is a result, not a failure. The agent reads what the supervisor
   * said and takes another step on it — which is what makes a refusal something the weights
   * can act on rather than something that ends a turn.
   */
  it('carries a refusal back to the model and lets the turn continue', async () => {
    replies = [STOPS, ORDINARY];
    const peer = start({ tools: ['stop'] });
    peer.write({ t: 'message', content: 'Dismiss it.' });
    await peer.until(() => raised(peer) !== undefined);

    expect(raised(peer)!.kind).toBe('stop');
    expect(raised(peer)!.input).toEqual({ id: 'a-9' });
    peer.write({
      t: 'answer',
      id: raised(peer)!.id,
      ok: false,
      content: '"a-9" is not one of your children, so nothing was stopped.',
    });

    await peer.until(() => peer.turns.length > 0);
    expect(peer.turns).toEqual(['There is nothing here but thought.']);
    expect(peer.events.find((event) => event.type === 'tool_result')).toMatchObject({
      id: 'call-1',
      ok: false,
      content: '"a-9" is not one of your children, so nothing was stopped.',
    });
    expect(peer.stderr).toBe('');
    await peer.stop();
  });
});
