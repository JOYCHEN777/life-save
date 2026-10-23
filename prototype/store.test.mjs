import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.js';
import { addEntry } from './model.js';
function storage() { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; }
const suffix = JSON.stringify(['/prototype/', '']);
const legacyKey = `codex:visualization-widget-state-v2:${suffix}`;
const newKey = `life-save:app-v3:${suffix}`;
const now = new Date('2026-10-22T10:00:00+08:00');
test('migration writes new schema once, preserves legacy source and reloads real history', () => {
  const db = storage(), legacy = JSON.stringify({ privateContent: { demo: 'life-save-records-v2', entries: [{ id: 'old', at: now.toISOString() }] } });
  db.setItem(legacyKey, legacy);
  const s = createStore(db, '/prototype/', '', now);
  assert.equal(s.state.entries[0].id, 'old'); assert.equal(db.getItem(legacyKey), legacy);
  s.commit(state => addEntry(state, 'sheets', now, 'new'));
  assert.equal(createStore(db, '/prototype/', '', now).state.entries.length, 2);
  assert.equal(db.getItem(legacyKey), legacy);
});
test('storage failure never publishes a false successful record', () => {
  const db = storage(), s = createStore(db, '/prototype/', '', now), saved = db.getItem(newKey);
  db.setItem = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => s.commit(state => addEntry(state, 'medication', now, 'failed')));
  assert.equal(s.state.entries.length, 0); assert.equal(db.getItem(newKey), saved);
});
test('corrupt v3 and corrupt legacy both block writes without overwriting originals', () => {
  const db = storage(); db.setItem(newKey, '{bad');
  assert.throws(() => createStore(db, '/prototype/', '', now)); assert.equal(db.getItem(newKey), '{bad');
  db.map.clear(); db.setItem(legacyKey, '{broken');
  assert.throws(() => createStore(db, '/prototype/', '', now)); assert.equal(db.getItem(newKey), null); assert.equal(db.getItem(legacyKey), '{broken');
});
test('stale tab cannot overwrite another tab and can reload before retry', () => {
  const db = storage(), a = createStore(db, '/prototype/', '', now), b = createStore(db, '/prototype/', '', now);
  a.commit(s => addEntry(s, 'medication', now, 'a'));
  assert.throws(() => b.commit(s => addEntry(s, 'sheets', now, 'b')));
  b.reload(); b.commit(s => addEntry(s, 'sheets', now, 'b'));
  assert.equal(b.state.entries.length, 2);
});
test('test query data is isolated from the original page', () => {
  const db = storage(), main = createStore(db, '/prototype/', '', now), check = createStore(db, '/prototype/', '?check=v3', now);
  check.commit(s => addEntry(s, 'medication', now, 'test'));
  assert.equal(main.state.entries.length, 0); assert.equal(createStore(db, '/prototype/', '', now).state.entries.length, 0);
});

test('v3 upgrade preserves cards, confirmations, timestamps and a full source backup', async () => {
  const { createInitialState, saveEntryNote, saveJournal } = await import('./model.js');
  const db = storage();
  let previous = addEntry(createInitialState(now), 'door', now, 'door-1');
  previous.version = 3; previous.revision = 9; delete previous.journal;
  const raw = JSON.stringify(previous); db.setItem(newKey, raw);
  const upgraded = createStore(db, '/prototype/', '', now);
  assert.equal(upgraded.state.version, 4); assert.equal(upgraded.state.revision, 10);
  assert.deepEqual(upgraded.state.entries, previous.entries);
  assert.deepEqual(upgraded.state.cards, previous.cards);
  assert.deepEqual(upgraded.state.scenes, previous.scenes);
  assert.equal(db.getItem(`${newKey}:before-v4`), raw);
  upgraded.commit(s => saveEntryNote(s, 'door-1', '拉过门把手了', now));
  upgraded.commit(s => saveJournal(s, 'post', '随手记', now));
  const reloaded = createStore(db, '/prototype/', '', now);
  assert.equal(reloaded.state.entries[0].note, '拉过门把手了');
  assert.equal(reloaded.state.journal[0].text, '随手记');
  assert.equal(db.getItem(`${newKey}:before-v4`), raw);
  const saved = db.getItem(newKey);
  db.setItem = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => reloaded.commit(s => saveEntryNote(s, 'door-1', '失败的修改', now)));
  assert.equal(reloaded.state.entries[0].note, '拉过门把手了'); assert.equal(db.getItem(newKey), saved);
});
test('interrupted upgrade keeps v3 intact and can retry from its original backup', async () => {
  const { createInitialState } = await import('./model.js');
  const db = storage(), previous = createInitialState(now); previous.version = 3; delete previous.journal;
  const raw = JSON.stringify(previous); db.setItem(newKey, raw);
  const write = db.setItem; db.setItem = (key, value) => { if (key === newKey) throw new Error('Quota exceeded'); write(key, value); };
  assert.throws(() => createStore(db, '/prototype/', '', now));
  assert.equal(db.getItem(newKey), raw); assert.equal(db.getItem(`${newKey}:before-v4`), raw);
  db.setItem = write; assert.equal(createStore(db, '/prototype/', '', now).state.version, 4);
});
test('corrupt journal or note content blocks reading without erasing persisted data', async () => {
  const { createInitialState } = await import('./model.js');
  for (const broken of [s => { s.journal = [{ id: 'x', text: ' ' }]; }, s => { s.entries = [{ id: 'x', cardId: 'medication', at: now.toISOString(), roundId: null, note: 42 }]; }]) {
    const db = storage(), s = createInitialState(now); broken(s); const raw = JSON.stringify(s); db.setItem(newKey, raw);
    assert.throws(() => createStore(db, '/prototype/', '', now)); assert.equal(db.getItem(newKey), raw);
  }
});
test('upgrade refuses to overwrite a newer write observed while backing up v3', async () => {
  const { createInitialState } = await import('./model.js');
  const db = storage(), old = createInitialState(now); old.version = 3; delete old.journal;
  db.setItem(newKey, JSON.stringify(old));
  const newer = JSON.stringify(addEntry(old, 'sheets', now, 'concurrent'));
  const write = db.setItem;
  db.setItem = (key, value) => { write(key, value); if (key.endsWith(':before-v4')) write(newKey, newer); };
  assert.throws(() => createStore(db, '/prototype/', '', now));
  assert.equal(db.getItem(newKey), newer);
  db.setItem = write;
  assert.equal(createStore(db, '/prototype/', '', now).state.entries[0].id, 'concurrent');
});
