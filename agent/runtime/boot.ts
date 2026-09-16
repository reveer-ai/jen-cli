/**
 * How a runtime starts: one JSON line on standard input, carrying a record and a log.
 *
 * **Nothing arrives in argv, and the log is why.** A single command-line argument is capped
 * at a fixed size — 128 KB on Linux, whatever the total the system allows — so an event log,
 * which grows without bound, cannot travel that way at all. Once the log is on standard
 * input there is nothing to gain by splitting the record onto a second channel and
 * something to lose: a stale record and a fresh log that arrive together cannot disagree.
 *
 * Keeping the record off the command line also keeps the agent's charter out of the
 * machine's view of its processes. The record is inert by design, so this is not a secret
 * leak — but `agent-sandbox` spent real effort establishing that what you hand a process,
 * you do not also write down somewhere it can be read back.
 *
 * **The frame shares its channel with the sandbox's credential delivery and follows it.**
 * The prologue that reads the credentials reads them a byte at a time, as POSIX requires of
 * a shared descriptor, so it stops at its own terminator and this frame is what the runtime
 * then inherits. It works because of a guarantee that is easy to not know about, which is
 * why there is a test for it in the sandbox's own suite rather than a comment here: the
 * failure mode of a prologue that over-read is a *truncated frame*, and a truncated frame
 * reads as a malformed record.
 */
import { parseRecord, RecordError, type AgentRecord } from '../record.ts';
import { EventLogError, parseEvents, type Event } from './events.ts';

import type { Readable } from 'node:stream';

export interface BootFrame {
  record: AgentRecord;
  events: Event[];
  /**
   * Whether this body owes the model a step, said by whoever booted it.
   *
   * **It is on the frame because it is not in the log.** Three situations leave logs that
   * are indistinguishable — an agent suspended on purpose, one killed mid-call, and one
   * whose turn ended in a step its supervisor never heard about — and which of them this is
   * lives in the supervisor's stored state, which is exactly where the design put it and
   * exactly why it stored it rather than inferring it.
   *
   * Absent means no: a body booted with nothing to say about this waits to be given
   * something. That is what every caller outside the supervisor wants, and it is the safe
   * half — an agent that waits when it should have stepped is woken by its next message,
   * while one that steps when it should have waited has taken a step nobody asked for.
   */
  owed: boolean;
}

/** What a frame that could not be read is reported as. */
export class BootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BootError';
  }
}

/**
 * Read exactly one line, and leave the rest of the channel where it was.
 *
 * What follows the frame is the line protocol the supervisor and the runtime converse over,
 * so the remainder is pushed back rather than consumed. Reading is by bytes and not by
 * lines from a helper, because a helper that buffered ahead would swallow the beginning of
 * that conversation.
 */
function readLine(input: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    // Chunks are kept as they arrive and joined once, rather than accumulated into one
    // growing buffer. The distinction is the difference between linear and quadratic on
    // exactly the input this whole mechanism exists for: concatenating per chunk copies
    // everything received so far every time, and rescanning the accumulation for the
    // newline does it again. A 10 MB log in 64 KB chunks is on the order of 160 copies
    // averaging 5 MB — and an event log growing without bound is the stated reason the
    // frame is on this channel instead of in an argument.
    const chunks: Buffer[] = [];
    let size = 0;

    const done = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.pause();
    };

    const onData = (chunk: Buffer): void => {
      // Only what just arrived is scanned; everything before it was scanned as it arrived.
      // A newline is a single byte in UTF-8 and cannot hide inside a multi-byte sequence,
      // so nothing is missed by never looking across a chunk boundary.
      const found = chunk.indexOf(0x0a);
      chunks.push(chunk);
      size += chunk.length;
      if (found === -1) return;
      done();

      const newline = size - chunk.length + found;
      const buffered = Buffer.concat(chunks, size);
      const rest = buffered.subarray(newline + 1);
      if (rest.length > 0) input.unshift(rest);
      resolve(buffered.subarray(0, newline).toString('utf8'));
    };

    const onEnd = (): void => {
      done();
      reject(
        new BootError(
          size === 0
            ? 'the boot frame is missing: standard input ended before anything arrived.'
            : `the boot frame is incomplete: standard input ended after ${size} bytes with no line ending.`,
        ),
      );
    };

    const onError = (cause: unknown): void => {
      done();
      reject(new BootError('the boot frame could not be read from standard input.', { cause }));
    };

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

/**
 * Read the frame, or say what could not be read.
 *
 * Every failure names a field, and that is the point of it rather than a courtesy. The
 * realistic failure here is not a supervisor that built a bad record — it is a frame that
 * lost its first bytes to something upstream. `record.id is missing` is diagnosable;
 * `invalid boot frame` sends the reader looking in the wrong place entirely.
 */
export async function readBootFrame(input: Readable): Promise<BootFrame> {
  const line = await readLine(input);

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new BootError(
      `the boot frame is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BootError('the boot frame is not an object carrying a record and an event log.');
  }

  const frame = parsed as Record<string, unknown>;
  try {
    return {
      record: parseRecord(frame.record),
      // Absent and empty mean the same thing: an agent that has not yet run. A supervisor
      // starting a fresh agent should not have to spell out that nothing has happened.
      events: parseEvents(frame.events ?? []),
      owed: frame.owed === true,
    };
  } catch (cause) {
    if (cause instanceof RecordError || cause instanceof EventLogError) {
      throw new BootError(`the boot frame could not be read: ${cause.message}`, { cause });
    }
    throw cause;
  }
}
