import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { methodStatus } from '../src/methods.mjs';
import { Protocol } from '../src/protocol.mjs';
import { protocolMethods } from '../src/schema.mjs';
import { methodsDoc } from '../scripts/methods-doc.mjs';

test('the method table matches the vendored schema and METHODS.md', async () => {
  for (const [method, [status]] of Object.entries(methodStatus)) {
    assert.ok(method === 'getAuthStatus' || protocolMethods.requests[method], `${method} (${status}) is not in the Codex schema or the legacy auth contract`);
  }
  assert.equal(await readFile(new URL('../METHODS.md', import.meta.url), 'utf8'), methodsDoc(), 'Run node scripts/methods-doc.mjs > METHODS.md');
});

test('desktop legacy auth handshake uses Pi-managed auth without exporting or refreshing credentials', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'remote-auth-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const unavailable = async () => { throw new Error('Auth handshake must not open a Pi runtime'); };
  const protocol = new Protocol({
    stateDir, cwd: stateDir,
    sessions: { open: unavailable, close: async () => {} },
    history: { listSessions: async () => [], readHistory: unavailable, projectTurns: () => [] },
  });
  t.after(() => protocol.close());
  const output = [];
  const emit = message => output.push(message);
  await protocol.handle({ id: 1, method: 'initialize', params: { clientInfo: { name: 'desktop', version: 'test' } } }, emit);
  assert.equal(output.at(-1).error, undefined);
  // Legacy v1 GetAuthStatusResponse; absent from the vendored v2 JSON schema.
  const expected = { authMethod: null, authToken: null, requiresOpenaiAuth: false };
  for (const params of [undefined, {}, { includeToken: null, refreshToken: null },
    ...[false, true].flatMap(includeToken => [false, true].map(refreshToken => ({ includeToken, refreshToken })))]) {
    await protocol.handle({ id: 2, method: 'getAuthStatus', params }, emit);
    assert.deepEqual(output.at(-1), { id: 2, result: expected });
  }
  await protocol.handle({ id: 3, method: 'account/read', params: {} }, emit);
  assert.deepEqual(output.at(-1), { id: 3, result: { account: null, requiresOpenaiAuth: false } });
  await protocol.handle({ id: 4, method: 'unknownAuthMethod', params: {} }, emit);
  assert.equal(output.at(-1).error.code, -32601);
});

test('exactly the requests in the method table are routed', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'remote-methods-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const unavailable = async () => { throw new Error('No Pi runtime in this test'); };
  const protocol = new Protocol({
    stateDir, cwd: stateDir,
    sessions: { open: unavailable, close: async () => {} },
    history: { listSessions: async () => [], readHistory: unavailable, projectTurns: () => [] },
    trash: { assertSessionNotOpen: async () => {} },
  });
  t.after(() => protocol.close());
  for (const method of new Set([...Object.keys(protocolMethods.requests), ...Object.keys(methodStatus)])) {
    const output = [];
    await protocol.handle({ id: 1, method, params: { threadId: 'missing' } }, message => output.push(message));
    assert.equal(output[0].error?.code === -32601, !methodStatus[method], method);
  }
});
