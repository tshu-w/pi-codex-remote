import { invalid } from './codex.mjs';

export function pageLimit(value, fallback = 50) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 500) throw invalid('limit must be an integer between 1 and 500.');
  return value;
}
export function offsetPage(values, params, fallback = 50) {
  if (params.cursor != null && !/^\d+$/.test(params.cursor)) throw invalid('Invalid pagination cursor.');
  const start = Number(params.cursor ?? 0);
  if (!Number.isSafeInteger(start)) throw invalid('Invalid pagination cursor.');
  const limit = pageLimit(params.limit, fallback);
  return { data: values.slice(start, start + limit), nextCursor: start + limit < values.length ? String(start + limit) : null };
}
export function historyCursor(id, inclusive, context) {
  return context ? 'pi:' + Buffer.from(JSON.stringify([context.threadId, context.scope, id, inclusive])).toString('base64url') : `${inclusive ? 'at' : 'after'}:${id}`;
}
export function historyPage(values, params, getId, context, filter = () => true) {
  if (params.sortDirection != null && !['asc', 'desc'].includes(params.sortDirection)) throw invalid('sortDirection must be asc or desc.');
  let start = 0;
  if (params.cursor != null) {
    let id;
    let inclusive;
    if (typeof params.cursor === 'string' && params.cursor.startsWith('pi:') && context) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(params.cursor.slice(3), 'base64url').toString()); }
      catch { throw invalid('Invalid history pagination cursor.'); }
      if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== context.threadId || decoded[1] !== context.scope || typeof decoded[2] !== 'string' || typeof decoded[3] !== 'boolean') throw invalid('History cursor does not belong to this thread and page type.');
      [, , id, inclusive] = decoded;
    } else {
      const match = typeof params.cursor === 'string' && /^(after|at):(.+)$/.exec(params.cursor);
      if (!match || context) throw invalid('Invalid history pagination cursor.');
      id = match[2];
      inclusive = match[1] === 'at';
    }
    const index = values.findIndex(value => getId(value) === id);
    if (index < 0) throw invalid('History pagination cursor is no longer valid.');
    start = index + (inclusive ? 0 : 1);
  }
  const remaining = values.slice(start).filter(filter);
  const data = remaining.slice(0, pageLimit(params.limit));
  return { data, nextCursor: data.length < remaining.length ? historyCursor(getId(data.at(-1)), false, context) : null, backwardsCursor: data.length ? historyCursor(getId(data[0]), true, context) : null };
}
export function turnView(turn, itemsView = 'summary') {
  if (!['notLoaded', 'summary', 'full'].includes(itemsView)) throw invalid('Invalid itemsView.');
  const firstUser = turn.items.find(item => item.type === 'userMessage');
  const lastMessage = turn.items.findLast(item => item.type === 'agentMessage');
  const summary = [...new Map([firstUser, lastMessage].filter(Boolean).map(item => [item.id, item])).values()];
  return { ...turn, itemsView, items: itemsView === 'full' ? turn.items : itemsView === 'summary' ? summary : [] };
}
