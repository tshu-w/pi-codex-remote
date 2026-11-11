import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source;
    if (specifier === '@earendil-works/pi-coding-agent') source = 'export const resizeImage = () => { throw new Error("Unexpected image resize"); };';
    if (specifier === '@earendil-works/pi-tui') source = 'export class Loader {} export class Text {}';
    if (specifier === './src/daemon.mjs') source = 'export const control = () => { throw new Error("Input must not control the relay"); }; export const start = control; export const setEnabled = control; export const paths = () => ({ enabled: "/nonexistent" });';
    return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : nextResolve(specifier, context);
  },
});
let codexRemote;
try { ({ default: codexRemote } = await import('../index.ts')); }
finally { hooks.deregister(); }

test('the next interactive message hides pairing UI without consuming input or controlling the relay', async () => {
  const handlers = new Map();
  codexRemote({
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand() {},
  });
  const widgets = new Map([['codex-remote-pair', 'pairing QR']]);
  const changes = [];
  const ui = { setWidget(name, value) { changes.push([name, value]); widgets.set(name, value); } };
  const input = async (mode, source) => {
    const event = { text: 'hello', source };
    for (const handler of handlers.get('input')) assert.equal(await handler(event, { mode, ui }), undefined);
    assert.deepEqual(event, { text: 'hello', source });
  };
  await input('tui', 'extension');
  await input('rpc', 'rpc');
  assert.equal(widgets.get('codex-remote-pair'), 'pairing QR');
  assert.deepEqual(changes, []);
  await input('tui', 'interactive');
  assert.deepEqual(changes, [['codex-remote-pair', undefined]]);
  assert.equal(widgets.get('codex-remote-pair'), undefined);
});
