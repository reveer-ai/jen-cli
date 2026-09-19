/**
 * A model, spoken to over the network, that says exactly what it was told to say.
 *
 * Test support. Nothing the substrate runs imports it.
 *
 * **It is an HTTP server rather than an object, and that is forced.** `scripted()` in
 * `fixture.ts` substitutes at the seam `model.ts` describes — in process, by construction —
 * and the acceptance tier's whole point is that the runtime is inside a container, where
 * there is no in-process object to substitute. The seam that survives the boundary is the
 * one already on every record: `baseURL`, pointed here. So the runtime under test is the
 * shipped runtime, with no branch added to it and nothing for `policy.test.ts` to find.
 *
 * **It dispatches on `model.model` and on nothing else.** That field is free-form, it is
 * already on every record, and it arrives verbatim in every request — so a record reading
 * `"model": "script:leaf"` gets the script registered under `script:leaf`. Matching on the
 * charter was the alternative and it is substring matching against English: it breaks when
 * a charter is reworded for reasons that have nothing to do with the test, and it
 * re-invents what an exact field already does.
 *
 * **A script is a function of the conversation, not a cursor.** Several agents can share a
 * model identifier and one agent takes many steps, so a counter held here would be shared
 * between agents that have nothing to do with each other and would be wrong the moment two
 * of them ran at once — which is the tier's own parallelism test. The step number is read
 * out of the request instead: one assistant message is one step this conversation has
 * already taken. That also makes a resumed agent ask for the step it was killed on, which
 * is what "the model cannot tell" has to mean here.
 *
 * It implements `POST /v1/chat/completions` and nothing else. A path or a model it does not
 * know is an error naming what was asked for, because the failure this is most likely to
 * produce is a record pointing at a script nobody registered, and that has to read as such
 * rather than as the runtime misbehaving.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** One request, as the gateway received it. */
export interface GatewayRequest {
  model: string;
  messages: { role: string; content: string | null; [key: string]: unknown }[];
  tools?: unknown[];
  /**
   * What the client authenticated with, verbatim.
   *
   * Recorded so the tier can assert the whole credential path end to end — a value the
   * driver resolved on the host, delivered on the agent process's own standard input,
   * exported by the prologue, read out of the environment by `openAIClient`, and arriving
   * here. Nothing between those points can be checked from either end alone.
   */
  authorization: string | null;
}

/** A capability call the script wants made, before the gateway gives it an id. */
export interface ScriptedCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What a step produced: words, calls, or both. Neither is a turn's end on its own. */
export interface ScriptedStep {
  content?: string;
  calls?: ScriptedCall[];
}

/**
 * What an agent reasoning with this model does, step by step.
 *
 * `step` is how many steps this conversation has already taken, which is the position in a
 * sequence. Returning nothing at all is a script that ran out, and the gateway answers that
 * as an error rather than as an empty turn — an agent handed empty content would end its
 * turn and report nothing, which reads in the tier as an assertion failing for some other
 * reason entirely.
 */
export type Script = (request: GatewayRequest, step: number) => ScriptedStep | undefined;

/** A fixed sequence of steps, which is what most scripts are. */
export function sequence(...steps: (ScriptedStep | ((request: GatewayRequest) => ScriptedStep))[]): Script {
  return (request, step) => {
    const at = steps[step];
    return typeof at === 'function' ? at(request) : at;
  };
}

/** A step that ends the turn. */
export function says(content: string): ScriptedStep {
  return { content };
}

/** A step that calls capabilities, and therefore does not end the turn. */
export function calls(...made: ScriptedCall[]): ScriptedStep {
  return { calls: made };
}

/** What the last capability answered, for a step that reports what it was told. */
export function lastResult(request: GatewayRequest): string {
  const answers = request.messages.filter((message) => message.role === 'tool');
  return String(answers.at(-1)?.content ?? '');
}

/** The last thing the agent's parent — or the person, at the root — said to it. */
export function lastMessage(request: GatewayRequest): string {
  const said = request.messages.filter((message) => message.role === 'user');
  return String(said.at(-1)?.content ?? '');
}

/** Everything every capability answered, oldest first. */
export function everyResult(request: GatewayRequest): string[] {
  return request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content ?? ''));
}

export interface GatewayOptions {
  /** What each model identifier does, keyed exactly as a record spells it. */
  scripts: Record<string, Script>;
  /**
   * Awaited before a request is answered, if it is given.
   *
   * The tier's one place to choreograph — to hold two agents in a model call at once so
   * that `docker ps` can be asked whether both bodies exist, or to hold one so that its
   * container can be killed while it is genuinely mid-turn. It is here rather than in a
   * script because it is about *when* a step is answered rather than about what the step
   * is, and mixing the two would make every script carry timing it does not care about.
   */
  before?: (request: GatewayRequest) => Promise<void>;
}

export interface Gateway {
  /** What a record's `baseURL` is set to. Reachable from a container on this host. */
  url: string;
  port: number;
  /** Every request, in arrival order. */
  seen: GatewayRequest[];
  close(): Promise<void>;
}

