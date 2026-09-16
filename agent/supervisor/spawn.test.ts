/**
 * The spawn boundary: what a request has to say before a child exists, and what the child it
 * makes inherits.
 *
 * `routing.test.ts` covers what happens once a spawn is accepted — the parentage, the
 * opening message, the paths a message takes afterwards. This file is about the boundary in
 * front of that: the caller's record, the fields the supervisor owns, the tool subset, the
 * model identifier, and the fact that every refusal leaves nothing behind.
 *
 * **Every request here is a raw frame**, written onto the channel by a peer that reasons
 * about nothing. That is deliberate and it is the only honest way to test this: the model
 * never sees these frames, the schema in `runtime/main.ts` never filters them, and the agent
 * whose request should be trusted least is exactly the one that would send a frame no schema
 * shaped. What the runtime does with the declarations is `runtime/entry.test.ts`'s.
 */
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { aRun, until, untilStored, TestDriver, type Run } from './double.ts';
import { SandboxError } from '../sandbox/index.ts';
import { Store } from './store.ts';

import type { AgentRecord } from '../record.ts';
import type { Sandbox, SandboxRequest } from '../sandbox/index.ts';

const runs: Run[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.end();
});

/** A root holding whatever its tests need it to hold, resident and at a turn boundary. */
async function aRoot(tools: string[] = ['spawn', 'stop'], driver?: TestDriver): Promise<Run> {
  const run = await aRun(driver === undefined ? {} : { driver });
  runs.push(run);
  await run.supervisor.add(aRecord({ id: 'a', parent: null, tools }), 'Begin.');
  const peer = run.driver.latest('a')!;
  await peer.until(() => peer.messages().length > 0);
  return run;
}

/** Ask, wait for the answer, and hand it back. */
async function ask(run: Run, agent: string, kind: string, input: unknown): Promise<{ ok: boolean; content: string }> {
  const peer = run.driver.latest(agent)!;
  const id = `${agent}:${peer.answers().size + 1}`;
  peer.ask(id, kind, input);
  await peer.until(() => peer.answers().has(id), `an answer to ${id}`);
  return peer.answers().get(id)!;
}

