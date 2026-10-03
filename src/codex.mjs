import { resolve } from 'node:path';

export const seconds = value => Math.floor(new Date(value).getTime() / 1000);
export const modelKey = model => model ? `${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}` : null;
export const invalid = message => Object.assign(new Error(message), { code: -32602 });
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const supportedEfforts = model => model?.reasoning ? thinkingLevels.filter(level => model.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined)) : ['off'];
export async function applyEffort(rpc, effort) {
  if (effort == null) return;
  if (!supportedEfforts(rpc.state.model).includes(effort)) throw invalid('Requested reasoning effort is unavailable for the selected Pi model.');
  await rpc.request('set_thinking_level', { level: effort });
}
export function workspaceSettings(params, cwd) {
  if (params.cwd && resolve(params.cwd) !== cwd) throw invalid('Changing workspace on an existing Pi session is unsupported.');
  if (params.runtimeWorkspaceRoots != null && (params.runtimeWorkspaceRoots.length !== 1 || resolve(params.runtimeWorkspaceRoots[0]) !== cwd)) throw invalid('Pi supports only the session working directory as its runtime workspace root.');
}
export function executionSettings(params) {
  if (params.permissions != null) {
    if (params.permissions !== ':danger-full-access') throw invalid('Only the :danger-full-access permission profile is supported; Pi local permission hooks remain enforced.');
    if (params.sandbox != null || params.sandboxPolicy != null) throw invalid('permissions cannot be combined with sandbox or sandboxPolicy.');
  }
  if (params.sandbox != null && params.sandbox !== 'danger-full-access' && params.sandbox.type !== 'dangerFullAccess') throw invalid('Pi does not enforce Codex sandbox policies. Use Pi permissions or omit sandbox.');
  if (params.sandboxPolicy != null && params.sandboxPolicy.type !== 'dangerFullAccess') throw invalid('Pi does not enforce Codex sandbox policies. Use Pi permissions or omit sandboxPolicy.');
  if (params.approvalPolicy != null && params.approvalPolicy !== 'never') throw invalid('Pi does not enforce Codex approval policies. Use Pi extensions or omit approvalPolicy.');
  if (params.approvalsReviewer != null && params.approvalsReviewer !== 'user') throw invalid('Delegated Codex approval reviewers are not supported.');
  if (params.dynamicTools != null && (!Array.isArray(params.dynamicTools) || params.dynamicTools.length)) throw invalid('Nonempty or malformed dynamicTools are unsupported; Pi uses its native tools.');
  for (const key of ['baseInstructions', 'developerInstructions', 'serviceTier', 'personality', 'outputSchema', 'additionalContext', 'collaborationMode', 'environments', 'selectedCapabilityRoots', 'projectId', 'mockExperimentalField']) if (params[key] != null) throw invalid(`${key} overrides are not supported by Pi Remote.`);
  if (params.summary != null && !['auto', 'concise', 'detailed'].includes(params.summary)) throw invalid('Unsupported summary control. Pi accepts auto, concise and detailed as display hints while retaining native reasoning output; disabling summaries is unsupported.');
  for (const [key, value] of Object.entries(params.config ?? {})) {
    if (['features.concurrent_reasoning_summaries', 'features.realtime_conversation'].includes(key) && typeof value === 'boolean') continue;
    if (key === 'realtime.version' && (value == null || typeof value === 'string' || typeof value === 'number')) continue;
    if (key === 'experimental_realtime_ws_model' && (value == null || typeof value === 'string')) continue;
    if (key === 'model_reasoning_effort' && (value == null || typeof value === 'string')) continue;
    throw invalid(`Unsupported config override: ${key}`);
  }
  if (params.historyMode != null && !['legacy', 'paginated'].includes(params.historyMode)) throw invalid('historyMode must be legacy or paginated.');
  if (params.experimentalRawEvents || params.allowProviderModelFallback) throw invalid('Raw Responses events and provider fallback are unsupported.');
  const effort = params.reasoningEffort ?? params.effort ?? params.config?.model_reasoning_effort;
  if (effort != null && effort !== 'none' && !thinkingLevels.includes(effort)) throw invalid(`Unsupported reasoning effort: ${effort}`);
  return effort === 'none' ? 'off' : effort;
}
export function providerSettings(params, rpc) {
  const provider = params.model ? modelIdentity(params.model).provider : rpc.state.model?.provider;
  if (params.modelProvider && params.modelProvider !== 'custom' && params.modelProvider !== provider) throw invalid('modelProvider must match the selected Pi model, or be custom.');
}
export function modelIdentity(key) {
  if (!key) return undefined;
  const slash = key.indexOf('/');
  if (slash < 1) throw invalid('Choose a provider-qualified Pi model from model/list.');
  return { provider: decodeURIComponent(key.slice(0, slash)), modelId: decodeURIComponent(key.slice(slash + 1)) };
}
export function inputPrompt(input = [], attachments, owner) {
  if (!Array.isArray(input)) throw invalid('input must be an array.');
  const text = [];
  const images = [];
  for (const original of input) {
    const part = original?.type === 'localImage' ? { ...attachments.image(original.path, owner), detail: original.detail } : original;
    if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
    else if (part?.type === 'image') {
      if (part.detail != null && part.detail !== 'auto') throw invalid('Pi does not enforce Codex image detail modes; omit detail or use auto.');
      const match = typeof part.url === 'string' && /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url);
      if (!match) throw invalid('Remote images must use PNG, JPEG, GIF, or WebP base64 data URLs.');
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '') || bytes.length > 20 * 1024 * 1024 || images.length >= 10) throw invalid('Invalid or oversized image input (maximum 10 images, 20 MiB each).');
      images.push({ type: 'image', mimeType: match[1], data: match[2] });
    } else throw invalid(`Unsupported input type: ${part?.type ?? 'invalid'}`);
  }
  if (!text.length && !images.length) throw invalid('Input cannot be empty.');
  return { message: text.join('\n\n'), ...(images.length ? { images } : {}) };
}
export const agentItem = (id, text = '') => ({ type: 'agentMessage', id, text, phase: null, delivery: null, memoryCitation: null });
