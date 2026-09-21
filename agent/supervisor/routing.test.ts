/**
 * The channel, the mailboxes, and the two paths a message reaches a conversation by.
 *
 * Driven against the scripted peer and the driver double, which is what lets a change that
 * is entirely about protocol and state be tested as one — with no container runtime, no
 * model, and nothing non-deterministic in the way of the properties under test.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { aRecord } from '../fixture.ts';
import { aRun, until, untilStored, type Run } from './double.ts';

const runs: Run[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.end();
});

/**
 * A root, and however many children below it, each already resident and at a boundary.
 *
 * Every agent here is granted every kind this file drives, because the supervisor reads the
 * caller's record before carrying any of them out and a tree of agents holding none could
 * only ever be asked about refusals. What a record has to *say* for a request to be accepted
 * is `spawn.test.ts`'s subject; this file is about what happens once it does.
 */
async function aTree(children = 0, opening = 'Begin.'): Promise<Run> {
  const run = await aRun();
  runs.push(run);
  const tools = ['spawn', 'stop', 'send', 'await', 'read'];
  await run.supervisor.add(aRecord({ id: 'a', parent: null, tools }), opening);

  for (let at = 1; at <= children; at++) {
    await run.supervisor.add(aRecord({ id: `a-${at}`, parent: 'a', tools }), 'Begin.');
  }
  return run;
}

describe('an agent is booted from its record and told what to do', () => {
  it('provisions, boots on the stored log, and delivers the opening message', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;

    const boot = JSON.parse(peer.boot) as { record: { id: string }; events: unknown[] };
    expect(boot.record.id).toBe('a');
    expect(boot.events).toEqual([]);
    await peer.until(() => peer.messages().length > 0);
    expect(peer.messages()).toEqual(['[from the human] Begin.']);
    expect(run.store.agent('a').state).toEqual({ status: 'working' });
  });

  it('stores every event the agent emits, in the order it emitted them', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.append({ type: 'charter', at: 't', content: 'Find out what is here.' });
    peer.append({ type: 'message', at: 't', from: 'parent', content: 'Begin.' });
    peer.append({ type: 'usage', at: 't', in: 1, out: 1, model: 'scripted' });
    peer.answered('Nothing is here.');

    await until(() => run.toHuman.length > 0, 'the turn ending');
    expect((await run.store.transcript('a')).map((event) => event.type)).toEqual(['charter', 'message', 'usage']);
  });
});

describe('a frame the supervisor cannot read is reported without disturbing anything', () => {
  it('tells the agent, and answers its outstanding requests anyway', async () => {
    const run = await aTree(1);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'send', { to: 'a-1', content: 'Get started.' });
    peer.raw('{ not a frame at all\n');
    peer.raw(`${JSON.stringify({ t: 'nonsense' })}\n`);
    peer.ask('a:2', 'send', { to: 'a-1', content: 'And this too.' });

    await peer.until(() => peer.answers().size === 2, 'both answers');
    expect([...peer.answers().keys()]).toEqual(['a:1', 'a:2']);
    expect(peer.received.filter((frame) => frame.t === 'malformed')).toHaveLength(2);
  });
});

describe('concurrent requests are told apart', () => {
  it('answers each with the id of the request it belongs to', async () => {
    const run = await aTree(2);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'send', { to: 'a-1', content: 'one' });
    peer.ask('a:2', 'send', { to: 'a-2', content: 'two' });
    peer.ask('a:3', 'read', { id: 'a-1' });

    await peer.until(() => peer.answers().size === 3, 'three answers');
    const answers = peer.answers();
    expect(answers.get('a:1')?.content).toBe('delivered to a-1');
    expect(answers.get('a:2')?.content).toBe('delivered to a-2');
    expect(JSON.parse(answers.get('a:3')!.content).id).toBe('a-1');
  });
});

