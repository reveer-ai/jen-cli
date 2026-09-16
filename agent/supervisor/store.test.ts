/**
 * The store, on a real filesystem.
 *
 * Nothing is mocked here for the same reason `sandbox/docker.test.ts` mocks nothing: every
 * property this file claims — that a log only grows, that a kill mid-write costs the last
 * line and nothing before it, that a supervisor constructed over a store is where it was —
 * is a property of what the filesystem actually did.
 */
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { Store, StoreError, type StoredAgent } from './store.ts';

import type { Event } from '../runtime/events.ts';

const open: Store[] = [];

afterEach(async () => {
  for (const store of open.splice(0)) await store.close();
});

async function aStore(run = 'r1'): Promise<{ store: Store; root: string }> {
  const root = join(await mkdtemp(join(tmpdir(), 'jen-store-')), '.jen');
  const store = await Store.open(root, run);
  open.push(store);
  return { store, root };
}

function waiting(parent: string | null = null): StoredAgent {
  return { state: { status: 'waiting', request: null }, parent, children: [], mailbox: [] };
}

function anEvent(content: string): Event {
  return { type: 'message', at: '2026-01-01T00:00:00.000Z', from: 'self', content };
}

describe('the run has a shape on disk', () => {
  it('lays out a run, and an agent’s three files', async () => {
    const { store, root } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());

    expect(JSON.parse(await readFile(join(root, 'runs', 'r1', 'run.json'), 'utf8'))).toMatchObject({
      run: 'r1',
      root: 'a',
    });
    expect((await readdir(join(root, 'runs', 'r1', 'agents', 'a'))).sort()).toEqual([
      'events.ndjson',
      'record.json',
      'state.json',
    ]);
  });

  /**
   * The id is the directory name, which is what keeps the store free of a mapping table —
   * the sandbox name, the workspace and the labels all derive from the id too. The price is
   * that an id which is not a usable path segment would put an agent's transcript somewhere
   * else entirely, and `..` would put it outside the store.
   */
  it('refuses an id that is not a usable directory name', async () => {
    const { store } = await aStore();
    for (const id of ['../escape', 'a/b', '', '.', 'has space']) {
      await expect(store.add(aRecord({ id }), waiting())).rejects.toThrow(StoreError);
    }
  });

  it('refuses to write a record twice, because a record is written once', async () => {
    const { store } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());
    await expect(store.add(aRecord({ id: 'a' }), waiting())).rejects.toThrow(/already exists/);
  });
});

describe('a transcript only ever grows', () => {
  it('appends one object per line and never rewrites the file', async () => {
    const { store, root } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());

    for (const word of ['one', 'two', 'three']) await store.append('a', anEvent(word));

    const raw = await readFile(join(root, 'runs', 'r1', 'agents', 'a', 'events.ndjson'), 'utf8');
    expect(raw.split('\n').filter((line) => line !== '')).toHaveLength(3);
    expect(await store.transcript('a')).toMatchObject([{ content: 'one' }, { content: 'two' }, { content: 'three' }]);
    expect(await store.length('a')).toBe(3);
  });

  /**
   * The failure this shape is chosen for. A JSON array would mean removing the closing
   * bracket, adding the event and rewriting — with a window between the truncate and the
   * write in which a crash loses the whole transcript rather than one event of it.
   */
  it('loses the last line to a kill mid-write, and nothing before it', async () => {
    const { store, root } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());
    for (const word of ['one', 'two', 'three']) await store.append('a', anEvent(word));
    await store.sync('a');

    const path = join(root, 'runs', 'r1', 'agents', 'a', 'events.ndjson');
    const whole = await readFile(path, 'utf8');
    // Half of the last line, which is what a process killed between two writes leaves.
    await truncate(path, whole.length - (whole.split('\n').at(-2)?.length ?? 0) / 2);

    expect(await store.transcript('a')).toMatchObject([{ content: 'one' }, { content: 'two' }]);
  });

  it('serves a range, and can be read through in parts', async () => {
    const { store } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());
    for (let at = 0; at < 20; at++) await store.append('a', anEvent(`event-${at}`));

    expect((await store.transcript('a', 5, 3)).map((event) => (event as { content: string }).content)).toEqual([
      'event-5',
      'event-6',
      'event-7',
    ]);
    expect(await store.transcript('a', 19, 5)).toHaveLength(1);
    expect(await store.transcript('a', 25, 5)).toHaveLength(0);
  });

  /**
   * A transcript grows without bound, so a parent paging the last steps of a long session
   * must not pay for the whole of it. Asserted by putting something unparseable outside the
   * range: a reader that parsed the rest of the file would fail on it.
   */
  it('serves a range without parsing a line outside it', async () => {
    const { store, root } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());
    await store.append('a', anEvent('first'));
    await store.append('a', anEvent('second'));
    await store.close();

    const path = join(root, 'runs', 'r1', 'agents', 'a', 'events.ndjson');
    await writeFile(path, `${await readFile(path, 'utf8')}{ this is not an event }\n`);

    const reopened = await Store.open(root, 'r1');
    open.push(reopened);
    expect(await reopened.transcript('a', 0, 2)).toHaveLength(2);
    // And a range that does reach it says so, rather than quietly serving a short answer.
    await expect(reopened.transcript('a', 0, 3)).rejects.toThrow(StoreError);
  });
});

