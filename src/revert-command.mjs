export const revertCommand = 'codex-remote-revert';
export const revertEntryType = 'codex-remote.revert';

export function registerRevertCommand(pi) {
  if (process.env.PI_CODEX_REMOTE_RPC !== '1') return;
  pi.registerCommand(revertCommand, {
    description: 'Apply a validated Remote history branch change',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'rpc') throw new Error('Remote history commands require RPC mode.');
      const request = JSON.parse(args);
      const { operationId, threadId, expectedLeafId, targetId } = request;
      if (![operationId, threadId, expectedLeafId, targetId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Invalid Remote history command.');
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Wait for Pi to become idle before editing history.');
      const manager = ctx.sessionManager;
      if (manager.getSessionId() !== threadId || manager.getLeafId() !== expectedLeafId) throw new Error('Pi history changed before revert. Refresh the thread before retrying.');
      const target = manager.getBranch().find(entry => entry.id === targetId);
      if (target?.type !== 'message' || target.message.role !== 'user') throw new Error('Revert must target a user message on the active branch.');
      const data = { operationId, fromLeafId: expectedLeafId, targetId };
      // A non-user anchor preserves the original branch and avoids navigateTree's current-leaf no-op.
      pi.appendEntry(revertEntryType, { ...data, phase: 'anchor' });
      const result = await ctx.navigateTree(targetId, { summarize: false });
      if (result.cancelled) throw new Error('Pi cancelled the history revert.');
      if (manager.getLeafId() !== target.parentId) throw new Error('Pi did not navigate to the requested history boundary.');
      pi.appendEntry(revertEntryType, { ...data, phase: 'committed' });
    },
  });
}
