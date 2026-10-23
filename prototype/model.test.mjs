import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, validateState, localDayKey, moveLocalDay, cardEntries, confirmationEntry, addEntry, undoEntry, startRound, reminderInfo, calendarModel } from './model.js';
process.env.TZ = 'Asia/Shanghai';
const now = () => new Date('2026-10-22T10:00:00+08:00');
const initial = () => createInitialState(now());

test('v2 migration preserves every real timestamp and id, without sample history', () => {
  const legacy = { privateContent: { demo: 'life-save-records-v2', entries: [{ id: 'real', at: '2026-10-21T15:59:59Z' }], sound: true, strength: 'soft' } };
  const s = createInitialState(now(), legacy);
  assert.deepEqual(s.entries, [{ id: 'real', at: '2026-10-21T15:59:59Z', cardId: 'medication', roundId: null }]);
  assert.deepEqual(s.settings, { sound: true, strength: 'soft' });
  assert.equal(s.cards.find(c => c.id === 'medication').reminder.type, 'none');
  assert.equal(createInitialState(now(), { privateContent: { demo: 'life-save-tactile-v1', recorded: true } }).entries.length, 0);
});
test('unknown or malformed persisted data is rejected instead of cleared', () => {
  assert.throws(() => createInitialState(now(), { privateContent: { demo: 'future' } }));
  assert.throws(() => createInitialState(now(), { privateContent: { demo: 'life-save-records-v2', entries: [{ id: 'bad', at: 'invalid' }] } }));
  const s = initial(); s.cards[0].reminder = { type: 'interval', minutes: 0 }; assert.throws(() => validateState(s));
  const s2 = initial(); s2.entries.push({ id: 'bad', at: now().toISOString(), cardId: 'missing', roundId: null }); assert.throws(() => validateState(s2));
});
test('repeated records append and per-card undo preserves other cards', () => {
  let s = addEntry(initial(), 'medication', now(), 'first');
  s = addEntry(s, 'sheets', now(), 'sheets');
  s = addEntry(s, 'medication', new Date(now().getTime() + 60000), 'second');
  assert.equal(cardEntries(s, 'medication').length, 2);
  s = undoEntry(s, 'medication');
  assert.deepEqual(s.entries.map(e => e.id), ['sheets', 'first']);
});
test('manual confirmation is idempotent per outing and new rounds retain history', () => {
  let s = addEntry(initial(), 'door', now(), 'door-1');
  const card = s.cards.find(c => c.id === 'door');
  assert.equal(confirmationEntry(s, card, now()).id, 'door-1');
  assert.throws(() => addEntry(s, 'door', now(), 'duplicate'));
  s = startRound(s, 'outing', now(), 'round-2');
  assert.equal(confirmationEntry(s, card, now()), null);
  assert.equal(s.entries.length, 1);
  s = addEntry(s, 'door', now(), 'door-2');
  s = undoEntry(s, 'door');
  assert.equal(s.entries.length, 1);
  assert.equal(confirmationEntry(s, card, now()), null);
});
test('daily confirmations reset at local midnight, not 24 hours after completion', () => {
  const before = new Date('2026-10-22T23:59:00+08:00'), after = new Date('2026-10-23T00:00:00+08:00');
  const s = addEntry(initial(), 'cat-dinner', before, 'dinner');
  const card = s.cards.find(c => c.id === 'cat-dinner');
  assert(confirmationEntry(s, card, before));
  assert.equal(confirmationEntry(s, card, after), null);
  assert.equal(s.entries.length, 1);
});
test('intervals have no invented starting point; progress clamps and due stays visible', () => {
  const card = { reminder: { type: 'interval', minutes: 120 } };
  assert.equal(reminderInfo(card, [], now()).status, 'unstarted');
  const entries = [{ at: now().toISOString() }];
  let info = reminderInfo(card, entries, new Date(now().getTime() + 3600000));
  assert.equal(info.progress, .5); assert.equal(info.remainingMs, 3600000);
  info = reminderInfo(card, entries, new Date(now().getTime() + 10800000));
  assert.equal(info.status, 'due'); assert.equal(info.progress, 1); assert.equal(info.remainingMs, -3600000);
  assert.equal(reminderInfo(card, entries, new Date(now().getTime() - 1000)).progress, 0);
});
test('fixed time remains fixed after a late completion and undo restores due status', () => {
  const card = { reminder: { type: 'daily', time: '08:00' } }, late = new Date('2026-10-22T10:00:00+08:00');
  assert.equal(reminderInfo(card, [], late).status, 'due');
  const info = reminderInfo(card, [{ at: late.toISOString() }], late);
  assert.equal(info.dueAt, new Date('2026-10-23T08:00:00+08:00').toISOString());
  assert.equal(info.status, 'upcoming');
  assert.equal(reminderInfo(card, [], late).status, 'due');
});
test('calendar buckets by local midnight, binary active days and contiguous pages', () => {
  const entries = [{ at: '2026-10-21T15:59:59Z' }, { at: '2026-10-21T16:00:00Z' }, { at: '2026-10-21T16:00:01Z' }];
  const m = calendarModel(entries, now(), 0), p = calendarModel([], now(), 1);
  assert.equal(m.buckets.get('2026-10-21').length, 1); assert.equal(m.buckets.get('2026-10-22').length, 2);
  assert.equal(m.activeDays, 2); assert.equal(m.days.length, 84);
  assert.equal(m.days.filter(d => d.future).length, 2);
  assert.equal(localDayKey(moveLocalDay(p.end, 1)), localDayKey(m.start));
});
test('calendar leap/year boundaries and fixed-time schedule handle daylight saving', () => {
  for (const zone of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin']) {
    process.env.TZ = zone;
    for (const date of [new Date(2024, 2, 12, 12), new Date(2024, 10, 5, 12), new Date(2025, 0, 1, 12)]) {
      const m = calendarModel([], date);
      assert.equal(new Set(m.days.map(d => d.key)).size, 84);
      assert.equal(m.start.getDay(), 0); assert.equal(m.end.getDay(), 6);
      for (let i = 1; i < m.days.length; i++) assert.equal(localDayKey(moveLocalDay(m.days[i - 1].date, 1)), m.days[i].key);
    }
  }
  process.env.TZ = 'America/New_York';
  const before = new Date(2024, 2, 9, 9), info = reminderInfo({ reminder: { type: 'daily', time: '08:00' } }, [{ at: before.toISOString() }], before);
  assert.equal(new Date(info.dueAt).getHours(), 8);
  assert.equal(new Date(info.dueAt).getDate(), 10);
  process.env.TZ = 'Asia/Shanghai';
  assert(calendarModel([], new Date(2024, 2, 1, 12)).days.some(d => d.key === '2024-02-29'));
});