describe('messages flow parent to child and no further', () => {
  it('carries a message from a parent to its child, and the child’s reply back', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const first = run.driver.latest('a-1')!;
    await first.until(() => first.messages().length > 0);

    // The child finishes its opening turn, which puts it at a boundary asking for nothing —
    // so its body goes, and the parent's next message is what wakes it.
    first.answered('Ready.');
    await until(() => run.driver.latest('a-1')!.destroyed, 'the child going dormant');

    parent.ask('a:1', 'send', { to: 'a-1', content: 'Look at the tree.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being woken');

    const woken = run.driver.latest('a-1')!;
    await woken.until(() => woken.messages().length > 0, 'the parent’s message');
    expect(woken.messages()).toEqual(['[from a] Look at the tree.']);

    woken.answered('Two files.');
    // Into the parent's mailbox, because the parent is still mid-turn — an in-flight turn is
    // not interrupted by a message's arrival, however welcome the message is.
    await until(() => run.store.agent('a').mailbox.length === 2, 'the child’s reply arriving');
    expect(run.store.agent('a').mailbox).toMatchObject([
      { from: 'a-1', content: 'Ready.' },
      { from: 'a-1', content: 'Two files.' },
    ]);
  });

  /**
   * A sibling is unreachable by construction rather than by a rule about who may talk to
   * whom: routing is a parent pointer and a list of children, so there is no route to
   * compute and nothing to check it against.
   */
  it('refuses a sibling observably, rather than dropping the message', async () => {
    const run = await aTree(2);
    const one = run.driver.latest('a-1')!;
    await one.until(() => one.messages().length > 0);

    one.ask('a-1:1', 'send', { to: 'a-2', content: 'psst' });
    await one.until(() => one.answers().size === 1, 'a refusal');

    const answer = one.answers().get('a-1:1')!;
    expect(answer.ok).toBe(false);
    expect(answer.content).toMatch(/neither your parent nor one of your children/);
    // Told it was refused rather than left believing it was sent, and nothing arrived.
    expect(run.store.agent('a-2').mailbox).toEqual([]);
  });

  it('refuses an agent that is not in the tree at all', async () => {
    const run = await aTree(1);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'send', { to: 'nobody', content: 'hello?' });
    await peer.until(() => peer.answers().size === 1);
    expect(peer.answers().get('a:1')?.ok).toBe(false);
  });
});

describe('the human is the root’s parent rather than an exception to the tree', () => {
  it('surfaces what the root says upward, and delivers what the human says back', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.answered('Here is what I found.');
    await until(() => run.toHuman.length > 0, 'a message reaching the human');
    expect(run.toHuman).toEqual([{ from: 'a', content: 'Here is what I found.' }]);

    await run.supervisor.tell('Now do the next thing.');
    await until(() => run.driver.all('a').length === 2, 'the root being woken');

    // The same path a parent's message takes, into the same position in the conversation.
    const woken = run.driver.latest('a')!;
    await woken.until(() => woken.messages().length > 0, 'the human’s message');
    expect(woken.messages()).toEqual(['[from the human] Now do the next thing.']);
  });
});

describe('a message chooses its path by what the agent is doing', () => {
  it('answers an agent that asked to receive one, rather than beginning a turn', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    // Resident while it waits, so the delivery is observable as an answer rather than as a
    // reboot — residency is what that number is.
    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent suspending');
    expect(run.store.agent('a').state).toEqual({ status: 'waiting', request: 'a:1' });

    child.answered('Two files.');
    await parent.until(() => parent.answers().size === 1, 'the awaited message');

    expect(parent.answers().get('a:1')).toEqual({ ok: true, content: '[from a-1] Two files.' });
    // Continued the turn it was in rather than being told to begin a new one.
    expect(parent.messages()).toEqual(['[from the human] Begin.']);
    expect(run.store.agent('a').state).toEqual({ status: 'working' });
  });

  it('holds a message for a working agent until it reaches a boundary', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await parent.until(() => parent.messages().length > 0);

    // Working: it was told to begin and has not answered.
    expect(run.store.agent('a').state).toEqual({ status: 'working' });
    child.answered('Two files.');

    // Waited for by the thing that actually happens rather than by a clock: the message is
    // in the mailbox, which is where a message for a working agent goes.
    await until(() => run.store.agent('a').mailbox.length > 0, 'the message being held');
    expect(run.store.agent('a').mailbox).toMatchObject([{ from: 'a-1', content: 'Two files.' }]);
    expect(parent.messages()).toEqual(['[from the human] Begin.']);

    // The turn runs to its end, and the message is there when it does.
    parent.answered('Done for now.');
    await parent.until(() => parent.messages().length > 1, 'the held message');
    expect(parent.messages().at(-1)).toBe('[from a-1] Two files.');
  });
});

