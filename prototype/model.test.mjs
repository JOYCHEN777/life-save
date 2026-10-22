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