test('notes attach to exactly one event, preserve time, counts, reminders and rounds', async () => {
  const { saveEntryNote, timelineItems } = await import('./model.js');
  let s = addEntry(initial(), 'cat-breakfast', now(), 'breakfast');
  s = addEntry(s, 'medication', now(), 'med');
  const before = structuredClone(s.entries), later = new Date(now().getTime() + 3600000);
  s = saveEntryNote(s, 'breakfast', '  拌在罐头里\n终于愿意吃了  ', later);
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[1].note, '拌在罐头里\n终于愿意吃了');
  for (let i = 0; i < before.length; i++) {
    assert.equal(s.entries[i].at, before[i].at);
    assert.equal(s.entries[i].roundId, before[i].roundId);
  }
  assert.equal(s.entries[0].note, undefined);
  assert.equal(calendarModel(s.entries, now()).days.find(d => d.key === '2026-10-22').count, 2);
  assert.equal(timelineItems(s, 'notes').length, 1);
  assert.equal(timelineItems(s)[0].id, 'med');
  assert.throws(() => saveEntryNote(s, 'missing', 'hello', later));
  s = saveEntryNote(s, 'breakfast', '', later);
  assert.equal(s.entries[1].note, undefined);
  s = undoEntry(s, 'cat-breakfast');
  assert.equal(s.entries.length, 1);
  assert.equal(timelineItems(s, 'notes').length, 0);
});
test('standalone journal edits retain original date and never add completion counts', async () => {
  const { saveJournal, timelineItems } = await import('./model.js');
  let s = saveJournal(initial(), 'post', '今天的小发现 <script>', now());
  s = saveJournal(s, 'post', '修改后的文字', new Date(now().getTime() + 60000), true);
  assert.equal(s.journal.length, 1); assert.equal(s.entries.length, 0);
  assert.equal(s.journal[0].at, now().toISOString());
  assert.equal(timelineItems(s, 'journal')[0].text, '修改后的文字');
  assert.equal(timelineItems(s, 'notes').length, 0);
  assert.equal(calendarModel(s.entries, now()).activeDays, 0);
  assert.throws(() => saveJournal(s, 'new', '   ', now()));
  assert.throws(() => saveJournal(s, 'new', 'a'.repeat(1001), now()));
  assert.throws(() => saveJournal(s, 'post', 'duplicate', now()));
  assert.throws(() => saveJournal(s, 'missing', 'edit', now(), true));
  validateState(s);
});
test('memory candidates only include real older text and avoid repeats before wrapping', async () => {
  const { drawMemory, memoryCandidates, saveEntryNote, saveJournal } = await import('./model.js');
  const today = new Date('2026-10-23T10:00:00+08:00');
  let s = saveJournal(initial(), 'old-post', '以前写下的一句话', new Date('2026-10-20T10:00:00+08:00'));
  s = saveJournal(s, 'today-post', '今天还不算以前', today);
  s = addEntry(s, 'medication', new Date('2026-10-19T10:00:00+08:00'), 'old-entry');
  s = saveEntryNote(s, 'old-entry', '给旧记录补充的细节', new Date('2026-10-19T10:05:00+08:00'));
  s = addEntry(s, 'sheets', new Date('2026-10-18T10:00:00+08:00'), 'no-note');
  const candidates = memoryCandidates(s, today);
  assert.deepEqual(candidates.map(candidate => candidate.id), ['journal:old-post', 'entry:old-entry']);
  assert.equal(candidates.every(candidate => candidate.text.length > 0), true);
  const first = drawMemory(candidates, new Set(), () => 0);
  const second = drawMemory(candidates, first.seenIds, () => 0);
  assert.notEqual(first.item.id, second.item.id);
  assert.equal(second.wrapped, false);
  const wrapped = drawMemory(candidates, second.seenIds, () => 0);
  assert.equal(wrapped.wrapped, true);
  assert.equal(wrapped.item.id, 'journal:old-post');
});
test('heatmap uses fixed monotonic buckets; category slots remain stable with repeats and overflow', async () => {
  const { heatLevel, dayMarkers } = await import('./model.js');
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 50].map(heatLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
  const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id }));
  const marks = dayMarkers(cards, [{ cardId: 'b' }, { cardId: 'b' }, { cardId: 'd' }, { cardId: 'f' }]);
  assert.deepEqual(marks.slots, [{ cardId: 'a', count: 0 }, { cardId: 'b', count: 2 }, { cardId: 'c', count: 0 }]);
  assert.equal(marks.overflow, 2);
  assert.equal(dayMarkers(cards.slice(0, 4), [{ cardId: 'd' }]).slots[3].count, 1);
});
