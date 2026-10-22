import { createInitialState, validateState } from './model.js';

export function createStore(storage, pathname, search, now = new Date()) {
  const suffix = JSON.stringify([pathname, search]);
  const key = `life-save:app-v3:${suffix}`;
  const legacyKey = `codex:visualization-widget-state-v2:${suffix}`;
  let raw = storage.getItem(key);
  let state;
  if (raw !== null) state = validateState(JSON.parse(raw));
  else {
    const legacyRaw = storage.getItem(legacyKey);
    state = createInitialState(now, legacyRaw === null ? null : JSON.parse(legacyRaw));
    const serialized = JSON.stringify(state);
    // Keep the old source untouched; migration completes only after a real write.
    storage.setItem(key, serialized);
    raw = serialized;
  }
  return {
    key,
    get state() { return state; },
    commit(update) {
      if (storage.getItem(key) !== raw) throw new Error('另一个页面更新了记录，请刷新后重试。');
      const next = update(structuredClone(state));
      next.revision = state.revision + 1;
      validateState(next);
      const serialized = JSON.stringify(next);
      storage.setItem(key, serialized);
      // Publish in-memory success only after localStorage accepts the write.
      state = next;
      raw = serialized;
      return state;
    },
    reload() {
      const nextRaw = storage.getItem(key);
      if (nextRaw === null) throw new Error('本地记录已被移除，请刷新页面。');
      const next = validateState(JSON.parse(nextRaw));
      raw = nextRaw;
      state = next;
      return state;
    },
  };
}