describe('the caller’s record is what permits a spawn, and it is read at the channel', () => {
  /**
   * The runtime would not have offered `spawn` to this agent at all — its record does not
   * name it, so it is not in its registry and its model never saw the declaration. This
   * frame arrives anyway, which is the case the check exists for: a schema is a guide to a
   * model, and the channel is reachable without passing one.
   */
  it('refuses a raw spawn frame from an agent whose record does not grant it', async () => {
    const run = await aRoot([]);

    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.' });

    expect(answer.ok).toBe(false);
    expect(answer.content).toMatch(/`spawn`/);
    // Nothing anywhere: no record, no link on the parent, no mailbox, no body.
    expect(run.store.ids()).toEqual(['a']);
    expect(run.store.agent('a').children).toEqual([]);
    expect(run.driver.peers.map((body) => body.agent)).toEqual(['a']);
    expect(run.driver.workspaces.has('a-1')).toBe(false);
  });

  it('refuses a raw stop frame from an agent whose record does not grant it', async () => {
    const run = await aRoot(['spawn']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.' });

    const answer = await ask(run, 'a', 'stop', { id: 'a-1' });

    expect(answer.ok).toBe(false);
    expect(answer.content).toMatch(/`stop`/);
    expect(run.store.agent('a-1').state.status).not.toBe('dismissed');
  });

  it('accepts the same request from an agent whose record grants it', async () => {
    const run = await aRoot(['spawn']);
    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.' });
    expect(answer).toEqual({ ok: true, content: 'a-1' });
  });
});

describe('the fields that decide what a child can reach are the supervisor’s', () => {
  /**
   * Supplied and not honoured is the outcome worth refusing outright. A caller that named a
   * workspace believes its child will work there; ignoring it silently produces an agent
   * the parent has a wrong model of, and no way to discover it.
   */
  it.each([
    ['id', { id: 'a' }],
    ['parent', { parent: null }],
    ['credentials', { credentials: [{ name: 'X', ref: 'env:X' }] }],
    ['environment', { environment: 'evil/image:latest' }],
    ['workspace', { workspace: '/somewhere-else' }],
    ['provider', { provider: 'elsewhere' }],
    ['baseURL', { baseURL: 'https://elsewhere.example/v1' }],
    // The third of the endpoint trio. It cannot escalate — `parseRecord` refuses a
    // `model.credential` naming nothing in `credentials` — but accepting it silently is the
    // one thing this list exists to rule out, and it is the field the model was told it
    // could not set.
    ['credential', { credential: 'OTHER_KEY' }],
  ])('refuses a spawn that names `%s`, and creates nothing', async (field, extra) => {
    const run = await aRoot();

    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', ...extra });

    expect(answer.ok).toBe(false);
    expect(answer.content).toContain(`\`${field}\``);
    expect(run.store.ids()).toEqual(['a']);
    expect(run.store.agent('a').children).toEqual([]);
  });

  it('inherits the environment, workspace path and credential references unchanged', async () => {
    const run = await aRoot();
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.' });

    const parent = run.store.record('a');
    const child = run.store.record('a-1');
    expect(child.environment).toBe(parent.environment);
    // The same path inside the sandbox; what isolates the work is the child's own id, which
    // the sandbox keys its workspace on.
    expect(child.workspace).toBe(parent.workspace);
    expect(child.credentials).toEqual(parent.credentials);
    // References, never values: the record stays inert, so it is safe to persist and to hand
    // back to a parent asking what its child is.
    expect(child.credentials.every((reference) => reference.ref.startsWith('env:'))).toBe(true);
    expect(JSON.stringify(child)).not.toContain('sk-');
  });
});

describe('a spawn needs to say what the child is for', () => {
  it.each([
    ['neither name nor charter', {}],
    ['no charter', { name: 'scout' }],
    ['no name', { charter: 'Look around.' }],
    ['an empty name', { name: '', charter: 'Look around.' }],
    ['a whitespace charter', { name: 'scout', charter: '   ' }],
    ['a name that is not a string', { name: 7, charter: 'Look around.' }],
  ])('refuses one with %s', async (_what, input) => {
    const run = await aRoot();
    const answer = await ask(run, 'a', 'spawn', input);
    expect(answer.ok).toBe(false);
    expect(run.store.ids()).toEqual(['a']);
  });

  /**
   * Present and empty is refused rather than read as absent. Leaving `opening` out creates a
   * dormant child on purpose; an opening with nothing in it would start a body to read
   * nothing at all, and the two are different requests.
   */
  it.each([
    ['an empty opening', { opening: '' }],
    ['an opening that is not a string', { opening: { content: 'Begin.' } }],
  ])('refuses one with %s', async (_what, extra) => {
    const run = await aRoot();
    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', ...extra });
    expect(answer.ok).toBe(false);
    expect(answer.content).toMatch(/`opening`/);
    expect(run.store.ids()).toEqual(['a']);
  });
});

/**
 * **Capability physics, not a role policy.** What a record can authorize is decided here, at
 * the one place a record is constructed; who *should* hold what is a judgment the substrate
 * leaves to the weights. The consequence is that the authority of a subtree can only ever
 * narrow going down, and "this agent cannot do X" is true rather than merely asked for.
 */
describe('a child is narrower than its parent or equal to it, and never wider', () => {
  it('grants exactly the subset that was asked for', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: ['stop'] });
    expect(run.store.record('a-1').tools).toEqual(['stop']);
  });

  it('grants everything the parent holds where the request names all of it', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: ['spawn', 'stop'] });
    expect(run.store.record('a-1').tools).toEqual(['spawn', 'stop']);
  });

  /**
   * Omission grants none rather than inheriting, so a child is capable only because a parent
   * chose to make it so. Inheriting by default would widen a tree by omission, and `spawn`
   * itself is the capability that would ride furthest on it.
   */
  it('grants none where the request names no tools at all', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.' });
    expect(run.store.record('a-1').tools).toEqual([]);
  });

  /**
   * Refused rather than intersected. Silently dropping the name would acknowledge a child
   * that cannot do what its parent asked of it, and the parent would never find out — it
   * asked for a capable agent and was handed an id.
   */
  it('refuses a tool the parent does not hold, naming it, and creates nothing', async () => {
    const run = await aRoot(['spawn']);

    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: ['spawn', 'read'] });

    expect(answer.ok).toBe(false);
    expect(answer.content).toContain('"read"');
    expect(run.store.ids()).toEqual(['a']);
    expect(run.store.agent('a').children).toEqual([]);
    expect(run.driver.peers.map((body) => body.agent)).toEqual(['a']);
  });

  it.each([
    ['a duplicate', ['spawn', 'spawn']],
    ['a name that is not a string', ['spawn', 7]],
    ['something that is not a list', 'spawn'],
  ])('refuses %s in `tools`', async (_what, tools) => {
    const run = await aRoot(['spawn']);
    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools });
    expect(answer.ok).toBe(false);
    expect(answer.content).toContain('`tools`');
    expect(run.store.ids()).toEqual(['a']);
  });

  /** A grandchild cannot recover what its parent was not given, however it is asked for. */
  it('stops a capability at the depth it was withheld', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: ['spawn'], opening: 'Begin.' });
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    const answer = await ask(run, 'a-1', 'spawn', { name: 'below', charter: 'Look further.', tools: ['stop'] });

    expect(answer.ok).toBe(false);
    expect(answer.content).toContain('"stop"');
    expect(run.store.agent('a-1').children).toEqual([]);
  });
});