describe('a message is durable before its sender is told it landed', () => {
  it('has written the mailbox by the time the acknowledgement goes out', async () => {
    const run = await aTree(1);
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'send', { to: 'a-1', content: 'Get started.' });
    await peer.until(() => peer.answers().size === 1, 'the acknowledgement');

    // Read from a second supervisor's view of the same directory rather than from memory:
    // `send` is fire-and-forget to its caller, so an acknowledgement that outran the write
    // would be the substrate lying about the one thing the caller can check.
    const again = await aRun({ directory: run.directory });
    runs.push(again);
    // Either still in the mailbox or already delivered — never lost.
    const child = again.store.agent('a-1');
    expect(child.mailbox.length > 0 || child.state.status === 'working').toBe(true);
  });
});

describe('a request kind nothing handles is an answer, not a transport failure', () => {
  it('tells the agent so and leaves the channel alone', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'teleport', {});
    peer.answered('Still here.');

    await peer.until(() => peer.answers().size === 1);
    expect(peer.answers().get('a:1')).toMatchObject({ ok: false });
    // The channel carried on: the turn frame behind the unhandled kind was still read.
    await until(() => run.toHuman.length > 0, 'the turn after it');
    expect(run.toHuman.at(-1)?.content).toBe('Still here.');
  });
});

/**
 * Bringing an agent into existence, and dismissing one.
 *
 * The agent-facing capability objects are ENG-197's; what is here is the supervisor's half —
 * the record it builds, the parentage it records, and the fact that a child's first message
 * arrives by the same path its hundredth will.
 */
describe('an agent spawns a child, and the child is an agent like any other', () => {
  it('builds the record, records the parentage, and delivers the opening message', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'spawn', { name: 'scout', charter: 'Find out what is here.', opening: 'Start looking.' });
    await peer.until(() => peer.answers().size === 1, 'the child’s id');

    const child = peer.answers().get('a:1')!.content;
    expect(child).toBe('a-1');
    expect(run.store.record(child)).toMatchObject({
      name: 'scout',
      charter: 'Find out what is here.',
      parent: 'a',
      // Inherited, so an agent that says only what its child is for gets one that can reach
      // the same provider from the same kind of sandbox.
      model: run.store.record('a').model,
      environment: run.store.record('a').environment,
      // And not widened: a child is granted nothing by default.
      tools: [],
    });
    expect(run.store.agent('a').children).toEqual([child]);

    const born = run.driver.latest(child)!;
    await born.until(() => born.messages().length > 0, 'its opening message');
    expect(born.messages()).toEqual(['[from a] Start looking.']);
  });

  /**
   * The id is the supervisor's, because an agent naming its own child's could name one that
   * already exists — and two agents sharing an id share a workspace, a transcript and a
   * mailbox.
   *
   * It used to be taken and quietly overwritten, which held the property and told the caller
   * nothing. A refusal holds it and says so, which matters because a parent that named an id
   * is a parent that is about to address its child by that id.
   */
  it('refuses a spawn that tries to name the child’s id, rather than overwriting it', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'spawn', { id: 'a', name: 'impostor', charter: 'Take over.' });
    await peer.until(() => peer.answers().size === 1);

    expect(peer.answers().get('a:1')?.ok).toBe(false);
    expect(peer.answers().get('a:1')?.content).toMatch(/`id`/);
    expect(run.store.agent('a').children).toEqual([]);
  });

  it('refuses a spawn that says nothing about what the child is for', async () => {
    const run = await aTree();
    const peer = run.driver.latest('a')!;
    await peer.until(() => peer.messages().length > 0);

    peer.ask('a:1', 'spawn', { name: 'nameless' });
    await peer.until(() => peer.answers().size === 1);
    expect(peer.answers().get('a:1')?.ok).toBe(false);
  });
});

