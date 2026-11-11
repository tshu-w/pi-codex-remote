import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprint, setEnabled, updateCheck } from '../src/daemon.mjs';

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

test('the fingerprint changes when code is updated', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'src', 'handlers'), { recursive: true });
  for (const file of ['package.json', 'index.ts', 'src/a.mjs', 'src/handlers/b.mjs']) await writeFile(join(dir, file), 'x');
  const before = await fingerprint(dir);
  assert.equal(await fingerprint(dir), before);
  await utimes(join(dir, 'src/handlers/b.mjs'), new Date(), new Date(Date.now() + 5000));
  assert.notEqual(await fingerprint(dir), before);
});

test('an update hands over once idle, and code that does not load is not retried', async () => {
  let code = 'old';
  let idle = false;
  let loadable = false;
  const loaded = [];
  let handovers = 0;
  const check = updateCheck({ initial: 'old', current: async () => code, idle: () => idle, loads: async () => { loaded.push(code); return loadable; }, handover: () => handovers++ });
  await check();
  code = 'broken';
  await check();
  assert.deepEqual([loaded, handovers], [[], 0], 'a busy daemon waits');
  idle = true;
  await check();
  await check();
  assert.deepEqual([loaded, handovers], [['broken'], 0], 'code that does not load is tried once');
  code = 'fixed';
  loadable = true;
  await check();
  await check();
  assert.deepEqual([loaded, handovers], [['broken', 'fixed'], 1]);
});

test('Pi sessions start an enabled daemon, and stop keeps it stopped', async t => {
  const dir = await temporary(t);
  const enabled = join(dir, 'enabled');
  const calls = globalThis.codexRemoteDaemonCalls = [];
  const source = `import { rmSync, writeFileSync } from 'node:fs';
    const calls = globalThis.codexRemoteDaemonCalls;
    export const paths = () => ({ enabled: ${JSON.stringify(enabled)} });
    export const setEnabled = async on => on ? writeFileSync(${JSON.stringify(enabled)}, '') : rmSync(${JSON.stringify(enabled)}, { force: true });
    export const start = async () => { calls.push('start'); return { status: 'connected', log: 'log' }; };
    export const control = async action => { calls.push(action); return action === 'pair' ? { url: 'https://chatgpt.com/codex/pair', manualCode: 'CODE', expiresAt: new Date().toISOString() } : { status: 'connected', log: 'log' }; };`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './src/daemon.mjs') return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      if (specifier === '@earendil-works/pi-coding-agent') return { url: 'data:text/javascript,export const resizeImage = () => {};', shortCircuit: true };
      if (specifier === '@earendil-works/pi-tui') return { url: 'data:text/javascript,export class Loader { setMessage() {} stop() {} } export class Text {}', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  let codexRemote;
  try { ({ default: codexRemote } = await import(`../index.ts?auto-start`)); }
  finally { hooks.deregister(); }
  const handlers = new Map();
  let command;
  codexRemote({ on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]), registerCommand: (_name, options) => { command = options; } });
  const ui = { notify() {}, setWidget() {}, setStatus() {} };
  const sessionManager = { getSessionFile: () => undefined, getSessionId: () => 'session' };
  const sessionStart = async (mode = 'rpc') => {
    calls.length = 0;
    for (const handler of handlers.get('session_start')) await handler({}, { mode, ui, sessionManager });
    await new Promise(resolve => setImmediate(resolve));
    return [...calls];
  };
  assert.deepEqual(await sessionStart(), [], 'nothing starts before pairing or start');
  await command.handler('start', { mode: 'tui', ui });
  assert.deepEqual(await sessionStart(), ['start']);
  await command.handler('stop', { mode: 'tui', ui });
  assert.deepEqual(await sessionStart(), [], 'stop sticks');
  await command.handler('pair', { mode: 'tui', ui });
  assert.deepEqual(await sessionStart('tui'), ['start']);
});
