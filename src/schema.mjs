import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const read = name => JSON.parse(readFileSync(new URL(`../vendor/${name}`, import.meta.url), 'utf8'));
export const protocolMethods = read('codex-app-server.methods.json');

const ranges = {
  int32: [-(2 ** 31), 2 ** 31 - 1], uint16: [0, 2 ** 16 - 1], uint32: [0, 2 ** 32 - 1],
  int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], uint64: [0, Number.MAX_SAFE_INTEGER], uint: [0, Number.MAX_SAFE_INTEGER],
};
let ajv;
const validators = new Map();
function validator(ref) {
  if (!ajv) {
    ajv = new Ajv({ strict: false, allErrors: true });
    for (const [name, [min, max]] of Object.entries(ranges)) ajv.addFormat(name, { type: 'number', validate: value => Number.isInteger(value) && value >= min && value <= max });
    ajv.addFormat('double', { type: 'number', validate: () => true });
    ajv.addSchema(read('codex-app-server.schema.json'), 'codex');
  }
  let validate = validators.get(ref);
  if (!validate) validators.set(ref, validate = ajv.compile({ $ref: `codex${ref}` }));
  return validate;
}

// Returns a description of how an outgoing message violates the official schema, or null.
export function schemaViolation(message, requestMethod) {
  let ref;
  if (message.method) {
    if (!Object.hasOwn(protocolMethods.notifications, message.method)) return `${message.method} is not a Codex ${protocolMethods.version} notification`;
    ref = protocolMethods.notifications[message.method];
  } else if (message.error === undefined) ref = protocolMethods.requests[requestMethod]?.response;
  if (!ref) return null;
  const validate = validator(ref);
  if (validate(message.method ? message.params : message.result)) return null;
  return `${message.method ?? `${requestMethod} response`}: ${ajv.errorsText(validate.errors, { dataVar: message.method ? 'params' : 'result' })}`;
}
