import { marked } from 'marked';
import { decodeHTML } from 'entities';
import { invalid } from '../codex.mjs';
import { historyCursor, historyPage, pageLimit } from '../pages.mjs';

function markdownText(markdown) {
  const render = tokens => tokens.map(token => {
    if (token.type === 'space' || token.type === 'hr' || token.type === 'br') return ' ';
    if (token.type === 'list') return token.items.map(item => render(item.tokens)).join(' ') + ' ';
    const text = token.tokens ? render(token.tokens) : token.type === 'text' ? decodeHTML(token.text) : token.text ?? token.raw;
    return text + (['paragraph', 'heading', 'blockquote', 'code', 'list_item'].includes(token.type) ? ' ' : '');
  }).join('');
  return render(marked.lexer(markdown.trim(), { gfm: false })).replace(/\s+/gu, ' ').trim();
}

function matches(text, needle) {
  const lower = text.toLowerCase();
  if (!lower.includes(needle)) return [];
  const spans = [];
  let original = 0;
  for (const character of text) {
    const end = original + character.length;
    for (let index = 0; index < character.toLowerCase().length; index++) spans.push([original, end]);
    original = end;
  }
  const ranges = [];
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + needle.length)) {
    ranges.push([spans[index][0], spans[index + needle.length - 1][1]]);
  }
  return ranges;
}

function snippet(text, start, end) {
  // Keep Unicode scalar boundaries while reporting offsets in UTF-16 code units.
  const before = [...text.slice(Math.max(0, start - 49 * 2), start)].slice(-49).join('');
  const after = [...text.slice(end, end + 96 * 2)].slice(0, 96).join('');
  const prefix = before.length < start ? '... ' : '';
  const suffix = end + after.length < text.length ? ' ...' : '';
  const matchStart = prefix.length + before.length;
  return { snippet: prefix + before + text.slice(start, end) + after + suffix,
    snippetMatchRange: { start: matchStart, end: matchStart + end - start } };
}

export const historyHandlers = {
  async 'thread/searchOccurrences'(params) {
    if (typeof params.searchTerm !== 'string' || !params.searchTerm.trim()) throw invalid('searchTerm must be a non-empty string.');
    pageLimit(params.limit);
    await this.thread(params.threadId);
    const turns = await this.turns(params.threadId);
    const occurrences = [];
    const needle = params.searchTerm.toLowerCase();
    for (const turn of turns) {
      const final = turn.items.findLast(item => item.type === 'agentMessage');
      for (const item of turn.items) {
        const text = item.type === 'userMessage'
          ? item.content.filter(block => block.type === 'text').map(block => block.text).join('')
          : item === final ? markdownText(item.text) : '';
        for (const [index, [start, end]] of matches(text, needle).entries()) {
          occurrences.push({ id: JSON.stringify([turn.id, item.id, index]), value: {
            turnId: turn.id, itemId: item.id,
            turnCursor: historyCursor(turn.id, true, this.historyContext(params.threadId, 'turns')),
            ...snippet(text, start, end),
          } });
        }
      }
    }
    const context = this.historyContext(params.threadId, `searchOccurrences:${params.searchTerm}`);
    const page = historyPage(occurrences, params, occurrence => occurrence.id, context);
    return { data: page.data.map(occurrence => occurrence.value), nextCursor: page.nextCursor };
  },

  async 'thread/timeline/list'(params) {
    pageLimit(params.limit);
    await this.thread(params.threadId);
    const turns = await this.turns(params.threadId);
    const entries = [];
    const append = (id, value) => entries.push({ id, value: { ...value, position: entries.length } });
    for (const turn of turns) {
      append(JSON.stringify([turn.id, 'start']), { type: 'turnStarted', turn_id: turn.id, started_at: turn.startedAt ?? null });
      for (const item of turn.items) append(JSON.stringify([turn.id, 'item', item.id]), { type: 'item', turnId: turn.id, item });
      if (turn.status !== 'inProgress') append(JSON.stringify([turn.id, 'end']), {
        type: 'turnCompleted', turn_id: turn.id, status: turn.status, error: turn.error ?? null,
        started_at: turn.startedAt ?? null, completed_at: turn.completedAt ?? null, duration_ms: turn.durationMs ?? null,
      });
    }
    const page = historyPage(entries.reverse(), params, entry => entry.id, this.historyContext(params.threadId, 'timeline'));
    return { data: page.data.reverse().map(entry => entry.value), nextCursor: page.nextCursor, activeRealtimeSessionAtPageStart: null };
  },
};
