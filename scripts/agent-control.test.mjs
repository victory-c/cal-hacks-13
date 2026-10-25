import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeJudge, subscribeEvents } from '@canon/shared';
import { startServer } from '../server/src/app.ts';
import { FileStore } from '../server/src/store.ts';
import { KeywordRetriever } from '../server/src/retrieval/keyword.ts';
import { simulatedScopeAnswers } from '../server/src/scope-judge.ts';
import { Dispatcher } from '../distiller/src/dispatch/dispatcher.ts';
import { createDispatchClient } from '../distiller/src/dispatch/client.ts';
import { createDispatchHandler } from '../distiller/src/dispatch/handler.ts';
import { TemplateBriefWriter } from '../distiller/src/dispatch/brief.ts';
import { CancelledError } from '../distiller/src/dispatch/runners/types.ts';
import { unlockForCleanup } from '../distiller/src/dispatch/sandbox.ts';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('HTTP rule edit reaches a running agent over SSE; Stop aborts it and survives missed events/restart', { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bullwark-control-data-'));
  const root = await mkdtemp(join(tmpdir(), 'bullwark-control-runs-'));
  const at = new Date().toISOString();
  const world = {
    groups: [{ id: 'market/public', description: 'Public research holdings' }],
    principals: [
      { id: 'wags', kind: 'person', name: 'Wags', tier: 'moderator' },
      { id: 'ben', kind: 'person', name: 'Ben Kim', tier: 'member' },
      { id: 'axe', kind: 'person', name: 'Axe', tier: 'member' },
      { id: 'research-agent', kind: 'agent', name: 'Research agent', created_by: 'ben' },
    ],
    rules: ['ben', 'research-agent'].map(principal => ({ principal, task: 'Public research holdings', exclude: { groups: [], labels: [] }, set_by: principal === 'ben' ? 'wags' : 'ben', updated_at: at })),
    initial_scopes: ['ben', 'research-agent'], scopes: [], audit: [], quarantine: [],
  };
  const grants = ['wags', 'ben', 'axe'].map(client => ({ client, principal: client, read: [], write: [] }));
  grants.push({ client: 'dispatcher', read: [], write: [] });
  const tokens = new Map(grants.map(g => ['test-' + g.client, g.client]));
  const judge = new FakeJudge({ override: simulatedScopeAnswers });
  const store = new FileStore(dataDir);
  await store.putFact({ id: 'fct_aa1122', folder: 'market/public', author: 'ben', statement: 'Public research holdings are 210000 shares', tier: 'hot', jev_keep: 0.99, updated: '2026-10-24', source: { client: 'ingest', session: 'ses_aa1122' } });
  const start = () => startServer({ dataDir, world, grants, tokens, judge, retriever: new KeywordRetriever(), log: () => {} });
  let server = await start();
  const request = (path, body, client = 'ben', method = body === undefined ? 'GET' : 'POST') => fetch(server.url + path, { method, headers: { authorization: 'Bearer test-' + client, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const snapshots = [];
  const signals = [];
  const runner = { name: 'fake', simulated: true, async step(req) {
    const names = await readdir(join(req.dir, 'facts'));
    snapshots.push(await Promise.all(names.filter(name => name !== 'README.md').map(name => readFile(join(req.dir, 'facts', name), 'utf8'))));
    signals.push(req.signal);
    await new Promise((resolve, reject) => {
      if (req.signal.aborted) return reject(new CancelledError());
      req.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    });
    return { done: false, summary: 'unreachable' };
  } };
  const client = createDispatchClient({ baseUrl: server.url, token: 'test-dispatcher' });
  const dispatcher = new Dispatcher({ client, runner, briefWriter: new TemplateBriefWriter(), root, recordsRoot: false });
  const handler = createDispatchHandler({ dispatcher, client, judge });
  let open;
  let dropStops = false;
  const connected = new Promise(resolve => { open = resolve; });
  const close = subscribeEvents(server.url + '/events', event => {
    if (dropStops && event.type === 'dispatch.stop_requested') return;
    void handler(event);
  }, { headers: { authorization: 'Bearer test-dispatcher' }, onOpen: open });
  try {
    await connected;
    assert.equal((await request('/api/agents/research-agent/run', {})).status, 200);
    await until(() => signals.length === 1);
    assert.match(snapshots[0].join(''), /210000/);
    const edited = await request('/api/principals/ben/rule', { task: 'Public research holdings', exclusions: { groups: ['market/public'], labels: [], text: [] } }, 'wags', 'PUT');
    assert.equal(edited.status, 200, await edited.text());
    await until(() => signals.length === 2);
    assert.equal(signals[0].aborted, true);
    assert.deepEqual(snapshots[1], [], 'fresh folder no longer holds the removed fact');
    assert.equal(dispatcher.list()[0].restarts, 1);
    const forbidden = await request('/api/agents/research-agent/stop', {}, 'axe');
    const absent = await request('/api/agents/not-present/stop', {}, 'axe');
    assert.equal(forbidden.status, 403);
    assert.equal(await forbidden.text(), await absent.text(), 'unknown and unowned agents have the same denial');
    assert.equal((await request('/api/agents/research-agent/control', undefined, 'ben')).status, 403);
    const stopped = await request('/api/agents/research-agent/stop', {});
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { generation: 1, status: 'stop_requested' });
    await until(() => dispatcher.list()[0].state === 'cancelled');
    await dispatcher.settle();
    assert.equal(signals[1].aborted, true);
    await until(async () => (await (await request('/api/agents')).json()).agents[0].status === 'stopped');
    assert.deepEqual(await (await request('/api/sessions?pending=1', undefined, 'dispatcher')).json(), { sessions: [] });

    // A fresh Run observes generation 1. Replaying that Stop cannot cancel it.
    assert.equal((await request('/api/agents/research-agent/run', {})).status, 200);
    await until(() => signals.length === 3);
    await handler({ type: 'dispatch.stop_requested', agent: 'research-agent', by: 'ben', generation: 1, at });
    assert.equal(signals[2].aborted, false);
    dropStops = true;
    assert.equal((await request('/api/agents/research-agent/stop', {}, 'wags')).status, 200);
    await dispatcher.resync();
    await until(() => signals[2].aborted);
    await dispatcher.settle();

    // The save gate also rejects a worker whose Stop event was lost.
    const late = await request('/api/sessions', { id: 'ses_bb1122', client: 'dispatcher', principal: 'ben', started_at: at, ended_at: at, messages: [{ role: 'assistant', content: 'Late output' }], meta: { agent: 'research-agent', stop_generation: 1 } }, 'dispatcher');
    assert.equal(late.status, 409);
    // Stop also wins while dispatch is still awaiting its rule, before any run exists.
    dropStops = false;
    const getRule = client.getScopeRule.bind(client);
    let releaseRule;
    let readingRule = false;
    client.getScopeRule = async agent => {
      readingRule = true;
      await new Promise(resolve => { releaseRule = resolve; });
      return getRule(agent);
    };
    assert.equal((await request('/api/agents/research-agent/run', {})).status, 200);
    await until(() => readingRule);
    assert.equal((await request('/api/agents/research-agent/stop', {})).status, 200);
    await until(() => server.world.agentStops.get('research-agent') === 3);
    // The event handler must have processed the Stop before releasing the blocked rule.
    await handler({ type: 'dispatch.stop_requested', agent: 'research-agent', by: 'ben', generation: 3, at });
    releaseRule();
    await handler.settle();
    await dispatcher.settle();
    assert.equal(dispatcher.list().at(-1).state, 'cancelled');
    assert.equal(signals.length, 3, 'the cancelled pending request never invoked the runtime');
    // A queued pre-Stop request recovered after an outage must not start using a newer generation.
    client.getScopeRule = getRule;
    await handler({ type: 'dispatch.requested', id: 'dsp_recovered', at: new Date().toISOString(), request: { agent: 'research-agent', by: 'ben', stop_generation: 2 } });
    await dispatcher.settle();
    assert.equal(dispatcher.list().at(-1).state, 'cancelled');
    assert.equal(signals.length, 3);
    close();
    await server.close();
    server = await start();
    assert.deepEqual(await (await request('/api/agents/research-agent/control', undefined, 'dispatcher')).json(), { generation: 3 });
    assert.equal((await (await request('/api/agents')).json()).agents[0].status, 'stopped');
  } finally {
    close();
    for (const run of dispatcher.list()) dispatcher.cancel(run.id, 'test cleanup');
    await handler.settle();
    await dispatcher.settle();
    await server.close();
    unlockForCleanup(root);
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
