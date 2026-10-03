// Preloaded by `npm test`: any outgoing message that violates the Codex schema fails its test file.
const violations = [];
process.on('warning', warning => {
  if (warning.name === 'CodexSchemaWarning') violations.push(warning.message);
});
process.on('exit', () => {
  if (!violations.length) return;
  console.error(`Codex schema violations:\n${[...new Set(violations)].join('\n')}`);
  process.exitCode = 1;
});
