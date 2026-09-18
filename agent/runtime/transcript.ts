/**
 * A descendant's transcript, fetched from the supervisor and written into the workspace of
 * the agent that asked for it.
 *
 * **The point is what the caller pays.** A capability's result is carried again on every
 * later model call, so a transcript returned once is paid for on every step that follows —
 * and the transcripts worth inspecting are precisely the long ones. On disk it is paid for
 * only where the agent looks: `grep -c 'npm test'` answers the question that actually
 * mattered for a handful of tokens, and `jq`, `tail` and `sed -n` answer the rest. So the
 * answer to `read` is a path, and the events never enter the model's context at all.
 *
 * **The runtime writes it and not the supervisor**, and that is forced rather than chosen: a
 * workspace is a Docker named volume with nothing of the machine mounted beside it, so the
 * supervisor — a host process — could only reach one by starting a container against it or
 * executing inside a live one. That is a larger authority than routing a message and it does
 * it nowhere else. The runtime is already in the container with the volume mounted, and it
 * is what receives the answer.
 *
 * **Ranges stayed on the wire.** ENG-213's `from`/`count` are how this pages the log down so
 * the whole of it is never held at once; they are not in the schema the model sees, because
 * offset arithmetic for a model to perform is a reliable source of off-by-one errors and
 * every question it could answer is answered better by a command the agent already has.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileHandle } from 'node:fs/promises';
import type { CapabilityResult } from './capability.ts';
import type { Event } from './events.ts';
import type { Composing } from './supervised.ts';

/**
 * The directory a read writes into, under the reading agent's own workspace root.
 *
 * A reserved name rather than a namespace — `.agent/` or `.jen/` invented to hold a
 * population of one is machinery ahead of a case for it. An agent that writes its own files
 * under this name will have them overwritten, which is accepted rather than guarded: a
 * reserved path an agent must be *prevented* from using is a rule needing enforcement in
 * `fs`, and that is a cost out of all proportion to the collision.
 */
const TRANSCRIPTS = '.transcripts';

/**
 * How many events one request asks for.
 *
 * The bound that matters is memory in this process, not bytes on the channel: a page is
 * parsed, written, and dropped before the next is asked for, so a transcript of any length
 * costs one page. It is deliberately well above a short child's whole log, so the ordinary
 * read is a single exchange and the paging is what happens to the sessions worth inspecting.
 */
const PAGE = 512;

/** What the supervisor answers a `read` with. See `supervisor/index.ts`'s `#reading`. */
interface Served {
  total: number;
  events: Event[];
}

/**
 * Fetch a descendant's transcript, write it down, and answer with where it went.
 *
 * The order is deliberate: **nothing is created until a page has actually arrived.** A
 * refusal — a sibling's transcript, an id that names no agent — is returned exactly as the
 * supervisor phrased it, having touched the workspace not at all, so a refused read leaves
 * no empty directory and no truncated file where a previous read's transcript was.
 *
 * Pages are written as they arrive, into a temporary file that is renamed over the target
 * once the last one lands. That is what makes a repeated read leave exactly one file holding
 * exactly one transcript, and what keeps a read that failed half way from leaving a partial
 * log wearing the name of a complete one.
 */
