// End-to-end fixture: the installed Pi CLI in RPC mode with the production extension,
// an offline scripted provider, and a phone client speaking app-server JSON-RPC.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Protocol } from '../src/protocol.mjs';
import { Sessions } from '../src/sessions.mjs';
import * as trash from '../src/trash.mjs';

export const model = 'fixture/scripted';
const remoteExtension = fileURLToPath(new URL('../index.ts', import.meta.url));

// Replies depend on the latest user prompt:
//   "read <file>" / "write <file>" / "bash <command>" call that Pi tool, then answer "done:<tool>"
//   "hold" streams "held" and waits for `/fixture-release` before finishing with "held:released"
//   anything else answers "echo:" plus every user text in context, joined by "|"
// A `fixture-busy` file in the workspace makes Pi report background work.
const providerFixture = new URL('./fixtures/provider.ts', import.meta.url);
export async function waitFor(predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`Timed out: ${description}`);
}

export function phone(protocol) {
  const records = [];
  const emit = record => records.push(structuredClone(record));
  let nextId = 0;
  const raw = async (method, params = {}) => {
    const id = ++nextId;
    await protocol.handle({ id, method, params }, emit);
    return records.find(record => record.id === id);
  };
  return {
    records, raw,
    disconnect: () => protocol.disconnect(emit),
    async request(method, params) {
      const response = await raw(method, params);
      assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    notification: (method, predicate = () => true) => waitFor(() => records.find(record => record.method === method && predicate(record.params)), method),
    async turn(threadId, text, extra = {}) {
      const { turn } = await this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...extra });
      const completed = await this.notification('turn/completed', params => params.turn.id === turn.id);
      return completed.params.turn;
    },
  };
}

// One isolated Pi home per test file. `start()` creates a fresh Protocol, like a daemon restart.
export async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-remote-e2e-')));
  const dirs = { cwd: join(root, 'workspace'), config: join(root, 'config'), sessions: join(root, 'sessions'),
    home: join(root, 'home'), state: join(root, 'xdg-state'), trash: join(root, 'Trash') };
  await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
  const extension = join(root, 'provider.ts');
  const calls = join(root, 'calls.jsonl');
  await Promise.all([
    copyFile(providerFixture, extension), writeFile(calls, ''),
    writeFile(join(dirs.config, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'scripted', defaultThinkingLevel: 'off',
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false,
    })),
  ]);
  // History discovery and the live-session guard run in this process; node:test isolates files.
  Object.assign(process.env, { PI_CODING_AGENT_DIR: dirs.config, PI_CODING_AGENT_SESSION_DIR: dirs.sessions, XDG_STATE_HOME: dirs.state });
  const protocols = [];
  t.after(async () => {
    await Promise.allSettled(protocols.map(protocol => protocol.close()));
    await rm(root, { recursive: true, force: true });
  });
  // Archive moves files into a fixture directory instead of the user's Trash.
  const fixtureTrash = { ...trash, trashSession: async path => {
    const target = join(dirs.trash, `${Date.now()}-${basename(path)}`);
    await rename(path, target);
    return target;
  } };
  const start = ({ releaseDelayMs } = {}) => {
    const sessions = new Sessions({
      command: '/usr/bin/env',
      args: ['-i', `PATH=${process.env.PATH}`, `HOME=${dirs.home}`, `XDG_STATE_HOME=${dirs.state}`,
        `PI_CODING_AGENT_DIR=${dirs.config}`, `PI_CODING_AGENT_SESSION_DIR=${dirs.sessions}`, `FIXTURE_CALLS=${calls}`,
        'PI_OFFLINE=1', 'PI_SKIP_VERSION_CHECK=1', 'PI_TELEMETRY=0', 'PI_CODEX_REMOTE_RPC=1',
        'pi', '--tools', 'read,bash,edit,write,grep,find,ls,mcp__fixture__lookup,nested,agent', '--no-extensions', '-e', remoteExtension, '-e', extension, '--no-skills', '--no-prompt-templates',
        '--no-themes', '--no-context-files', '--session-dir', dirs.sessions],
      requestTimeoutMs: 30000, shutdownTimeoutMs: 1000,
    });
    const protocol = new Protocol({ sessions, cwd: dirs.cwd, stateDir: join(root, 'remote-state'), trash: fixtureTrash, releaseDelayMs });
    protocols.push(protocol);
    return { protocol, sessions, client: phone(protocol) };
  };
  return {
    root, ...dirs, start,
    calls: async () => (await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
  };
}
