import { expect, test } from 'bun:test';
import { createPagedConversationHistory, readNativeItemPage } from '../src/server/conversation/paged-history.js';
import { mergeConversationHistory } from '../src/client/ui-core.js';

test('native pages preserve older history and item order during live refreshes', async () => {
  let items = Array.from({ length: 6 }, (_, i) => ({ turnId: 'turn', item: { id: `i${i}`, type: 'agentMessage', text: `${i}` } }));
  const calls: string[] = [];
  const service = createPagedConversationHistory({ getThread: async id => ({ id }), request: async (method, params) => {
    calls.push(method);
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'inProgress', items: [] }] };
    if (method !== 'thread/items/list') throw new Error('Full history must not be read');
    const end = params.cursor ? items.findIndex(x => x.item.id === params.cursor) : items.length;
    const start = Math.max(0, end - params.limit);
    return { data: items.slice(start, end).reverse(), nextCursor: start ? items[start].item.id : null };
  } });
  const first = await service.read({ threadId: 'A', limit: 2 });
  let local = mergeConversationHistory(null, first);
  const older = await service.read({ threadId: 'A', cursor: first.history.nextCursor, limit: 2 });
  local = mergeConversationHistory(local, older, { page: true });
  expect(local.turns[0].items.map(x => x.id)).toEqual(['i2', 'i3', 'i4', 'i5']);
  const olderCursor = local.history.nextCursor;
  items.push({ turnId: 'turn', item: { id: 'i6', type: 'agentMessage', text: 'latest' } });
  local = mergeConversationHistory(local, await service.read({ threadId: 'A', revision: local.history.revision, oldestItemId: local.history.oldestItemId, limit: 2 }));
  expect(local.turns[0].items.map(x => x.id)).toEqual(['i2', 'i3', 'i4', 'i5', 'i6']);
  expect(local.history.nextCursor).toBe(olderCursor);
  local = mergeConversationHistory(local, await service.read({ threadId: 'A', cursor: local.history.nextCursor, limit: 2 }), { page: true });
  expect(local.turns[0].items.map(x => x.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6']);
  // Cached legacy/restarted readers use different item ranks. Start a fresh
  // visible window rather than interleaving their ranks with native pages.
  const migrated = await service.read({ threadId: 'A', revision: 'legacy-reader', limit: 2 });
  expect(migrated.history.resetLoadedHistory).toBe(true);
  expect(mergeConversationHistory(local, migrated).turns[0].items.map(x => x.id)).toEqual(['i5', 'i6']);
  service.clear();
  await expect(service.read({ threadId: 'A', cursor: olderCursor })).rejects.toThrow('cursor expired');
  await expect(service.read({ threadId: 'B', cursor: olderCursor })).rejects.toThrow('cursor expired');
  expect(calls.every(method => method !== 'thread/read')).toBe(true);
});

test('slow item pages return progress promptly and their cursor resumes without skipping', async () => {
  let elapsed = 0;
  const request = async (method, params) => {
    expect(method).toBe('thread/items/list');
    expect(params.limit).toBe(1);
    elapsed += 1200;
    const index = Number(params.cursor || 0);
    return { data: [{ turnId: 'turn', item: { id: `i${index}` } }], nextCursor: index < 4 ? String(index + 1) : null };
  };
  const first = await readNativeItemPage(request, { threadId: 'slow', limit: 20, now: () => elapsed });
  expect(first.data.map(record => record.item.id)).toEqual(['i0', 'i1']);
  expect(first.nextCursor).toBe('2');
  const second = await readNativeItemPage(request, { threadId: 'slow', cursor: first.nextCursor, limit: 20, now: () => elapsed });
  expect(second.data.map(record => record.item.id)).toEqual(['i2', 'i3']);
  const last = await readNativeItemPage(request, { threadId: 'slow', cursor: second.nextCursor, limit: 20, now: () => elapsed });
  expect(last.data.map(record => record.item.id)).toEqual(['i4']);
  expect(last.nextCursor).toBeNull();
});
