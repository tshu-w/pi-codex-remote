import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codeVersion, createRetirement, paths, setEnabled } from '../src/daemon.mjs';

const temporary = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-remote-daemon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('one of several daemons starting at once takes over a stale lock', async t => {
  const dir = await temporary(t);
  // Locks of a crashed daemon, in both formats.
  await writeFile(join(dir, 'daemon.lock'), '999999\n');
  await writeFile(join(dir, 'daemon.999998.lock'), '');
  const url = new URL('../src/daemon.mjs', import.meta.url).href;
  const contender = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { acquireLock } = await import(${JSON.stringify(url)});
      try { await acquireLock(${JSON.stringify(dir)}); console.log('held'); await new Promise(r => setTimeout(r, 2000)); }
      catch (error) { console.log(error.message); }`]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('exit', () => resolve(output.trim()));
  });
  const results = await Promise.all(Array.from({ length: 4 }, contender));
  assert.deepEqual(results.sort(), ['Codex Remote daemon is already running', 'Codex Remote daemon is already running', 'Codex Remote daemon is already running', 'held']);
  assert.equal(existsSync(join(dir, 'daemon.lock')), false);
});

test('stop clears what pair and start enable', async t => {
  const dir = await temporary(t);
  const statePaths = { state: join(dir, 'state'), enabled: join(dir, 'state', 'enabled') };
  await setEnabled(true, statePaths);
  assert.equal(existsSync(statePaths.enabled), true);
  await setEnabled(false, statePaths);
  await setEnabled(false, statePaths);
  assert.equal(existsSync(statePaths.enabled), false);
});

test('code outside a git checkout is known by its package version', async t => {
  const dir = await temporary(t);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(await codeVersion(dir), '1.2.3');
});

test('a retiring daemon hands over once idle, only to code on disk that loads, and not again to code that failed', async () => {
  let disk = 'new';
  let idle = false;
  let loadable = false;
  const loaded = [];
  let handovers = 0;
  let versionError;
  const retire = createRetirement({ initial: 'old', current: async () => { if (versionError) throw versionError; return disk; }, idle: () => idle, loads: async () => { loaded.push(disk); return loadable; }, handover: () => handovers++, intervalMs: 5 });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await retire('old'), false, 'the same code does not retire');
  assert.equal(await retire('other'), false, 'a Pi that loaded code no longer on disk does not decide');
  versionError = new Error('git failed');
  await assert.rejects(retire('new'), versionError);
  versionError = undefined;
  assert.deepEqual(await Promise.all([retire('new'), retire('new')]), [true, false], 'concurrent requests retire once');
  await settle();
  assert.deepEqual([loaded, handovers], [[], 0], 'a busy daemon waits');
  idle = true;
  await settle();
  assert.deepEqual([loaded, handovers], [['new'], 0], 'code that does not load is tried once');
  assert.equal(await retire('new'), false);
  disk = 'fixed';
  loadable = true;
  assert.equal(await retire('fixed'), true);
  await settle();
  assert.deepEqual([loaded, handovers], [['new', 'fixed'], 1]);
});

test('stop cancels an automatic start awaiting its log, without blocking an explicit start', async t => {
  const dir = await temporary(t);
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  t.after(() => { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; });
  const p = paths();
  await setEnabled(true);
  let ready;
  let resume;
  const opened = new Promise(resolve => { ready = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  let spawned = 0;
  const server = createServer(socket => socket.once('data', () => socket.end(`${JSON.stringify({ result: { status: 'connected' } })}\n`)));
  t.after(() => new Promise(resolve => server.close(resolve)));
  globalThis.codexRemoteOpen = async log => { ready(); await paused; return log; };
  globalThis.codexRemoteSpawn = () => {
    spawned++;
    server.listen(p.socket);
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  t.after(() => { delete globalThis.codexRemoteOpen; delete globalThis.codexRemoteSpawn; });
  const url = new URL(`../src/daemon.mjs?${encodeURIComponent(t.name)}`, import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL !== url) return nextResolve(specifier, context);
      const source = specifier === 'node:fs/promises'
        ? `export * from 'node:fs/promises'; import { open as realOpen } from 'node:fs/promises'; export const open = async (...args) => globalThis.codexRemoteOpen(await realOpen(...args));`
        : specifier === 'node:child_process'
          ? `export { execFile } from 'node:child_process'; export const spawn = (...args) => globalThis.codexRemoteSpawn(...args);` : undefined;
      return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  let start;
  try { ({ start } = await import(url)); }
  finally { hooks.deregister(); }
  const automatic = start({ auto: true });
  await opened;
  await setEnabled(false);
  resume();
  assert.equal(await automatic, undefined);
  assert.equal(spawned, 0, 'an automatic start must not spawn after stop');
  assert.equal((await start()).status, 'connected');
  assert.equal(spawned, 1, 'an explicit start is not conditional on the auto-start flag');
});

async function loadExtension(t, daemon) {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const source = specifier === './src/daemon.mjs' ? daemon
        : specifier === '@earendil-works/pi-coding-agent' ? 'export const resizeImage = () => {}; export const keyHint = (key, text) => key + " " + text;'
          : specifier === '@earendil-works/pi-tui' ? 'export class Loader { setMessage() {} stop() {} } export const truncateToWidth = text => text;' : undefined;
      return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  try { return (await import(`../index.ts?${t.name}`)).default; }
  finally { hooks.deregister(); }
}

function register(codexRemote) {
  const handlers = new Map();
  let command;
  codexRemote({ on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]), registerCommand: (_name, options) => { command = options; } });
  return { handlers, command: () => command };
}

test('Pi sessions start an enabled daemon, retire one running other code, and stop keeps it stopped', async t => {
  const dir = await temporary(t);
  const enabled = join(dir, 'enabled');
  const calls = globalThis.codexRemoteDaemonCalls = [];
  globalThis.codexRemoteDaemonVersion = 'loaded';
  const codexRemote = await loadExtension(t, `import { rmSync, writeFileSync } from 'node:fs';
    const calls = globalThis.codexRemoteDaemonCalls;
    export const codeVersion = async () => 'loaded';
    export const paths = () => ({ enabled: ${JSON.stringify(enabled)} });
    export const setEnabled = async on => on ? writeFileSync(${JSON.stringify(enabled)}, '') : rmSync(${JSON.stringify(enabled)}, { force: true });
    export const start = async () => { calls.push('start'); return { status: 'connected', log: 'log', version: globalThis.codexRemoteDaemonVersion }; };
    export const control = async (action, _paths, params) => { calls.push(params ? [action, params] : action); return { status: 'connected', log: 'log' }; };`);
  const { handlers, command } = register(codexRemote);
  const ui = { notify() {}, setWidget() {}, setStatus() {} };
  const sessionManager = { getSessionFile: () => undefined, getSessionId: () => 'session' };
  const sessionStart = async (mode = 'rpc') => {
    calls.length = 0;
    for (const handler of handlers.get('session_start')) await handler({}, { mode, ui, sessionManager });
    await new Promise(resolve => setTimeout(resolve, 10));
    return [...calls];
  };
  assert.deepEqual(await sessionStart(), [], 'nothing starts before pairing or start');
  await command().handler('start', { mode: 'tui', ui });
  assert.deepEqual(await sessionStart(), ['start']);
  globalThis.codexRemoteDaemonVersion = 'earlier';
  assert.deepEqual(await sessionStart(), ['start', ['retire', { version: 'loaded' }]]);
  await command().handler('stop', { mode: 'tui', ui });
  assert.deepEqual(await sessionStart(), [], 'stop sticks');
});

test('model changes notify only an enabled running daemon and notification failure does not fail the switch', async t => {
  const dir = await temporary(t);
  const enabled = join(dir, 'enabled');
  const socket = join(dir, 'control.sock');
  const calls = globalThis.codexRemoteModelCalls = [];
  t.after(() => { delete globalThis.codexRemoteModelCalls; });
  const codexRemote = await loadExtension(t, `
    export const codeVersion = async () => 'loaded';
    export const paths = () => (${JSON.stringify({ enabled, socket })});
    export const setEnabled = async () => {};
    export const start = async () => { throw new Error('must not start a daemon'); };
    export const control = async (...args) => { globalThis.codexRemoteModelCalls.push(args); throw new Error('daemon stopped'); };`);
  const { handlers } = register(codexRemote);
  const changed = async () => {
    for (const handler of handlers.get('model_select')) await handler({}, { sessionManager: { getSessionId: () => 'session' } });
    await new Promise(resolve => setImmediate(resolve));
  };
  await writeFile(socket, '');
  await changed();
  assert.deepEqual(calls, [], 'a disabled daemon is not notified');
  await rm(socket);
  await writeFile(enabled, '');
  await changed();
  assert.deepEqual(calls, [], 'a stopped daemon is not started');
  await writeFile(socket, '');
  await changed();
  assert.deepEqual(calls, [['settingsChanged', { enabled, socket }, { sessionId: 'session' }]]);
});

test('a failed loaded-code version check is handled before a session starts and reports the original error', async t => {
  const dir = await temporary(t);
  const enabled = join(dir, 'enabled');
  await writeFile(enabled, '');
  const codexRemote = await loadExtension(t, `
    export const codeVersion = async () => { throw new Error('git failed'); };
    export const paths = () => ({ enabled: ${JSON.stringify(enabled)} });
    export const setEnabled = async () => {};
    export const start = async () => ({ version: 'daemon' });
    export const control = async () => {};`);
  await new Promise(resolve => setImmediate(resolve));
  const { handlers } = register(codexRemote);
  const notices = [];
  const ctx = { mode: 'tui', ui: { notify: (...args) => notices.push(args) }, sessionManager: { getSessionFile: () => undefined, getSessionId: () => 'session' } };
  for (const handler of handlers.get('session_start')) await handler({}, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, [['Codex Remote did not start: git failed', 'warning']]);
});

test('the pair screen closes when the code is used, when it expires, and on Esc or Enter', async t => {
  globalThis.codexRemotePairing = { claimed: false, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const codexRemote = await loadExtension(t, `
    export const codeVersion = async () => 'loaded';
    export const paths = () => ({ enabled: '/nonexistent' });
    export const setEnabled = async () => {};
    export const start = async () => ({ status: 'connected', log: 'log' });
    export const control = async action => action === 'pair'
      ? { url: 'https://chatgpt.com/codex/pair?pairing_code=P', pairingCode: 'P', manualCode: 'M', expiresAt: globalThis.codexRemotePairing.expiresAt }
      : { claimed: globalThis.codexRemotePairing.claimed };`);
  const { command } = register(codexRemote);
  const pair = async act => {
    const notices = [];
    let screen;
    const ui = {
      setWidget() {}, notify: (text, type) => notices.push([type, text]),
      custom: factory => new Promise(resolve => {
        screen = factory({}, {}, { matches: (data, id) => data === id }, resolve);
        act(screen);
      }).finally(() => screen.dispose()),
    };
    await command().handler('pair', { mode: 'tui', ui });
    return { lines: screen.render(200), notices };
  };
  const { lines } = await pair(screen => screen.handleInput('tui.select.cancel'));
  assert.ok(lines.includes(' Manual code: M'));
  assert.equal(lines.at(-1), ' (tui.select.cancel to close)');
  assert.deepEqual((await pair(screen => screen.handleInput('tui.select.confirm'))).notices, []);
  assert.deepEqual((await pair(() => { globalThis.codexRemotePairing.claimed = true; })).notices, [['info', 'Codex Remote paired']]);
  globalThis.codexRemotePairing = { claimed: false, expiresAt: new Date(Date.now() + 50).toISOString() };
  assert.deepEqual((await pair(() => {})).notices, [['warning', 'Pairing code expired. Run /codex-remote pair for a new one.']]);
});
