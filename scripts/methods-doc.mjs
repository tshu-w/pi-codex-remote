// Prints METHODS.md: `node scripts/methods-doc.mjs > METHODS.md`.
import { methodStatus } from '../src/methods.mjs';
import { protocolMethods } from '../src/schema.mjs';

const features = [
  ['Sessions and history', [
    ['thread/start', 'thread/unsubscribe'],
    ['thread/resume'],
    ['thread/fork'],
    ['thread/archive', 'thread/unarchive', 'thread/delete'],
    ['thread/name/set'],
    ['thread/list', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'thread/items/list'],
    ['thread/search'],
    ['thread/searchOccurrences'],
    ['thread/timeline/list'],
    ['thread/metadata/update', 'fuzzyFileSearch', 'fuzzyFileSearch/*'],
  ]],
  ['Conversation, queues and organization', [
    ['turn/start', 'turn/steer', 'turn/interrupt'],
    ['thread/settings/update'],
    ['thread/compact/start', 'thread/revert'],
    ['thread/queue/*'],
    ['thread/goal/get', 'threadSection/list', 'collaborationMode/list'],
    ['thread/goal/*', 'threadSection/*', 'thread/section/move', 'project/*'],
    ['thread/realtime/*'],
    ['turn/settings/update', 'review/start', 'thread/inject_items'],
    ['thread/increment_elicitation', 'thread/decrement_elicitation', 'thread/approveGuardianDeniedAction'],
  ]],
  ['Commands and files', [
    ['thread/shellCommand'],
    ['command/exec', 'command/exec/write', 'command/exec/terminate'],
    ['thread/backgroundTerminals/list'],
    ['thread/backgroundTerminals/*', 'command/exec/resize', 'process/*'],
    ['fs/watch', 'fs/unwatch'],
    ['fs/*'],
    ['thread/attachment/*'],
  ]],
  ['Models, configuration and extensions', [
    ['model/list'],
    ['modelProvider/capabilities/read'],
    ['permissionProfile/list', 'configRequirements/read'],
    ['config/read'],
    ['skills/list'],
    ['experimentalFeature/list', 'hooks/list', 'plugin/list', 'plugin/installed', 'app/list', 'mcpServerStatus/list'],
    ['config/*', 'experimentalFeature/*', 'windowsSandbox/*'],
    ['skills/*', 'plugin/*', 'app/*', 'marketplace/*', 'mcpServer/*'],
  ]],
  ['Connection, accounts and other requests', [
    ['initialize'],
    ['account/read'],
    ['remoteControl/*', 'account/*', 'userVerification/*'],
    ['thread/memoryMode/set', 'memory/*', 'rollout/*'],
    ['environment/*', 'externalAgentConfig/*'],
    ['server/diagnostics', 'feedback/upload', 'mock/*'],
  ]],
];

export function methodsDoc() {
  const { version, requests } = protocolMethods;
  const all = [...new Set([...Object.keys(requests), ...Object.keys(methodStatus)])];
  const status = method => methodStatus[method]?.[0] ?? 'unimplemented';
  const states = ['implemented', 'empty', 'unimplemented'];
  const counts = states.map(state => `${all.filter(method => status(method) === state).length} ${state}`).join(', ');
  const lines = [
    '# Codex app-server methods',
    '',
    `Generated from the Codex ${version} schema and \`src/methods.mjs\`. ${counts}. Full definitions and experimental markers are in [vendor/](vendor/).`,
    'Empty methods return no resources; unimplemented requests return -32601. Wildcards cover methods not already listed above them.',
  ];
  const remaining = new Set(all);
  for (const [title, rows] of features) {
    lines.push('', `## ${title}`, '', '| Methods | Status | Limits and behavior |', '| --- | --- | --- |');
    for (const patterns of rows) {
      const groups = patterns.map(pattern => ({
        pattern,
        methods: [...remaining].filter(method => pattern.endsWith('/*') ? method.startsWith(pattern.slice(0, -1)) : method === pattern),
      }));
      const methods = groups.flatMap(group => group.methods);
      if (!methods.length) throw new Error(`No methods match: ${patterns.join(', ')}`);
      for (const state of states) {
        const selected = methods.filter(method => status(method) === state);
        if (!selected.length) continue;
        const labels = groups.flatMap(({ pattern, methods }) => {
          const matching = methods.filter(method => status(method) === state);
          return matching.length === methods.length && matching.length ? [pattern] : matching;
        });
        const notes = [...new Set(selected.map(method => methodStatus[method]?.[1]).filter(Boolean))].join('; ');
        lines.push(`| ${labels.map(label => `\`${label}\``).join(', ')} | ${state} | ${notes.replaceAll('|', '\\|')} |`);
      }
      for (const method of methods) remaining.delete(method);
    }
  }
  if (remaining.size) throw new Error(`Assign a feature group to: ${[...remaining].join(', ')}`);
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(methodsDoc());