export async function transcribe({ input, ask, record }: Composing): Promise<CapabilityResult> {
  const target = (input as { id?: unknown }).id;
  if (typeof target !== 'string' || target === '') {
    return failed('A read names the `id` of the agent whose transcript you want, and nothing else.');
  }
  // The id becomes a file name, so it has to be one. The supervisor would refuse anything
  // shaped like this anyway — no such agent — but refusing it before it can be joined onto
  // a path is what keeps that a fact about the tree rather than the thing standing between
  // a `../` and the workspace root.
  if (target.includes('/') || target.includes('\\') || target === '.' || target === '..') {
    return failed(`"${target}" is not an agent id.`);
  }

  const where = join(TRANSCRIPTS, `${target}.jsonl`);
  const directory = join(record.workspace, TRANSCRIPTS);
  const path = join(record.workspace, where);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;

  let handle: FileHandle | undefined;
  let written = 0;
  // The length of the snapshot, fixed by the first answer and never raised by a later one.
  // A transcript grows while it is being read, so a loop that re-read this from every answer
  // would end when a working child fell behind the pipe rather than when the log ran out —
  // no bound at all, for exactly the busy child worth reading. Fixing it here is what makes
  // the file the events that were there when the call was made, which is what the result
  // tells the model it is and what `design.md` puts tailing under Non-Goals to keep it.
  let total: number | undefined;
  try {
    for (;;) {
      // Never ask past the snapshot: the last page is the remainder of it, so a log that grew
      // in the meantime cannot arrive on the end of the final page.
      const count = total === undefined ? PAGE : Math.min(PAGE, total - written);
      const answer = await ask({ id: target, from: written, count });
      // Unchanged, because the supervisor's refusals say what a model needs to hear and
      // rewording one here would put this file in the business of explaining the tree.
      if (!answer.ok) return answer;

      const page = served(answer.content);
      total ??= page.total;
      handle ??= await opened(directory, temporary);
      if (page.events.length > 0) {
        // One line per event, serialized from what was stored and not from a shape of this
        // file's own: a reasoning event's `opaque` payload rides along with everything else,
        // because deciding on the way past that a field was "only for replay" is exactly the
        // interpreting a verification surface may not do.
        //
        // `writeFile` on the handle and not `write`: `write` issues one `write(2)` and reports
        // what it managed in a count, and a full volume returns short rather than `ENOSPC`
        // while there is some room left — so the rename would publish a truncated transcript
        // under a complete one's name, which is the outcome the rename exists to prevent. This
        // loops until the page is out and continues from the handle's own position, so a
        // per-page write stays one. `supervisor/store.ts`'s `save()` writes its temporary the
        // same way.
        await handle.writeFile(page.events.map((event) => `${JSON.stringify(event)}\n`).join(''));
        written += page.events.length;
      }
      // An empty page ends it whatever the total says — a `total` that cannot be reached is
      // the one thing the count above cannot bound.
      if (page.events.length === 0 || written >= total) break;
    }

    await handle!.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    return failed(`"${target}"'s transcript could not be written to ${where}: ${message(error)}`);
  } finally {
    // Both are no-ops on the path that succeeded — the handle is closed and the temporary
    // file has been renamed out from under this. On every other path they are what keeps a
    // failed read from leaving a descriptor open or a fragment behind.
    if (handle !== undefined) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }

  return {
    ok: true,
    content:
      `Wrote ${target}'s transcript to ${where} in your workspace: ${count(written)}, one JSON ` +
      'object per line, oldest first. Read it with the tools you already hold — `grep` for what ' +
      'you want to check, `tail` for the end of it, `jq` to pick events apart. It is what was ' +
      'stored at the moment you called, so call again to refresh it.',
  };
}

/** The directory first, because a workspace has never had one and a read may be the first. */
async function opened(directory: string, temporary: string): Promise<FileHandle> {
  await mkdir(directory, { recursive: true });
  return open(temporary, 'w');
}

/**
 * The answer, as the shape this needs from it.
 *
 * Checked rather than asserted: the supervisor is the substrate's own peer, but an answer
 * that is not a transcript would otherwise be discovered as `undefined.length` inside the
 * loop, and a `TypeError` naming a property is a worse account than a sentence naming what
 * arrived. Thrown rather than returned, because the catch above is already where a read that
 * could not be completed becomes a result.
 */
function served(content: string): Served {
  const parsed: unknown = JSON.parse(content);
  const answer = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<Served>;
  if (typeof answer.total !== 'number' || !Array.isArray(answer.events)) {
    throw new Error('the supervisor answered with something that is not a transcript');
  }
  return { total: answer.total, events: answer.events };
}

function count(events: number): string {
  return `${events} ${events === 1 ? 'event' : 'events'}`;
}

function failed(reason: string): CapabilityResult {
  return { ok: false, content: reason };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
