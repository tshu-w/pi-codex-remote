export const releaseCommand = 'codex-remote-release';

export function registerReleaseCommand(pi) {
  if (process.env.PI_CODEX_REMOTE_RPC !== '1') return;
  pi.registerCommand(releaseCommand, {
    description: 'Exit this Remote RPC process when it has no work',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'rpc') throw new Error('Remote release requires RPC mode.');
      // Extensions with background work, such as pi-agents, set `busy` synchronously.
      const query = { busy: false };
      pi.events.emit('busy:query', query);
      if (!ctx.isIdle() || ctx.hasPendingMessages() || query.busy) throw new Error('Pi still has work.');
      ctx.shutdown();
    },
  });
}