/**
 * What a supervisor reads back after being killed. Everything the suspension model needs is
 * here: what each agent was doing, who its parent is, and what was still waiting for it.
 */
describe('a store is read back whole by whoever opens it next', () => {
  it('gives back every agent’s state, parentage, children and mailbox', async () => {
    const { store, root } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());
    await store.add(aRecord({ id: 'b', parent: 'a' }), waiting('a'));
    await store.save('a', {
      state: { status: 'working' },
      parent: null,
      children: ['b'],
      mailbox: [{ from: 'b', content: 'half done' }],
    });
    await store.save('b', {
      state: { status: 'waiting', request: 'b:3' },
      parent: 'a',
      children: [],
      mailbox: [{ from: null, content: 'b terminated: exit 137', substrate: true }],
    });
    await store.append('a', anEvent('something'));
    await store.sync('a');
    await store.close();

    const reopened = await Store.open(root, 'r1');
    open.push(reopened);

    expect(reopened.ids().sort()).toEqual(['a', 'b']);
    expect(reopened.root).toBe('a');
    expect(reopened.agent('a')).toEqual({
      state: { status: 'working' },
      parent: null,
      children: ['b'],
      mailbox: [{ from: 'b', content: 'half done' }],
    });
    expect(reopened.agent('b').state).toEqual({ status: 'waiting', request: 'b:3' });
    // The substrate's marking survives the trip, which is what keeps a parent from being
    // misled about who spoke after a restart.
    expect(reopened.agent('b').mailbox[0]).toEqual({
      from: null,
      content: 'b terminated: exit 137',
      substrate: true,
    });
    expect(reopened.record('b').parent).toBe('a');
    expect(await reopened.transcript('a')).toMatchObject([{ content: 'something' }]);
  });

  /**
   * **One half-written agent must not be a lost run.**
   *
   * `add` makes the directory, writes the record and writes the state, so a supervisor
   * killed inside that sequence leaves a directory `readdir` returns with one of the two
   * files missing. Throwing on it does not lose that agent — it loses every *other* agent's
   * record, state and transcript, all of it intact on disk and none of it reachable, in the
   * file whose whole purpose is surviving the loss of every process. The window is open for
   * as long as any agent is being spawned, which is most of a run's life.
   */
  it('skips an agent that never finished being created, and opens the run anyway', async () => {
    const { store, root } = await aStore();
    await store.add(aRecord({ id: 'a' }), waiting());
    await store.add(aRecord({ id: 'b', parent: 'a' }), waiting('a'));
    await store.append('a', anEvent('a day of work'));
    await store.sync('a');

    // The shape a kill between the record and the state leaves behind.
    await store.add(aRecord({ id: 'c', parent: 'a' }), waiting('a'));
    await store.close();
    await rm(join(root, 'runs', 'r1', 'agents', 'c', 'state.json'));

    const reopened = await Store.open(root, 'r1');
    open.push(reopened);

    expect(reopened.ids().sort()).toEqual(['a', 'b']);
    expect(reopened.has('c')).toBe(false);
    // The point of it: everything else came back, transcripts included.
    expect(await reopened.transcript('a')).toMatchObject([{ content: 'a day of work' }]);
    // And it is still on disk, so nothing was tidied away by being skipped.
    expect(await readdir(join(root, 'runs', 'r1', 'agents', 'c'))).toContain('record.json');
  });

  it('keeps two runs under one root from seeing each other', async () => {
    const { store, root } = await aStore('r1');
    await store.add(aRecord({ id: 'a' }), waiting());

    const other = await Store.open(root, 'r2');
    open.push(other);

    expect(other.ids()).toEqual([]);
    expect(other.root).toBeNull();
    // And the first is untouched by the second having been opened beside it.
    const reopened = await Store.open(root, 'r1');
    open.push(reopened);
    expect(reopened.ids()).toEqual(['a']);
  });
});