describe('a dismissed agent ends, and its work does not', () => {
  it('ends the body, refuses further messages, and keeps the workspace', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);
    run.driver.workspace('a-1').set('found.md', 'two files');

    parent.ask('a:1', 'stop', { id: 'a-1' });
    await parent.until(() => parent.answers().size === 1, 'the dismissal');

    expect(parent.answers().get('a:1')).toEqual({ ok: true, content: 'stopped a-1' });
    expect(run.store.agent('a-1').state).toEqual({ status: 'dismissed' });
    expect(child.destroyed).toBe(true);
    // Keeping it is reversible and releasing it is not, and whatever a dismissed agent built
    // may be exactly what its parent dismissed it for.
    expect(run.driver.workspace('a-1').get('found.md')).toBe('two files');
    expect(run.driver.released).toEqual([]);

    parent.ask('a:2', 'send', { to: 'a-1', content: 'one more thing' });
    await parent.until(() => parent.answers().size === 2);
    expect(run.store.agent('a-1').mailbox).toEqual([]);
  });

  /**
   * A dismissed child stays in its parent's `children`, so routing passes for it and the
   * message is dropped where it is stored — which the sender was told was a delivery.
   *
   * A parent that sent into a dismissed child and was told it landed will wait on an answer
   * that cannot come, and will have been told by the substrate not to worry. A refusal is
   * the more useful answer as well as the true one: a parent that dismissed a child and then
   * addressed it has made a mistake it can reason about.
   */
  it('refuses a message addressed to a child it dismissed, rather than acknowledging it', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    parent.ask('a:1', 'stop', { id: 'a-1' });
    await parent.until(() => parent.answers().size === 1, 'the dismissal');

    parent.ask('a:2', 'send', { to: 'a-1', content: 'are you there' });
    await parent.until(() => parent.answers().size === 2, 'the answer to the send');

    expect(parent.answers().get('a:2')).toEqual({
      ok: false,
      content: '"a-1" has been dismissed, so nothing was sent.',
    });
    expect(run.store.agent('a-1').mailbox).toEqual([]);
  });

  /**
   * **Dismissal reaches the whole subtree, and the leak is why.**
   *
   * A dismissed agent's mailbox is never read again. A grandchild left running keeps a body,
   * keeps working, and keeps addressing a parent that has gone — so the one call whose
   * purpose is to end an agent would be the call that leaks containers, and would leak more
   * of them the deeper the subtree.
   */
  it('dismisses everything below the agent it dismissed', async () => {
    const run = await aTree(1);
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    child.ask('a-1:1', 'spawn', { name: 'below', charter: 'Look further.', opening: 'Begin.' });
    await until(() => run.driver.latest('a-1-1') !== undefined, 'the grandchild being booted');
    const grandchild = run.driver.latest('a-1-1')!;
    await grandchild.until(() => grandchild.messages().length > 0);
    run.driver.workspace('a-1-1').set('found.md', 'a day of work');

    const parent = run.driver.latest('a')!;
    parent.ask('a:1', 'stop', { id: 'a-1' });
    await parent.until(() => parent.answers().size === 1, 'the dismissal');

    expect(run.store.agent('a-1-1').state).toEqual({ status: 'dismissed' });
    expect(grandchild.destroyed).toBe(true);
    // Nothing of the subtree is left holding a body. The root is untouched, which is the
    // half that must not change.
    expect(run.driver.live.map((body) => body.agent)).toEqual(['a']);
    // Every workspace kept, at every depth: releasing one is irreversible and nothing asked
    // for it.
    expect(run.driver.workspace('a-1-1').get('found.md')).toBe('a day of work');
    expect(run.driver.released).toEqual([]);
  });

  it('refuses to dismiss anything that is not its own child', async () => {
    const run = await aTree(2);
    const one = run.driver.latest('a-1')!;
    await one.until(() => one.messages().length > 0);

    one.ask('a-1:1', 'stop', { id: 'a-2' });
    await one.until(() => one.answers().size === 1);
    expect(one.answers().get('a-1:1')?.ok).toBe(false);
    expect(run.store.agent('a-2').state.status).not.toBe('dismissed');
  });
});

