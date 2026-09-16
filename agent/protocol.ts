/**
 * The frames a runtime and the supervisor exchange, declared once.
 *
 * This module belongs to neither of them, which is why it sits above both rather than
 * inside either — the same reasoning, and the same shape, as `record.ts`. A protocol owned
 * by one end is a protocol the other end imports from its counterparty, and the two would
 * be coupled through a module neither of them is about.
 *
 * **JSON lines over the runtime's own standard streams, and nothing else.** No broker, no
 * port, no daemon, no shared bus, and no network path between agents: a project holds tens
 * of agents rather than thousands, and a message fabric at that scale costs more to operate
 * than it coordinates. Each agent is a process the supervisor started, and the channel is
 * the pipe it was started on — the one that remains after its boot frame.
 *
 * **A new request kind must not reshape any of this.** `spawn`, `send`, `await`, `stop` and
 * `read` are expected to be joined by others, and a transport that had to change to carry
 * one would make every new capability a change to the substrate's plumbing. So a request is
 * an id, a kind that is an ordinary string, and an input this module never looks inside.
 */
import { parseEvents, type Event } from './runtime/events.ts';

/** What a frame that could not be read is reported as. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** An event, the moment the runtime appended it. */
export interface EventFrame {
  t: 'event';
  event: Event;
}

/**
 * A capability the agent does not hold, raised as a question.
 *
 * `id` is what correlates it with its answer, and it is why an agent may have several
 * outstanding at once without confusing them. `kind` names what is being asked for and is
 * deliberately an open string.
 *
 * `residency` is the suspending agent's own instruction about how long its body is to be
 * kept, in milliseconds. It rides here rather than on a frame of its own because a
 * suspension is not a separate thing the runtime does — it is what the supervisor may do
 * while an ordinary request is outstanding, and a frame that announced it would give the
 * runtime a suspend path and then a resume path to match.
 *
 * **The runtime writes it, always.** Zero is what the absence of a request looks like, and
 * expressing that absence here rather than leaving the field off is what keeps the
 * supervisor from having a default to supply — a default there would be the supervisor
 * holding a policy about an agent's body, which is the agent's to hold.
 */
export interface RequestFrame {
  t: 'request';
  id: string;
  kind: string;
  input: unknown;
  residency: number;
}

/**
 * The turn ended: the agent produced content with nothing outstanding.
 *
 * Reported rather than signalled by exiting. An entry point that speaks only by ending can
 * say one thing, cannot say anything while a turn is in progress, and cannot suspend
 * without destroying the agent it is.
 *
 * `residency` is zero here and is carried anyway, so the supervisor reads one rule rather
 * than two. An agent at a turn boundary has asked for nothing, and the runtime says so.
 */
export interface TurnFrame {
  t: 'turn';
  message: string;
  residency: number;
}

export type FromAgent = EventFrame | RequestFrame | TurnFrame;

/** The answer to one request, carrying the id of the request it belongs to. */
export interface AnswerFrame {
  t: 'answer';
  id: string;
  ok: boolean;
  content: string;
}

/** A message beginning a turn, in the position this agent's parent occupies. */
export interface MessageFrame {
  t: 'message';
  content: string;
}

/**
 * A frame the supervisor could not read, reported to whoever sent it.
 *
 * It carries no id, because the frame it is about is the one that could not be read — an id
 * taken from it would be an id read out of something unreadable. The agent's other
 * outstanding requests are untouched, which is the property this exists to keep.
 */
export interface MalformedFrame {
  t: 'malformed';
  reason: string;
}

/** Nothing further will be asked of this agent; the process may end. */
export interface StopFrame {
  t: 'stop';
}

export type ToAgent = AnswerFrame | MessageFrame | MalformedFrame | StopFrame;

/** One frame, as one line. The newline is the framing and there is no other. */
export function encode(frame: FromAgent | ToAgent): string {
  return `${JSON.stringify(frame)}\n`;
}

function object(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new ProtocolError(`the frame is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('the frame is not an object');
  }
  return parsed as Record<string, unknown>;
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new ProtocolError(`the frame's ${key} is missing or is not a string`);
  return value;
}

function count(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProtocolError(`the frame's ${key} is missing or is not a duration`);
  }
  return value;
}

/** Read one of the runtime's frames, or say what could not be read. */
export function parseFromAgent(line: string): FromAgent {
  const source = object(line);
  switch (source.t) {
    case 'event':
      // Through the log's own reader, so an event that reaches the store is an event the
      // next runtime can construct from. A frame carrying something `parseEvents` refuses
      // is refused here rather than written down and failed on at a resume.
      return { t: 'event', event: parseEvents([source.event], 'frame.event')[0]! };
    case 'request':
      return {
        t: 'request',
        id: text(source, 'id'),
        kind: text(source, 'kind'),
        input: source.input,
        residency: count(source, 'residency'),
      };
    case 'turn':
      return { t: 'turn', message: text(source, 'message'), residency: count(source, 'residency') };
    default:
      throw new ProtocolError(`the frame's t is "${String(source.t)}", which is not something an agent sends`);
  }
}

/** Read one of the supervisor's frames, or say what could not be read. */
export function parseToAgent(line: string): ToAgent {
  const source = object(line);
  switch (source.t) {
    case 'answer': {
      if (typeof source.ok !== 'boolean') throw new ProtocolError("the frame's ok is missing or is not a boolean");
      return { t: 'answer', id: text(source, 'id'), ok: source.ok, content: text(source, 'content') };
    }
    case 'message':
      return { t: 'message', content: text(source, 'content') };
    case 'malformed':
      return { t: 'malformed', reason: text(source, 'reason') };
    case 'stop':
      return { t: 'stop' };
    default:
      throw new ProtocolError(`the frame's t is "${String(source.t)}", which is not something the supervisor sends`);
  }
}

/**
 * The lines of a channel, as they arrive.
 *
 * Written by hand rather than over a line-reading helper, for the reason `boot.ts` gives:
 * the stream this reads is the one the boot frame was read off, and a helper that buffered
 * ahead of what it yielded would swallow the beginning of the conversation. A blank line is
 * not a frame and is skipped, so a writer that ends its output with a newline — which every
 * writer here does — is not read as having sent an empty one.
 */
export async function* lines(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffered = '';
  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffered += chunk as string;
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim() !== '') yield line;
    }
  }
  // Whatever is left has no newline after it, so it is a frame the writer never finished —
  // an agent killed mid-write is the ordinary way to get one. It is dropped rather than
  // yielded, because yielding it arrives as a parse failure blaming the sender for the
  // channel's ending. The frame is lost and nothing before it is.
}
