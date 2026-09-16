/**
 * Where a run's records and transcripts live: outside every sandbox, and outside every
 * process that reads them.
 *
 * **An agent exists because its record exists.** Not because a process is running — there
 * is no state in which an agent's existence depends on a body, and an agent with nothing
 * running is simply an agent that is not currently working.
 *
 * ```
 * .jen/runs/<run>/
 *   run.json                  # the run, and the agent nobody spawned
 *   agents/<id>/record.json   # written once
 *   agents/<id>/state.json    # rewritten on every transition
 *   agents/<id>/events.ndjson # appended, never rewritten
 * ```
 *
 * **Three files because there are three write patterns**, and merging any two would mean
 * rewriting an append-only file or appending to a mutable one. The record is written once
 * and never again; the log only grows; the state is rewritten in place.
 *
 * **It sits in the project folder and is gitignored.** A project is meant to be completely
 * contained in its folder, and this keeps that true in the way that matters — zip the
 * folder and the runs come with it. What it gives up is that tenet read literally, all of
 * it versioned: transcripts are large and append constantly, and committing them would make
 * every agent-run commit a wall of transcript with the source changes buried in it.
 *
 * **One JSON object per line.** Appending is one write. A JSON array would mean removing
 * the closing bracket, adding the event and rewriting the file — O(size) per event, with a
 * window between the truncate and the write in which a crash loses the whole transcript.
 * Ranges are line ranges, which are stable because the file only ever grows, and a kill
 * mid-write costs the last line and nothing before it.
 *
 * The events stored are the runtime's own event objects, unchanged, so the transcript a
 * parent reads and the one an agent resumes from are the same bytes.
 */
