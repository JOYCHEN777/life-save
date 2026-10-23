import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_VERSION, MAX_WALLPAPER_DATA_LENGTH, THEMES, createAppearanceStore, createDefaultAppearance, validateAppearance } from './appearance.js';

function storage() {
  const map = new Map();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

const nowImage = 'data:image/png;base64,AAAA';
const nowAppearance = () => ({ version: APPEARANCE_VERSION, theme: 'mist', wallpaper: { dataUrl: nowImage, name: 'note.png' } });

test('appearance defaults are independent from record state', () => {
  const value = createDefaultAppearance();
  assert.deepEqual(value, { version: 1, theme: 'meadow', wallpaper: null });
  assert.doesNotThrow(() => validateAppearance(value));
});

test('appearance includes the peach and rainbow presets', () => {
  assert.deepEqual(THEMES.map(theme => theme.id), ['meadow', 'mist', 'blossom', 'midnight', 'peach', 'rainbow']);
  for (const theme of ['peach', 'rainbow']) {
    assert.doesNotThrow(() => validateAppearance({ version: APPEARANCE_VERSION, theme, wallpaper: null }));
  }
});

test('appearance validation rejects unknown themes and oversized images', () => {
  assert.throws(() => validateAppearance({ version: 1, theme: 'unknown', wallpaper: null }));
  assert.throws(() => validateAppearance({ version: 1, theme: 'meadow', wallpaper: { dataUrl: `data:image/png;base64,${'A'.repeat(MAX_WALLPAPER_DATA_LENGTH)}`, name: 'large.png' } }));
});

test('appearance store persists a theme and local wallpaper without touching record storage', () => {
  const db = storage(), store = createAppearanceStore(db, '/prototype/', '?check=appearance');
  assert.deepEqual(store.appearance, createDefaultAppearance());
  store.commit(nowAppearance());
  const reloaded = createAppearanceStore(db, '/prototype/', '?check=appearance');
  assert.equal(reloaded.appearance.theme, 'mist');
  assert.equal(reloaded.appearance.wallpaper.name, 'note.png');
  assert.equal([...db.map.keys()].every(key => key.startsWith('life-save:appearance-v1:')), true);
});

test('stale appearance tabs cannot overwrite a newer choice', () => {
  const db = storage(), first = createAppearanceStore(db, '/prototype/', ''), second = createAppearanceStore(db, '/prototype/', '');
  first.commit({ ...createDefaultAppearance(), theme: 'blossom' });
  assert.throws(() => second.commit({ ...createDefaultAppearance(), theme: 'midnight' }));
  second.reload();
  assert.equal(second.commit({ ...createDefaultAppearance(), theme: 'midnight' }).theme, 'midnight');
});

test('failed appearance write does not publish a false successful choice', () => {
  const db = storage(), store = createAppearanceStore(db, '/prototype/', ''), original = db.getItem;
  db.setItem = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => store.commit({ ...createDefaultAppearance(), theme: 'midnight' }));
  assert.equal(store.appearance.theme, 'meadow');
  assert.equal(original.call(db, store.key), null);
});