/**
 * A model choice is an identifier and nothing else.
 *
 * The risk it is narrowed against is specific: a whole model configuration would let a spawn
 * point the **parent's inherited credential** at an endpoint of the caller's choosing, while
 * reading in a transcript as an agent picking a model. So `provider`, `baseURL` and
 * `credential` stay the parent's, and anything that is not a non-empty string is refused
 * rather than reached into.
 */
describe('a child reasons at its parent’s endpoint, whatever model it is given', () => {
  it('inherits the whole model configuration where the request names none', async () => {
    const run = await aRoot();
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.' });
    expect(run.store.record('a-1').model).toEqual(run.store.record('a').model);
  });

  it('replaces the identifier and nothing else where the request names one', async () => {
    const run = await aRoot();
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', model: 'openai/o4-mini' });

    const parent = run.store.record('a').model;
    expect(run.store.record('a-1').model).toEqual({ ...parent, model: 'openai/o4-mini' });
    expect(run.store.record('a-1').model.provider).toBe(parent.provider);
    expect(run.store.record('a-1').model.baseURL).toBe(parent.baseURL);
    expect(run.store.record('a-1').model.credential).toBe(parent.credential);
  });

  it.each([
    ['an empty identifier', ''],
    ['whitespace', '  '],
    ['a whole configuration', { model: 'm', baseURL: 'https://elsewhere.example/v1', credential: 'X' }],
    ['a number', 7],
    ['null', null],
  ])('refuses %s as a model, before anything is created', async (_what, model) => {
    const run = await aRoot();
    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', model });
    expect(answer.ok).toBe(false);
    expect(answer.content).toContain('`model`');
    expect(run.store.ids()).toEqual(['a']);
  });

  /**
   * **Choosing a model is not choosing an assistant.** The coding assistant is a separate
   * capability with a subprocess and possibly a credential of its own (ENG-211), and nothing
   * about a reasoning-model identifier may reach it. There is no assistant yet, so the claim
   * is made the only way it can be made now and the strongest way it could be made later:
   * the child's record differs from its parent's in the five fields a spawn is allowed to
   * decide, and is identical in every other field the record type has — so a field added for
   * an assistant is one this test starts failing on the day a spawn touches it.
   */
  it('changes nothing in the record but the five fields a spawn decides', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', {
      name: 'scout',
      charter: 'Look around.',
      tools: ['stop'],
      model: 'openai/o4-mini',
    });

    const parent = run.store.record('a');
    const child = run.store.record('a-1');
    const decided = new Set(['id', 'name', 'charter', 'tools', 'parent']);
    for (const field of Object.keys(parent) as (keyof AgentRecord)[]) {
      if (decided.has(field)) continue;
      const expected = field === 'model' ? { ...parent.model, model: 'openai/o4-mini' } : parent[field];
      expect({ [field]: child[field] }).toEqual({ [field]: expected });
    }
  });
});

/**
 * The runtime is the same at every depth and so is this path. `parent: null` is not a flag
 * the supervisor branches on — it says who is above an agent, and the agent nobody spawned
 * has nobody. Depth is data.
 */