import { mkdir, open, readdir, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { parseRecord, type AgentRecord } from '../record.ts';
import { parseEvents, type Event } from '../runtime/events.ts';

/** What a store that cannot be read or written is reported as. */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/**
 * What an agent is doing, which is the thing that cannot be inferred from its log.
 *
 * A deliberately suspended `await` and a process killed mid-call leave the log in exactly
 * the same shape — a call with no result — so the log alone cannot tell a suspension from a
 * death. That is why this is stored rather than derived, and it is the whole reason the
 * store has a third file at all.
 *
 * `request` on a waiting agent is the id of the request it is waiting on, or `null` where
 * it is at a turn boundary having asked for nothing. The two are different deliveries: one
 * is answered where it stands, the other begins a new turn.
 */
export type AgentState =
  | { status: 'working' }
  | { status: 'waiting'; request: string | null }
  | { status: 'dismissed' };

/**
 * A message waiting to be delivered.
 *
 * `from` is who said it: an agent's id, or `null` for the human — who is the root's parent
 * and a participant in this graph rather than an exception to it.
 *
 * `substrate` marks the one kind of message no participant said: a report that an agent
 * ended. **A parent must always be able to tell a report of a death from a report by the
 * deceased**, and a flag on the message is what carries that through the store, through
 * delivery, and into the text the agent finally reads.
 */
export interface Message {
  from: string | null;
  content: string;
  substrate?: true;
}

/** Everything about an agent that is not its record and not its transcript. */
export interface StoredAgent {
  state: AgentState;
  parent: string | null;
  children: string[];
  mailbox: Message[];
}

/** The run itself, and the one agent nobody spawned. */
export interface RunHeader {
  run: string;
  created: string;
  root: string | null;
}

/**
 * An agent id has to be a directory name, because it is one.
 *
 * Nothing about a sandbox is stored, and nothing needs to be: the sandbox name, the
 * workspace and the labels all derive from the id, which is also this directory — so there
 * is no mapping table to keep in step. The price is that an id which is not a usable path
 * segment would put an agent's transcript somewhere else entirely, and `..` would put it
 * outside the store. Refused at the one place an id enters.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function usable(id: string): string {
  if (!ID.test(id) || id === '.' || id === '..') {
    throw new StoreError(`\`${id}\` cannot be an agent id: it has to be usable as a directory name.`);
  }
  return id;
}

function parseState(value: unknown, at: string): AgentState {
  const source = value as Record<string, unknown> | null;
  if (typeof source !== 'object' || source === null) throw new StoreError(`${at} is not an object`);
  switch (source.status) {
    case 'working':
      return { status: 'working' };
    case 'dismissed':
      return { status: 'dismissed' };
    case 'waiting': {
      const request = source.request;
      if (request !== null && typeof request !== 'string') {
        throw new StoreError(`${at}.request is neither a request id nor null`);
      }
      return { status: 'waiting', request };
    }
    default:
      throw new StoreError(`${at}.status is "${String(source.status)}", which is not a state`);
  }
}

function parseStored(value: unknown, at: string): StoredAgent {
  const source = value as Record<string, unknown> | null;
  if (typeof source !== 'object' || source === null) throw new StoreError(`${at} is not an object`);
  const parent = source.parent;
  if (parent !== null && typeof parent !== 'string') throw new StoreError(`${at}.parent is neither an id nor null`);
  if (!Array.isArray(source.children) || source.children.some((child) => typeof child !== 'string')) {
    throw new StoreError(`${at}.children is missing or is not a list of ids`);
  }
  if (!Array.isArray(source.mailbox)) throw new StoreError(`${at}.mailbox is missing or is not a list`);

  return {
    state: parseState(source.state, `${at}.state`),
    parent,
    children: source.children as string[],
    mailbox: (source.mailbox as Record<string, unknown>[]).map((message, index) => {
      const from = message.from;
      if (from !== null && typeof from !== 'string') {
        throw new StoreError(`${at}.mailbox[${index}].from is neither an id nor null`);
      }
      if (typeof message.content !== 'string') throw new StoreError(`${at}.mailbox[${index}].content is not a string`);
      if (message.substrate !== undefined && message.substrate !== true) {
        throw new StoreError(`${at}.mailbox[${index}].substrate is present and is not true`);
      }
      return message.substrate === true
        ? { from, content: message.content, substrate: true }
        : { from, content: message.content };
    }),
  };
}

export class Store {
  readonly run: string;
  readonly #directory: string;
  readonly #records = new Map<string, AgentRecord>();
  readonly #agents = new Map<string, StoredAgent>();
  readonly #logs = new Map<string, FileHandle>();
  #root: string | null;

  private constructor(directory: string, header: RunHeader) {
    this.#directory = directory;
    this.run = header.run;
    this.#root = header.root;
  }

  /**
   * Open a run's store, creating it or reading back everything a previous one left.
   *
   * The reading-back is the whole of what a supervisor needs to survive being killed: every
   * agent's record, what it was doing, who its parent is and what was waiting for it. A
   * supervisor constructed over an existing store is where it was.
   */
  static async open(root: string, run: string): Promise<Store> {
    const directory = join(root, 'runs', usable(run));
    await mkdir(join(directory, 'agents'), { recursive: true });

    const path = join(directory, 'run.json');
    let header: RunHeader;
    try {
      header = JSON.parse(await readFile(path, 'utf8')) as RunHeader;
      if (header.run !== run) throw new StoreError(`${path} belongs to the run \`${header.run}\`, not to \`${run}\`.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      header = { run, created: new Date().toISOString(), root: null };
      await writeFile(path, `${JSON.stringify(header, null, 2)}\n`);
    }

    const store = new Store(directory, header);
    for (const id of await readdir(join(directory, 'agents')).catch(() => [])) {
      let record: AgentRecord;
      let stored: StoredAgent;
      try {
        record = parseRecord(JSON.parse(await readFile(store.#path(id, 'record.json'), 'utf8')));
        stored = parseStored(JSON.parse(await readFile(store.#path(id, 'state.json'), 'utf8')), id);
      } catch (error) {
        // **A half-written agent is one lost agent and must not be a lost run.** `add`
        // creates the directory, writes the record, and writes the state, so a supervisor
        // killed inside that sequence leaves a directory `readdir` returns and one of these
        // files missing — and a throw here does not lose that agent, it loses the *run*:
        // every other agent's record, state and transcript sits intact on disk and becomes
        // unreachable. The window is open for as long as any agent is being spawned, which
        // is most of a run's life, and this is the file whose whole purpose is surviving the
        // loss of every process.
        //
        // Only absence is skipped. A file that is present and unreadable is a different
        // thing — state is written by rename, so a torn one is not a shape this produces —
        // and swallowing it would turn a corrupted store into a quietly smaller one.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        process.stderr.write(`skipping \`${id}\` in ${directory}: it has no record or no state, so it never finished being created.\n`);
        continue;
      }
      store.#records.set(id, record);
      store.#agents.set(id, stored);
    }
    return store;
  }

  /** The agent nobody spawned, once there is one. */
  get root(): string | null {
    return this.#root;
  }

  /** Every agent this run has, in no particular order. */
  ids(): string[] {
    return [...this.#agents.keys()];
  }

  has(id: string): boolean {
    return this.#agents.has(id);
  }

  record(id: string): AgentRecord {
    const record = this.#records.get(id);
    if (record === undefined) throw new StoreError(`there is no agent \`${id}\` in this run.`);
    return record;
  }

  agent(id: string): StoredAgent {
    const agent = this.#agents.get(id);
    if (agent === undefined) throw new StoreError(`there is no agent \`${id}\` in this run.`);
    return agent;
  }

  /** Write an agent into existence. The record is written here and never again. */
  async add(record: AgentRecord, state: StoredAgent): Promise<void> {
    const id = usable(record.id);
    if (this.#agents.has(id)) throw new StoreError(`the agent \`${id}\` already exists in this run.`);

    await mkdir(this.#path(id), { recursive: true });
    await writeFile(this.#path(id, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    // Created here so that a log always exists to append to and to read, and so that an
    // agent with nothing in its transcript is an empty file rather than a missing one.
    await writeFile(this.#path(id, 'events.ndjson'), '', { flag: 'a' });
    this.#records.set(id, record);
    await this.save(id, state);

    if (record.parent === null && this.#root === null) {
      this.#root = id;
      await writeFile(
        join(this.#directory, 'run.json'),
        `${JSON.stringify({ run: this.run, created: new Date().toISOString(), root: id }, null, 2)}\n`,
      );
    }
  }

  /**
   * Record a transition, durably, before anyone is told it happened.
   *
   * Written beside and renamed over, rather than written in place. A rename is atomic where
   * a truncate-then-write is not, and the thing in the window is the file that says what
   * every agent in the run is doing — a crash inside it would leave a supervisor unable to
   * tell a suspended agent from a dead one, which is the one distinction the store exists
   * to carry.
   */
  async save(id: string, agent: StoredAgent): Promise<void> {
    const beside = this.#path(id, 'state.json.writing');
    const handle = await open(beside, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(agent, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(beside, this.#path(id, 'state.json'));
    this.#agents.set(id, agent);
  }

  /** Append one event. One write, and the file is never rewritten. */
  async append(id: string, event: Event): Promise<void> {
    const handle = await this.#log(id);
    await handle.write(`${JSON.stringify(event)}\n`);
  }

  /**
   * Put an agent's log beyond the reach of its body ending.
   *
   * Called before a container is destroyed, and the destruction waits for it. What this
   * prevents is worse than a lost transcript: an agent resumed from a log missing its final
   * steps does not fail — it repeats work it had already done, or reports on work that is
   * no longer there, and neither is distinguishable from an agent that behaved.
   */
  async sync(id: string): Promise<void> {
    await (await this.#log(id)).datasync();
  }

  /**
   * An agent's transcript, or a range of it.
   *
   * **A range is served without parsing the rest of the file.** Lines outside it are counted
   * and skipped, and reading stops once the range is full — a transcript grows without
   * bound, and a parent paging the last steps of a long session should not pay for the
   * whole of it.
   *
   * A line with no newline after it is not a line: that is a log whose writer was killed
   * mid-write, and it costs the last event and nothing before it.
   */
  async transcript(id: string, from = 0, count = Number.POSITIVE_INFINITY): Promise<Event[]> {
    const handle = await open(this.#path(id, 'events.ndjson'), 'r');
    const events: Event[] = [];
    let at = 0;
    let buffered = '';

    try {
      for await (const chunk of handle.createReadStream({ encoding: 'utf8' })) {
        buffered += chunk as string;
        for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (at >= from && events.length < count) {
            try {
              events.push(parseEvents([JSON.parse(line)], `${id}.events[${at}]`)[0]!);
            } catch (cause) {
              throw new StoreError(`the transcript of \`${id}\` could not be read at line ${at}.`, { cause });
            }
          }
          at += 1;
          if (events.length >= count) return events;
        }
      }
    } finally {
      await handle.close();
    }
    return events;
  }

  /** How many events an agent's transcript holds, so a reader knows what it can ask for. */
  async length(id: string): Promise<number> {
    const handle = await open(this.#path(id, 'events.ndjson'), 'r');
    let lines = 0;
    try {
      for await (const chunk of handle.createReadStream({ encoding: 'utf8' })) {
        for (const character of chunk as string) if (character === '\n') lines += 1;
      }
    } finally {
      await handle.close();
    }
    return lines;
  }

  async close(): Promise<void> {
    for (const handle of this.#logs.values()) await handle.close();
    this.#logs.clear();
  }

  async #log(id: string): Promise<FileHandle> {
    const held = this.#logs.get(id);
    if (held !== undefined) return held;
    if (!this.#agents.has(id)) throw new StoreError(`there is no agent \`${id}\` in this run.`);
    // Append mode, so every write lands at the end whatever else is happening, and there is
    // no offset for this process to get wrong or for another one to invalidate.
    const handle = await open(this.#path(id, 'events.ndjson'), 'a');
    this.#logs.set(id, handle);
    return handle;
  }

  #path(id: string, ...rest: string[]): string {
    return join(this.#directory, 'agents', usable(id), ...rest);
  }
}