/**
 * An agent with no body gets one when somebody addresses it.
 *
 * **The rule `resume()` already applies at recovery, applied at delivery.** Taking over a
 * store boots every agent recorded `working` with `owed: true` and lets each continue from
 * where it stopped; nothing about that reasoning is peculiar to a supervisor starting up.
 * An agent recorded working is owed a step whether its body was lost to a restart or to a
 * signal, an OOM, a daemon that went away, or a turn that failed inside it.
 *
 * Without it that state is a tombstone. `#ended` reports the ending and leaves the stored
 * state alone so the parent owns the decision — and the decision the parent owns was one it
 * could not carry out, because `#deliver` returned early on anything that was not `waiting`.
 * Its child's transcript and workspace were sitting there intact and the only responses
 * available were to replace it or to give up. See ENG-216.
 */
describe('an agent whose body ended is given a new one when it is addressed', () => {
  it('boots it owing a step, on its own transcript, and delivers at the boundary it reaches', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // A turn's worth of work, stored, so what the new body boots on can be told from an
    // empty log — this is the work a replacement would have thrown away.
    child.append({ type: 'charter', at: 't', content: 'Look at the tree.' });
    child.append({ type: 'message', at: 't', from: 'parent', content: 'Begin.' });
    await untilStored(async () => (await run.store.length('a-1')) === 2, "the child's work being stored");

    child.die();
    await until(() => run.store.agent('a').mailbox.length > 0, 'the ending reaching the parent');
    expect(run.store.agent('a-1').state).toEqual({ status: 'working' });
    expect(run.driver.all('a-1')).toHaveLength(1);

    // The parent does the thing the report invites: it tells the child to carry on.
    parent.ask('a:1', 'send', { to: 'a-1', content: 'Carry on.' });
    await until(() => run.driver.all('a-1').length === 2, 'the child being given a new body');

    const revived = run.driver.latest('a-1')!;
    const boot = JSON.parse(revived.boot) as { events: unknown[]; owed: boolean };
    // Owed, because it is continuing an unfinished turn rather than starting one — the same
    // frame `resume()` boots a recovered agent with.
    expect(boot.owed).toBe(true);
    expect(boot.events).toHaveLength(2);

    // **And what was pending is still pending.** An agent mid-turn is not at the boundary
    // where a message begins one, so the revival consumed nothing: the message is delivered
    // by the ordinary path when this body reaches a boundary of its own.
    expect(run.store.agent('a-1').mailbox).toMatchObject([{ from: 'a', content: 'Carry on.' }]);
    expect(revived.messages()).toEqual([]);

    revived.answered('Picked up where I left off.');
    await revived.until(() => revived.messages().length > 0, 'the held message at the boundary');
    expect(revived.messages()).toEqual(['[from a] Carry on.']);
  });

  it('does not revive an agent nobody has addressed', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    child.die();
    await until(() => run.store.agent('a').mailbox.length > 0, 'the ending reaching the parent');

    // Settles, one after another, each of which walks every agent in the run. Whether to
    // retry is the parent's judgment and this is the substrate declining to make it —
    // reviving on its own would also loop on an agent that dies whenever it is given a body.
    parent.answered('Noted.');
    await parent.until(() => parent.messages().length > 1, 'the ending reaching the conversation');
    parent.ask('a:1', 'await', {}, 60_000);
    await until(() => run.store.agent('a').state.status === 'waiting', 'the parent suspending');

    expect(run.driver.all('a-1')).toHaveLength(1);
    expect(run.store.agent('a-1').state).toEqual({ status: 'working' });
  });

  it('gives a second body to nobody that already has one', async () => {
    const run = await aTree(1);
    const parent = run.driver.latest('a')!;
    const child = run.driver.latest('a-1')!;
    await child.until(() => child.messages().length > 0);

    // Working *in a body* is an in-flight turn, which a message's arrival does not
    // interrupt — the case the old `status !== 'waiting'` guard was always really about.
    parent.ask('a:1', 'send', { to: 'a-1', content: 'One more thing.' });
    await parent.until(() => parent.answers().size === 1, 'the message being stored');

    expect(run.driver.all('a-1')).toHaveLength(1);
    expect(run.store.agent('a-1').mailbox).toMatchObject([{ from: 'a', content: 'One more thing.' }]);
    expect(child.messages()).toEqual(['[from a] Begin.']);
  });
});