describe('an agent that was spawned spawns agents of its own', () => {
  it('builds a grandchild by the same path and with the same shape as a child', async () => {
    const run = await aRoot(['spawn']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: ['spawn'], opening: 'Begin.' });
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    const answer = await ask(run, 'a-1', 'spawn', { name: 'below', charter: 'Look further.', opening: 'Begin.' });
    expect(answer).toEqual({ ok: true, content: 'a-1-1' });

    const grandchild = run.store.record('a-1-1');
    expect(grandchild.parent).toBe('a-1');
    expect(run.store.agent('a-1').children).toEqual(['a-1-1']);
    // Identical in everything the depth could have changed, which is the property ENG-194
    // asks for: the same record type, built from the same inheritance, at both depths.
    expect(grandchild.model).toEqual(run.store.record('a').model);
    expect(grandchild.environment).toBe(run.store.record('a').environment);
    expect(grandchild.workspace).toBe(run.store.record('a').workspace);
    expect(grandchild.credentials).toEqual(run.store.record('a').credentials);

    const born = run.driver.latest('a-1-1')!;
    await born.until(() => born.messages().length > 0, 'its opening message');
    expect(born.messages()).toEqual(['Begin.']);
  });

  it('refuses a grandchild’s spawn on the grandchild’s own record, not its ancestors’', async () => {
    const run = await aRoot(['spawn']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.' });
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // The root holds `spawn` and this agent's parent held it too. It was not granted, so it
    // does not have it, and no ancestor's holding it makes any difference.
    const answer = await ask(run, 'a-1', 'spawn', { name: 'below', charter: 'Look further.' });
    expect(answer.ok).toBe(false);
    expect(run.store.ids()).toEqual(['a', 'a-1']);
  });
});

describe('an opening starts the child, and its absence leaves a valid dormant one', () => {
  it('reaches the child’s first turn by the path every later message takes', async () => {
    const run = await aRoot();
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Start looking.' });

    const born = run.driver.latest('a-1')!;
    await born.until(() => born.messages().length > 0, 'its opening message');
    expect(born.messages()).toEqual(['Start looking.']);
    expect(run.store.agent('a-1').state).toEqual({ status: 'working' });
  });

  /**
   * A child with nothing to do is a whole agent, not a half-made one. Its record and its
   * parentage are stored and its id is returned, so its parent can address it later — at
   * which point it is woken by exactly the path any other message takes.
   */
  it('stores a child with no opening, and starts no body for it', async () => {
    const run = await aRoot();
    const answer = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.' });

    expect(answer).toEqual({ ok: true, content: 'a-1' });
    expect(run.store.agent('a-1')).toMatchObject({ state: { status: 'waiting', request: null }, mailbox: [] });
    expect(run.store.agent('a').children).toEqual(['a-1']);
    expect(run.driver.latest('a-1')).toBeUndefined();
  });
});

/**
 * **Fan-out with no scheduler.** An agent spawns several, then collects them; nothing here
 * plans that, and nothing here waits. The property is what `spawn` does *not* do — it does
 * not join — and it is asserted as such: four ids come back while all four children are
 * still in flight and none has reported.
 *
 * What is deliberately not claimed is that four records are written at once. Everything that
 * changes state in this supervisor runs one at a time, on purpose, so the four are
 * constructed in sequence. Each returns after construction rather than after child work,
 * which is where the parallelism actually is.
 */
