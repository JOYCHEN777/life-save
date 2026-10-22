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
