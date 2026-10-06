import { platform } from 'node:os';
import { resolve } from 'node:path';
import { protocolMethods } from '../schema.mjs';
import { modelKey, invalid, supportedEfforts } from '../codex.mjs';
import { offsetPage } from '../pages.mjs';

export const configHandlers = {
  async 'initialize'(params, emit) {
    const optOut = params.capabilities?.optOutNotificationMethods ?? [];
    if (!Array.isArray(optOut) || !optOut.every(method => typeof method === 'string')) throw invalid('optOutNotificationMethods must be a string array.');
    this.notificationFilters.set(emit, new Set(optOut));
    if (!this.catalogReady) await this.discover();
    return { userAgent: `pi-codex-remote/${protocolMethods.version}`, codexHome: this.stateDir, platformFamily: 'unix', platformOs: platform() === 'darwin' ? 'macos' : platform() };
  },
  async 'account/read'() { return { account: null, requiresOpenaiAuth: false }; },
  async 'modelProvider/capabilities/read'() { return { imageGeneration: false, namespaceTools: false, webSearch: false }; },
  async 'config/read'(params) {
    const rpc = await this.probeRpc(params.cwd ?? this.cwd);
    await rpc.refresh();
    return {
      config: {
        model: modelKey(rpc.state.model), model_provider: 'custom',
        model_reasoning_effort: rpc.state.thinkingLevel ?? null,
        personality: null,
        features: { personality: false },
        approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access',
        default_permissions: ':danger-full-access',
      },
      origins: {}, layers: params.includeLayers ? [] : null,
    };
  },
  async 'configRequirements/read'() {
    return { requirements: {
      allowedApprovalPolicies: ['never'], allowedApprovalsReviewers: ['user'],
      allowedSandboxModes: ['danger-full-access'],
      allowedPermissionProfiles: { ':danger-full-access': true }, defaultPermissions: ':danger-full-access',
    } };
  },
  async 'permissionProfile/list'(params) {
    return offsetPage([
      { id: ':danger-full-access', description: 'Native Pi execution without a Codex sandbox; Pi local permission hooks remain enforced.', allowed: true },
    ], params, 1);
  },
  async 'collaborationMode/list'() { return { data: [] }; },
  async 'plugin/installed'() { return { marketplaces: [], marketplaceLoadErrors: [] }; },
  async 'plugin/list'() { return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }; },
  async 'hooks/list'() { return { data: [] }; },
  async 'app/list'() { return { data: [], nextCursor: null }; },
  async 'mcpServerStatus/list'() { return { data: [], nextCursor: null }; },
  async 'experimentalFeature/list'() { return { data: [], nextCursor: null }; },
  async 'skills/list'(params) {
    if (params.cwds != null && (!Array.isArray(params.cwds) || !params.cwds.every(cwd => typeof cwd === 'string'))) throw invalid('cwds must be a string array.');
    const data = await Promise.all((params.cwds?.length ? params.cwds : [this.cwd]).map(async value => {
      const cwd = resolve(value);
      const rpc = params.forceReload ? await this.sessions.open({ cwd, ephemeral: true }) : await this.probeRpc(cwd);
      try {
        const { commands } = await rpc.request('get_commands');
        const skills = commands.filter(command => command.source === 'skill').map(command => ({ name: command.name.replace(/^skill:/, ''), description: command.description, path: command.sourceInfo.path, scope: command.sourceInfo.scope === 'project' ? 'repo' : 'user', enabled: true }));
        return { cwd, skills, errors: [] };
      } finally { if (params.forceReload) await rpc.close(); }
    }));
    return { data };
  },
  async 'model/list'(params) {
    const rpc = await this.probeRpc();
    const { models } = await rpc.request('get_available_models');
    const current = modelKey(rpc.state.model);
    const page = offsetPage(models, params, 100);
    return {
      data: page.data.map(model => {
        const key = modelKey(model);
        const efforts = supportedEfforts(model);
        const isDefault = key === current;
        return {
          id: key, model: key, displayName: model.name ?? model.id, description: model.provider,
          hidden: false, isDefault, inputModalities: model.input ?? ['text'],
          supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
          defaultReasoningEffort: isDefault ? rpc.state.thinkingLevel ?? 'off' : efforts.includes('medium') ? 'medium' : efforts[0],
          additionalSpeedTiers: [], availabilityNux: null, defaultServiceTier: null, modelSpecialty: null,
          multiAgentVersion: null, serviceTiers: [], supportsPersonality: false, upgrade: null, upgradeInfo: null,
        };
      }),
      nextCursor: page.nextCursor,
    };
  },
};
