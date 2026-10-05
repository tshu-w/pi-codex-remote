import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Remote } from '../src/remote.mjs';

function remote(t, options = {}) {
  const instance = new Remote({ handle() {}, ...options });
  instance.state = { installationId: 'test' };
  instance.persist = () => Promise.resolve();
  t.after(() => instance.dispatcher.destroy());
  return instance;
}

const backlogBytes = instance => [...instance.pending.values()].flat()
  .reduce((total, frame) => total + Buffer.byteLength(JSON.stringify(frame)), 0);

test('outbound backlog enforces encoded byte cap and releases capacity on ACK and client closure', async t => {
  const instance = remote(t);
  const cap = 100 * 1024 * 1024;
  let sentBytes = 0;
  instance.socket = { readyState: 1, send(text) { sentBytes += Buffer.byteLength(text); } };
  const message = { id: 1, result: '中'.repeat(33_000) };
  const chunkedMessage = { id: 2, result: '中🙂'.repeat(40_000) };
  let count = 0;
  for (;;) {
    const next = { client_id: 'client', stream_id: 'stream', seq_id: count + 1, type: 'server_message', message };
    const nextBytes = Buffer.byteLength(JSON.stringify(next));
    if (sentBytes + nextBytes > cap) {
      assert.throws(() => instance.emit('client', 'stream', message), /acknowledgement backlog/);
      assert.throws(() => instance.emit('client', 'stream', chunkedMessage), /acknowledgement backlog/);
      assert.equal(instance.sequences.get('client\0stream'), count);
      break;
    }
    await instance.emit('client', 'stream', message);
    count++;
  }
  assert.equal(instance.pending.size, count);
  assert.equal(backlogBytes(instance), sentBytes);
  await instance.receive({ type: 'ack', client_id: 'client', stream_id: 'stream', seq_id: count - 1 });
  assert.equal(instance.pending.size, 1);
  await instance.emit('client', 'stream', chunkedMessage);
  await instance.emit('client', 'other', message);
  await instance.receive({ type: 'client_closed', client_id: 'client', stream_id: 'stream' });
  assert.equal(instance.pending.size, 1);
  await instance.receive({ type: 'client_closed', client_id: 'client' });
  assert.equal(instance.pending.size, 0);
  await instance.emit('new-client', 'stream', message);
  assert.equal(instance.pending.size, 1);
});

test('cached chunk sizes follow partial and duplicate ACKs and reconnect replay', async t => {
  const replayed = [];
  const instance = remote(t, {
    socketFactory() {
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1, send(text) { replayed.push(JSON.parse(text)); }, ping() {}, terminate() {},
      });
      queueMicrotask(() => { socket.emit('open'); queueMicrotask(() => socket.emit('close')); });
      return socket;
    },
  });
  await instance.emit('client', 'stream', { id: 1, result: '中🙂'.repeat(40_000) });
  const frames = instance.pending.get(`client\0stream\0${1}`);
  assert.ok(frames.length > 1);
  for (const frame of frames) assert.equal(instance.frameSize(frame), Buffer.byteLength(JSON.stringify(frame)));
  const total = backlogBytes(instance);
  const acknowledged = instance.frameSize(frames[0]);
  const ack = { type: 'ack', client_id: 'client', stream_id: 'stream', seq_id: 1, segment_id: 0 };
  await instance.receive(ack);
  assert.equal(backlogBytes(instance), total - acknowledged);
  await instance.receive(ack);
  await instance.receive({ ...ack, seq_id: 2 });
  assert.equal(backlogBytes(instance), total - acknowledged);
  await instance.connect({ remote_control_token: 'test', server_id: 'test' });
  assert.deepEqual(replayed, frames.slice(1));
  assert.equal(backlogBytes(instance), total - acknowledged);
  await instance.receive({ type: 'ack', client_id: 'client', stream_id: 'stream', seq_id: 1 });
  assert.equal(instance.pending.size, 0);
  await instance.emit('client', 'stream', { id: 2, result: 'ok' });
  assert.equal(instance.pending.size, 1);
});