describe('four children in flight before their parent’s next step', () => {
  it('answers each with a distinct id without waiting for any of them', async () => {
    const run = await aRoot();
    const peer = run.driver.latest('a')!;

    // Written onto the channel in immediate succession, with nothing awaited in between —
    // which is what a model calling `spawn` four times in one step produces.
    for (let at = 1; at <= 4; at += 1) {
      peer.ask(`a:${at}`, 'spawn', { name: `scout-${at}`, charter: `Look at ${at}.`, opening: 'Begin.' });
    }
    await peer.until(() => peer.answers().size === 4, 'four ids');

    const ids = [...peer.answers().values()].map((answer) => answer.content);
    expect(ids).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);
    expect(new Set(ids).size).toBe(4);
    expect([...peer.answers().values()].every((answer) => answer.ok)).toBe(true);

    // All four in flight at the moment the parent has its ids: each holds a body and none
    // has reported. The parent has taken no step since, and was never made to wait for one.
    await until(() => ids.every((id) => run.driver.latest(id) !== undefined), 'four bodies');
    expect(run.driver.live.map((body) => body.agent).sort()).toEqual(['a', 'a-1', 'a-2', 'a-3', 'a-4']);
    expect(ids.every((id) => run.store.agent(id).state.status === 'working')).toBe(true);
    expect(run.toHuman).toEqual([]);
  });

  /**
   * An acknowledged spawn survives the supervisor that made it. Answering before the write
   * would make a successful answer a promise a crash could take back — the parent holding an
   * id for an agent that no longer exists anywhere.
   */
  it('has written every child and its parentage by the time it answers', async () => {
    const run = await aRoot();
    const peer = run.driver.latest('a')!;
    for (let at = 1; at <= 4; at += 1) {
      peer.ask(`a:${at}`, 'spawn', { name: `scout-${at}`, charter: `Look at ${at}.`, ...(at === 4 ? {} : { opening: 'Begin.' }) });
    }
    await peer.until(() => peer.answers().size === 4, 'four ids');

    const reopened = await Store.open(join(run.directory, '.jen'), 'r1');
    expect(reopened.ids().sort()).toEqual(['a', 'a-1', 'a-2', 'a-3', 'a-4']);
    expect(reopened.agent('a').children).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);

    for (let at = 1; at <= 4; at += 1) {
      const id = `a-${at}`;
      expect(reopened.record(id)).toEqual(run.store.record(id));
      expect(reopened.record(id).parent).toBe('a');
      // The three that carried an opening are recorded mid-turn, which is the stored trace
      // of the opening having left the mailbox into a body. The fourth carried none and is
      // stored dormant with an empty mailbox, which is a whole agent waiting to be addressed.
      expect(reopened.agent(id).state.status).toBe(at === 4 ? 'waiting' : 'working');
      expect(reopened.agent(id).mailbox).toEqual([]);
    }

    // And a mailbox entry that has *not* been delivered is durable in its own right, which
    // is the other half of the same claim: a message for an agent mid-turn waits in the
    // store rather than in this process, so it survives the supervisor that took it.
    await ask(run, 'a', 'send', { to: 'a-1', content: 'One more thing.' });
    const after = await Store.open(join(run.directory, '.jen'), 'r1');
    expect(after.agent('a-1').mailbox).toMatchObject([{ from: 'a', content: 'One more thing.' }]);
  });

  /**
   * The same claim from inside the window, because the test above can only read the store
   * after the fact. Provisioning a child's body happens inside the spawn and **before** its
   * id is answered, so a store read there is a store read before the parent was told
   * anything — and the record, the parent link and the delivery are all in it already.
   */
  it('has them on disk before the body that carries the opening even starts', async () => {
    const seen: { ids: string[]; children: string[]; state: string }[] = [];
    const run = await aRun();
    runs.push(run);

    const driver = run.driver;
    const create = driver.create.bind(driver);
    driver.create = async (request: SandboxRequest): Promise<Sandbox> => {
      if (request.id === 'a-1') {
        const reopened = await Store.open(join(run.directory, '.jen'), 'r1');
        seen.push({
          ids: reopened.ids().sort(),
          children: reopened.agent('a').children,
          state: reopened.agent('a-1').state.status,
        });
      }
      return create(request);
    };

    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['spawn'] }), 'Begin.');
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.' });
    await peer.until(() => peer.answers().size === 1, 'the id');

    expect(seen).toEqual([{ ids: ['a', 'a-1'], children: ['a-1'], state: 'working' }]);
  });
});

/**
 * Dismissal, from the side `routing.test.ts` does not cover: who may ask for it, and what a
 * child's report does and does not mean.
 */