/**
 * Where a container reaches a service on the host.
 *
 * Docker Desktop provides this name inside every container; Linux Docker does not, and
 * teaching the driver `--add-host` would make every container the substrate ever creates
 * carry a concern that exists for a test. So it is a recorded gap rather than a fix, and
 * the tier's setup is what names it — see `agent/AGENTS.md`.
 */
export const HOST_FROM_CONTAINER = 'host.docker.internal';

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const seen: GatewayRequest[] = [];
  // Held so that `close` can release anything the tier parked, whether or not the tier got
  // as far as releasing it itself. A request left waiting on a promise nobody will settle
  // keeps a socket open, and a socket open keeps the test process alive after the run.
  const parked = new Set<() => void>();
  let closing = false;

  const server = createServer((request, response) => {
    void answer(request, response).catch((error: unknown) => {
      fail(response, 500, error instanceof Error ? error.message : String(error));
    });
  });

  async function answer(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = incoming.url ?? '';
    if (incoming.method !== 'POST' || url.split('?')[0] !== '/v1/chat/completions') {
      return fail(
        response,
        404,
        `this gateway serves POST /v1/chat/completions and nothing else; it was asked for ${incoming.method ?? '?'} ${url}.`,
      );
    }

    const body = await read(incoming);
    let parsed: GatewayRequest;
    try {
      parsed = JSON.parse(body) as GatewayRequest;
    } catch (error) {
      return fail(response, 400, `the request body is not JSON: ${error instanceof Error ? error.message : ''}`);
    }
    const request: GatewayRequest = {
      ...parsed,
      messages: parsed.messages ?? [],
      authorization: incoming.headers.authorization ?? null,
    };
    seen.push(request);

    const script = options.scripts[request.model];
    if (script === undefined) {
      return fail(
        response,
        400,
        `no script is registered for the model \`${request.model}\`; this gateway knows ` +
          `${Object.keys(options.scripts).map((name) => `\`${name}\``).join(', ')}.`,
      );
    }

    if (options.before !== undefined) {
      const held = options.before(request);
      await Promise.race([held, new Promise<void>((resolve) => parked.add(resolve))]);
      if (closing) return fail(response, 503, 'the gateway is closing.');
    }

    // One assistant message is one step already taken, which is this conversation's own
    // position and nothing shared with any other agent's.
    const step = request.messages.filter((message) => message.role === 'assistant').length;
    const produced = script(request, step);
    if (produced === undefined) {
      return fail(
        response,
        400,
        `the script for \`${request.model}\` has nothing for step ${step}; the conversation went further than it was written for.`,
      );
    }

    reply(response, request.model, step, produced);
  }

  function reply(response: ServerResponse, model: string, step: number, produced: ScriptedStep): void {
    // Ids derived from the position rather than from a counter, so a step re-taken after a
    // resume raises the same call id it raised before — the closest this can get to a model
    // that cannot tell it was interrupted.
    const made = (produced.calls ?? []).map((call, at) => ({
      id: `call-${step}-${at}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));

    send(response, 200, {
      id: `chatcmpl-${model}-${step}`,
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: produced.content ?? '',
            ...(made.length === 0 ? {} : { tool_calls: made }),
          },
          finish_reason: made.length === 0 ? 'stop' : 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the gateway did not take a port.');
  const port = address.port;

  return {
    url: `http://${HOST_FROM_CONTAINER}:${port}/v1`,
    port,
    seen,
    async close() {
      closing = true;
      for (const release of parked) release();
      parked.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Every held request owned a socket, and `close` waits for what is open rather than
      // ending it. The releases above are what let those finish; this is what makes the
      // wait terminate if one of them is still mid-flight.
      server.closeAllConnections();
    },
  };
}

function read(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    incoming.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/** An error in the shape the client reports rather than swallows. */
function fail(response: ServerResponse, status: number, message: string): void {
  send(response, status, { error: { message, type: 'scripted_gateway_error' } });
}

/**
 * A latch the tier opens, and a count of how many requests were held at once.
 *
 * The count is the parallelism claim made from the gateway's side: two requests held
 * simultaneously are two agents in a model call simultaneously, because an agent's loop
 * awaits each step before taking the next. It is recorded alongside what `docker ps` says
 * rather than instead of it — the two are different claims, and a substrate that started
 * two bodies and ran them one after the other would satisfy neither.
 */
export function latch(applies: (request: GatewayRequest) => boolean = () => true): {
  before: (request: GatewayRequest) => Promise<void>;
  /** The most that were held at one moment. */
  most: number;
  held: number;
  release(): void;
} {
  const waiting: (() => void)[] = [];
  let open = false;
  const gate = {
    most: 0,
    held: 0,
    before(request: GatewayRequest): Promise<void> {
      if (open || !applies(request)) return Promise.resolve();
      gate.held += 1;
      gate.most = Math.max(gate.most, gate.held);
      return new Promise<void>((resolve) => {
        waiting.push(() => {
          gate.held -= 1;
          resolve();
        });
      });
    },
    release(): void {
      open = true;
      for (const resume of waiting.splice(0)) resume();
    },
  };
  return gate;
}
