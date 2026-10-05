import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RpcSession } from '../src/sessions.mjs';

test('RPC framing preserves chunked Unicode responses, events and invalid-output failures', async t => {
  let signal;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(value) { signal = value; },
  });
  t.after(() => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy(); });
  const rpc = new RpcSession(child, { cwd: '/tmp', requestTimeoutMs: 1000, onState() {}, onClose() {} });
  const events = [];
  rpc.onEvent(event => events.push(event.type));
  const data = { entries: [{ text: '中文🙂\u2028\u2029\n'.repeat(8192) }] };
  const result = rpc.request('get_entries');
  const command = JSON.parse(child.stdin.read().toString());
  const wire = Buffer.from([
    '', JSON.stringify({ type: 'agent_start' }),
    JSON.stringify({ type: 'response', id: command.id, success: true, data }),
    JSON.stringify({ type: 'agent_settled' }), '',
  ].join('\r\n'));
  // Odd byte boundaries split UTF-8 characters, CRLF pairs and JSON records.
  for (let offset = 0; offset < wire.length; offset += 31) child.stdout.write(wire.subarray(offset, offset + 31));
  assert.deepEqual(await result, data);
  assert.deepEqual(events, ['agent_start', 'agent_settled']);
  assert.equal(rpc.state.isStreaming, false);

  const failed = rpc.request('get_entries');
  child.stdout.write('invalid JSON\n');
  await assert.rejects(failed, /Invalid Pi RPC output/);
  assert.equal(signal, 'SIGTERM');
});
