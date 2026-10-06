import assert from 'node:assert/strict';
import test from 'node:test';
import { model, setup } from './harness.mjs';
import { historyCursor, historyPage } from '../src/pages.mjs';

test('filtered history pages preserve anchors and stop after finding the next page', () => {
  const values = Array.from({ length: 100 }, (_, id) => ({ id: String(id), visible: id % 3 === 0 }));
  const context = { threadId: 'thread', scope: 'items' };
  const getId = value => value.id;
  let visited = 0;
  const filter = value => { visited++; return value.visible; };
  const first = historyPage(values, { limit: 2 }, getId, context, filter);
  assert.deepEqual(first, {
    data: [values[0], values[3]], nextCursor: historyCursor('3', false, context),
    backwardsCursor: historyCursor('0', true, context),
  });
  assert.equal(visited, 7);
  const next = historyPage(values, { limit: 2, cursor: first.nextCursor }, getId, context, filter);
  assert.deepEqual(next.data, [values[6], values[9]]);
  assert.deepEqual(historyPage(values, { limit: 2, cursor: next.backwardsCursor }, getId, context, filter), next);
  const tail = historyPage(values, { limit: 2, cursor: historyCursor('95', true, context) }, getId, context, filter);
  assert.deepEqual(tail.data, [values[96], values[99]]);
  assert.equal(tail.nextCursor, null);
  assert.deepEqual(historyPage(values, { cursor: historyCursor('99', false, context) }, getId, context, filter), {
    data: [], nextCursor: null, backwardsCursor: null,
  });
});

test('real Pi search occurrences and timeline preserve Unicode ranges, pagination and restart anchors', async t => {
  const env = await setup(t);
  const first = env.start();
  const { client } = first;
  const { thread } = await client.request('thread/start', { model });
  const threadId = thread.id;
  const search = params => client.request('thread/searchOccurrences', { threadId, ...params });
  const timeline = params => client.request('thread/timeline/list', { threadId, ...params });
  const completed = await client.turn(threadId, '😀 Needle needle İ &amp; **visible** [label](https://hidden.example)');
  const occurrences = await search({ searchTerm: 'needle' });
  assert.equal(occurrences.data.length, 4);
  assert.ok(occurrences.data.every(hit => hit.turnId === completed.id));
  assert.deepEqual(occurrences.data[0].snippetMatchRange, { start: 3, end: 9 });
  const anchored = await client.request('thread/turns/list', { threadId, cursor: occurrences.data[0].turnCursor, itemsView: 'full' });
  assert.equal(anchored.data[0].id, completed.id);
  const userId = anchored.data[0].items.find(item => item.type === 'userMessage').id;
  const assistantId = anchored.data[0].items.findLast(item => item.type === 'agentMessage').id;
  assert.deepEqual(occurrences.data.map(hit => hit.itemId), [userId, userId, assistantId, assistantId]);
  const firstOccurrence = await search({ searchTerm: 'needle', limit: 1 });
  const remaining = await search({ searchTerm: 'needle', cursor: firstOccurrence.nextCursor });
  assert.deepEqual([firstOccurrence.data[0], ...remaining.data], occurrences.data);
  assert.equal(remaining.nextCursor, null);
  for (const searchTerm of ['', ' \n ', 'NEEDLE']) {
    const response = await client.raw('thread/searchOccurrences', { threadId, searchTerm, cursor: firstOccurrence.nextCursor });
    assert.equal(response.error.code, -32602);
  }
  const { thread: other } = await client.request('thread/start', { model });
  assert.equal((await client.raw('thread/searchOccurrences', { threadId: other.id, searchTerm: 'needle', cursor: firstOccurrence.nextCursor })).error.code, -32602);
  assert.deepEqual((await search({ searchTerm: 'hidden.example' })).data.map(hit => hit.itemId), [userId]);
  const entity = (await search({ searchTerm: '&' })).data.find(hit => hit.itemId === assistantId);
  assert.ok(entity.snippet.includes('İ & visible label'));
  assert.equal(entity.snippet.slice(entity.snippetMatchRange.start, entity.snippetMatchRange.end), '&');
  const expanded = (await search({ searchTerm: 'i' })).data.filter(hit => hit.snippet.slice(hit.snippetMatchRange.start, hit.snippetMatchRange.end) === 'İ');
  assert.equal(expanded.length, 2);
  assert.ok(expanded.every(hit => hit.snippetMatchRange.end - hit.snippetMatchRange.start === 1));

  const page = await timeline({ limit: 3 });
  assert.deepEqual(page.data.map(entry => entry.type), ['item', 'item', 'turnCompleted']);
  assert.deepEqual(page.data.map(entry => entry.position), [1, 2, 3]);
  assert.equal(page.activeRealtimeSessionAtPageStart, null);
  assert.equal(page.data[2].started_at, anchored.data[0].startedAt);
  assert.equal(page.data[2].completed_at, anchored.data[0].completedAt);
  const older = await timeline({ cursor: page.nextCursor });
  assert.deepEqual(older.data.map(entry => entry.type), ['turnStarted']);
  assert.equal(older.nextCursor, null);
  assert.equal((await client.raw('thread/timeline/list', { threadId: other.id, cursor: page.nextCursor })).error.code, -32602);

  await client.turn(threadId, '😀'.repeat(60) + 'MATCH' + '😀'.repeat(110));
  const long = (await search({ searchTerm: 'match' })).data[0];
  assert.ok(long.snippet.startsWith('... '));
  assert.ok(long.snippet.endsWith(' ...'));
  assert.equal(long.snippetMatchRange.start, 4 + 49 * 2);
  assert.equal(long.snippet.slice(long.snippetMatchRange.start, long.snippetMatchRange.end), 'MATCH');
  assert.deepEqual(await timeline({ cursor: page.nextCursor }), older);
  assert.deepEqual((await search({ searchTerm: 'needle', cursor: firstOccurrence.nextCursor })).data.slice(0, 3), remaining.data);

  const { turn: active } = await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'hold', text_elements: [] }] });
  await client.notification('item/agentMessage/delta', params => params.turnId === active.id);
  const live = await timeline({});
  assert.ok(live.data.some(entry => entry.type === 'turnStarted' && entry.turn_id === active.id));
  assert.ok(!live.data.some(entry => entry.type === 'turnCompleted' && entry.turn_id === active.id));
  await client.request('turn/interrupt', { threadId, turnId: active.id });
  await client.notification('turn/completed', params => params.turn.id === active.id);

  const savedSearch = await search({ searchTerm: 'needle' });
  const savedTimeline = await timeline({});
  await first.protocol.close();
  const second = env.start();
  assert.deepEqual(await second.client.request('thread/searchOccurrences', { threadId, searchTerm: 'needle' }), savedSearch);
  const restored = await second.client.request('thread/timeline/list', { threadId });
  assert.deepEqual(restored.data.filter(entry => entry.type === 'item').map(entry => entry.item.id), savedTimeline.data.filter(entry => entry.type === 'item').map(entry => entry.item.id));
});
