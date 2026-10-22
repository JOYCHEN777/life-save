export const localDayKey = value => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const moveLocalDay = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const unique = rows => new Set(rows.map(row => row.id)).size === rows.length;

export function createInitialState(now = new Date(), legacy = null) {
  const createdAt = now.toISOString();
  const card = (id, title, icon, tone, kind, sceneId = null, reminder = { type: 'none' }) => ({ id, title, icon, tone, kind, sceneId, reminder, createdAt });
  const state = {
    version: 3, revision: 0,
    cards: [
      card('medication', '过敏药', 'pill', 'mint', 'record'),
      card('sheets', '换床单', 'bed', 'blue', 'record', null, { type: 'interval', minutes: 10080 }),
      card('door', '门已锁', 'lock', 'mint', 'confirm', 'outing'),
      card('iron', '直板夹已断电', 'plug', 'peach', 'confirm', 'outing'),
      card('cat-breakfast', '猫咪早饭', 'cat', 'peach', 'confirm', 'cats', { type: 'daily', time: '08:00' }),
      card('cat-dinner', '猫咪晚饭', 'cat', 'peach', 'confirm', 'cats', { type: 'daily', time: '20:00' }),
      card('cat-probiotic', '猫咪益生菌', 'sparkles', 'lilac', 'confirm', 'cats'),
    ],
    scenes: [
      { id: 'outing', title: '出门前', mode: 'manual', roundId: `outing:${createdAt}`, startedAt: createdAt },
      { id: 'cats', title: '猫咪照顾', mode: 'daily', roundId: 'daily', startedAt: createdAt },
    ],
    entries: [], settings: { sound: false, strength: 'crisp' },
  };
  const old = legacy?.privateContent;
  if (legacy !== null) {
    requireValue(legacy && typeof legacy === 'object' && !Array.isArray(legacy), '旧记录格式无法读取');
    if (old != null) {
      requireValue(['life-save-records-v2', 'life-save-tactile-v1'].includes(old.demo), '未知的旧记录版本');
      state.settings.sound = old.sound === true;
      state.settings.strength = old.strength === 'soft' ? 'soft' : 'crisp';
      if (old.demo === 'life-save-records-v2') {
        requireValue(Array.isArray(old.entries) && old.entries.every(e => e && typeof e.id === 'string' && e.id && validDate(e.at)) && unique(old.entries), '旧记录损坏，已保留原数据');
        state.entries = old.entries.map(e => ({ id: e.id, at: e.at, cardId: 'medication', roundId: null }));
      }
    }
  }
  return validateState(state);
}

export function validateState(s) {
  requireValue(s && s.version === 3 && Number.isSafeInteger(s.revision) && s.revision >= 0, '记录版本无法读取');
  requireValue(Array.isArray(s.cards) && Array.isArray(s.scenes) && Array.isArray(s.entries), '记录结构不完整');
  for (const rows of [s.cards, s.scenes, s.entries]) {
    requireValue(rows.every(row => row && typeof row.id === 'string' && row.id.length > 0) && unique(rows), '记录标识重复或缺失');
  }
  requireValue(s.settings && typeof s.settings.sound === 'boolean' && ['crisp', 'soft'].includes(s.settings.strength), '设置无法读取');
  for (const scene of s.scenes) requireValue(typeof scene.title === 'string' && ['manual', 'daily'].includes(scene.mode) && typeof scene.roundId === 'string' && validDate(scene.startedAt), '场景无法读取');
  for (const c of s.cards) {
    requireValue(typeof c.title === 'string' && c.title.trim().length > 0 && c.title.length <= 40 && ['record', 'confirm'].includes(c.kind) && validDate(c.createdAt), '卡片无法读取');
    requireValue(c.sceneId === null || s.scenes.some(scene => scene.id === c.sceneId), '场景不存在');
    requireValue(c.kind === 'confirm' || c.sceneId === null, '记录卡不能加入确认场景');
    const r = c.reminder;
    requireValue(r && ['none', 'interval', 'daily'].includes(r.type), '提醒规则无法读取');
    if (r.type === 'interval') requireValue(Number.isFinite(r.minutes) && r.minutes >= 1 && r.minutes <= 5256000, '间隔需在 1 分钟至 10 年内');
    if (r.type === 'daily') requireValue(typeof r.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time), '每日提醒时间无效');
  }
  for (const e of s.entries) requireValue(s.cards.some(c => c.id === e.cardId) && validDate(e.at) && (e.roundId === null || typeof e.roundId === 'string'), '历史记录无法读取');
  return s;
}

export const cardEntries = (state, cardId) => state.entries.filter(e => e.cardId === cardId);
export function roundForCard(state, card, now) {
  if (card.kind === 'record') return null;
  const scene = state.scenes.find(s => s.id === card.sceneId);
  if (scene?.mode === 'manual') return scene.roundId;
  return `${scene?.id || 'day'}:${localDayKey(now)}`;
}
export function confirmationEntry(state, card, now) {
  if (card.kind !== 'confirm') return null;
  return cardEntries(state, card.id).find(e => e.roundId === roundForCard(state, card, now)) || null;
}
export function addEntry(state, cardId, now, id) {
  const card = state.cards.find(c => c.id === cardId);
  requireValue(card, '卡片不存在');
  requireValue(!confirmationEntry(state, card, now), '这一次已经确认过了');
  return { ...state, entries: [{ id, cardId, at: now.toISOString(), roundId: roundForCard(state, card, now) }, ...state.entries] };
}
export function undoEntry(state, cardId) {
  const latest = cardEntries(state, cardId)[0];
  return latest ? { ...state, entries: state.entries.filter(e => e.id !== latest.id) } : state;
}
export function startRound(state, sceneId, now, id) {
  const scene = state.scenes.find(s => s.id === sceneId);
  requireValue(scene?.mode === 'manual', '这个场景按天更新');
  return { ...state, scenes: state.scenes.map(s => s.id === sceneId ? { ...s, roundId: id, startedAt: now.toISOString() } : s) };
}

export function reminderInfo(card, entries, now) {
  const r = card.reminder;
  const empty = { dueAt: null, progress: 0, remainingMs: null };
  if (r.type === 'none') return { ...empty, status: 'off' };
  let start, due;
  if (r.type === 'interval') {
    if (!entries.length) return { ...empty, status: 'unstarted' };
    start = Date.parse(entries[0].at);
    due = start + r.minutes * 60000;
  } else {
    const [h, m] = r.time.split(':').map(Number);
    const completedToday = entries.some(e => localDayKey(e.at) === localDayKey(now));
    due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (completedToday ? 1 : 0), h, m).getTime();
    const d = new Date(due);
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m).getTime();
  }
  const remainingMs = due - now.getTime();
  return { status: remainingMs <= 0 ? 'due' : 'upcoming', dueAt: new Date(due).toISOString(), progress: Math.max(0, Math.min(1, (now.getTime() - start) / (due - start))), remainingMs };
}

export function calendarModel(entries, now, page = 0) {
  const today = moveLocalDay(now, 0);
  const start = moveLocalDay(today, -today.getDay() - 77 - page * 84);
  const end = moveLocalDay(start, 83);
  const todayKey = localDayKey(today);
  const buckets = new Map();
  for (const e of entries) {
    const key = localDayKey(e.at);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const days = Array.from({ length: 84 }, (_, i) => {
    const date = moveLocalDay(start, i), key = localDayKey(date);
    return { date, key, count: (buckets.get(key) || []).length, future: key > todayKey };
  });
  return { start, end, todayKey, days, buckets, activeDays: days.filter(d => !d.future && d.count > 0).length };
}