describe('a dismissal reaches a subtree and keeps everything it built', () => {
  it('keeps every record, transcript and workspace in the subtree it ends', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: ['spawn'], opening: 'Begin.' });
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    await ask(run, 'a-1', 'spawn', { name: 'below', charter: 'Look further.', opening: 'Begin.' });
    const grandchild = run.driver.latest('a-1-1')!;
    await grandchild.until(() => grandchild.messages().length > 0);

    grandchild.append({ type: 'message', at: 't', from: 'parent', content: 'Begin.' });
    await untilStored(async () => (await run.store.transcript('a-1-1')).length > 0, 'the grandchild’s transcript');
    run.driver.workspace('a-1-1').set('found.md', 'a day of work');

    expect(await ask(run, 'a', 'stop', { id: 'a-1' })).toEqual({ ok: true, content: 'stopped a-1' });

    // No body anywhere below the agent that was dismissed. The root keeps its own.
    expect(run.driver.live.map((body) => body.agent)).toEqual(['a']);
    for (const id of ['a-1', 'a-1-1']) {
      expect(run.store.agent(id).state).toEqual({ status: 'dismissed' });
      expect(run.store.record(id).id).toBe(id);
    }
    expect((await run.store.transcript('a-1-1')).map((event) => event.type)).toEqual(['message']);
    expect(run.driver.workspace('a-1-1').get('found.md')).toBe('a day of work');
    expect(run.driver.released).toEqual([]);
  });

  /**
   * **A report is not a completion.** There is no finished state: an agent that answered its
   * parent is dormant, and stays addressable until it is stopped. A substrate that dismissed
   * a child on its report would be deciding that the work was done, which is the parent's
   * judgment and not the supervisor's.
   */
  it('leaves a child that reported available for a later message', async () => {
    const run = await aRoot(['spawn', 'stop']);
    await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', tools: [], opening: 'Begin.' });
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    child.answered('Two files.');
    await until(() => run.driver.latest('a-1')!.destroyed, 'the child going dormant');

    expect(run.store.agent('a-1').state).toEqual({ status: 'waiting', request: null });
    expect(run.store.ids()).toContain('a-1');

    // Addressed again, and woken by the ordinary path into a fresh body.
    expect(await ask(run, 'a', 'send', { to: 'a-1', content: 'One more thing.' })).toEqual({
      ok: true,
      content: 'delivered to a-1',
    });
    await until(() => run.driver.all('a-1').length === 2, 'the child being woken');
    const woken = run.driver.latest('a-1')!;
    await woken.until(() => woken.messages().length > 0);
    expect(woken.messages()).toEqual(['One more thing.']);
  });
});

/**
 * **What a refusal does not cover, pinned here because the line next to it is so easy to
 * read as covering everything.**
 *
 * Every refusal this change makes happens before anything is written, and the tests above
 * say so. A spawn that fails while *provisioning* the child's body is a different thing
 * entirely and it is not this change's to settle — the delivery path it fails on belongs to
 * the supervisor's own settling, which every request ends with, so answering it differently
 * for `spawn` alone would make `spawn` disagree with `send` about what a failed settle
 * means.
 *
 * So this states today's behaviour rather than endorsing it, and it is written to fail the
 * moment somebody changes it deliberately. See `AGENTS.md` beside this file, and the thread
 * on the pull request.
 */
describe('a spawn that cannot provision a body is refused, and the child exists anyway', () => {
  it('tells the parent its spawn failed while leaving a whole child behind', async () => {
    const run = await aRun({ onFailure: null });
    runs.push(run);

    const driver = run.driver;
    const create = driver.create.bind(driver);
    driver.create = async (request: SandboxRequest): Promise<Sandbox> => {
      if (request.id === 'a-1') throw new SandboxError('the daemon went away.');
      return create(request);
    };

    await run.supervisor.add(aRecord({ id: 'a', parent: null, tools: ['spawn'] }), 'Begin.');
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    const first = await ask(run, 'a', 'spawn', { name: 'scout', charter: 'Look around.', opening: 'Begin.' });

    // Refused — and the record, the parent link and the undelivered opening are all there.
    expect(first.ok).toBe(false);
    expect(run.store.ids()).toEqual(['a', 'a-1']);
    expect(run.store.agent('a').children).toEqual(['a-1']);
    expect(run.store.agent('a-1').mailbox).toMatchObject([{ from: 'a', content: 'Begin.' }]);

    /**
     * And the part that is genuinely surprising: the *next* spawn is refused too, with the
     * first child's error. Settling walks every agent, so the child that cannot be
     * provisioned is retried inside every later request and fails it — while the second
     * child is created and linked exactly as asked. The parent is told twice that nothing
     * happened and now has two children it will never address.
     */
    const second = await ask(run, 'a', 'spawn', { name: 'again', charter: 'Look again.' });
    expect(second).toEqual(first);
    expect(run.store.ids()).toEqual(['a', 'a-1', 'a-2']);
    expect(run.store.agent('a').children).toEqual(['a-1', 'a-2']);
    expect(run.store.record('a-2').charter).toBe('Look again.');
  });
});
