// Regenerates vendor/ from the installed Codex CLI: `node scripts/update-protocol.mjs`.
// Schemas come from `codex app-server generate-json-schema`; the method → response
// mapping comes from the matching tag's common.rs, which the schemas do not carry.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vendor = new URL('../vendor/', import.meta.url);
const version = /codex-cli (\S+)/.exec(execFileSync('codex', ['--version'], { encoding: 'utf8' }))?.[1];
if (!version) throw new Error('Cannot read the installed Codex CLI version');

function generate(experimental) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-schema-'));
  try {
    execFileSync('codex', ['app-server', 'generate-json-schema', ...(experimental ? ['--experimental'] : []), '--out', dir], { stdio: 'ignore' });
    return JSON.parse(readFileSync(join(dir, 'codex_app_server_protocol.schemas.json'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const schema = generate(true);
const stable = new Set(generate(false).definitions.ClientRequest.oneOf.map(entry => entry.properties.method.enum[0]));
const source = await fetch(`https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/app-server-protocol/src/protocol/common.rs`);
if (!source.ok) throw new Error(`Cannot fetch common.rs for rust-v${version}: ${source.status}`);
const rust = await source.text();
const start = rust.indexOf('client_request_definitions! {');
const block = rust.slice(start, rust.indexOf('\n}\n', start));
const responses = new Map([...block.matchAll(/=>\s*"([^"]+)"\s*\{[^}]*?response:\s*([\w:]+)/g)].map(([, method, type]) => [method, type]));

const pointer = type => {
  const [namespace, name] = type.includes('::') ? type.split('::') : [null, type];
  const ref = namespace === 'v2' ? `#/definitions/v2/${name}` : `#/definitions/${name}`;
  const target = namespace === 'v2' ? schema.definitions.v2[name] : schema.definitions[name];
  if (!target) throw new Error(`Unresolved schema type ${type}`);
  return ref;
};
const requests = {};
for (const entry of schema.definitions.ClientRequest.oneOf) {
  const method = entry.properties.method.enum[0];
  const response = responses.get(method);
  if (!response) throw new Error(`common.rs has no response type for ${method}`);
  requests[method] = { response: pointer(response), experimental: !stable.has(method) };
}
const notifications = Object.fromEntries(schema.definitions.ServerNotification.oneOf.map(entry => [entry.properties.method.enum[0], entry.properties.params?.$ref ?? null]));

writeFileSync(new URL('codex-app-server.schema.json', vendor), `${JSON.stringify(schema)}\n`);
writeFileSync(new URL('codex-app-server.methods.json', vendor), `${JSON.stringify({ version, requests, notifications }, null, 2)}\n`);
console.log(`Codex ${version}: ${Object.keys(requests).length} requests (${stable.size} stable), ${Object.keys(notifications).length} notifications`);
