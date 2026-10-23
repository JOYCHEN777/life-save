import { localDayKey, cardEntries, confirmationEntry, reminderInfo, calendarModel, heatLevel, dayMarkers, timelineItems, memoryCandidates, drawMemory as drawRandomMemory } from './model.js';
import { THEMES, MAX_WALLPAPER_DATA_LENGTH, cloneAppearance, createDefaultAppearance } from './appearance.js';
import { RemoteStore, RemoteStoreError, readLegacySnapshots, resolveServiceOrigin, resolveSpace } from './sqlite-store.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  journal: '<path d="M4 4h16v14H8l-4 3ZM8 8h8M8 12h5"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  scenes: '<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M9 3h6v4H9zM8 12h1m3 0h4m-8 5h1m3 0h4"/>',
  cards: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h1m6 0h1"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  pill: '<path d="M10 4a6 6 0 0 1 8 8l-6 6a6 6 0 0 1-8-8Zm-3 3 10 10"/>',
  bed: '<path d="M3 18V7m18 11V7M3 14h18M5 14V6h14v8M7 10h3m4 0h3M3 18v3m18-3v3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v4"/>',
  cat: '<path d="M4 12 3 3l7 4h4l7-4-1 9a8 8 0 1 1-16 0Zm4 1h.01M16 13h.01M10 17l2 1 2-1"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14ZM3 21h18"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M9 7V4h6v3m-9 0 1 13h10l1-13"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sparkles}</svg>`;
const pages = [['home', '首页', 'home'], ['scenes', '场景清单', 'scenes'], ['cards', '全部卡片', 'cards'], ['calendar', '记录日历', 'calendar'], ['feed', '生活动态', 'journal'], ['settings', '设置', 'settings']];
const ui = { page: 'home', filter: 'all', calendarPage: 0, selectedDay: null, detailId: null, detailAll: false, feedFilter: 'all', feedLimit: 40, feedFocusId: null, composer: null, appearanceDraft: null, memory: { seenIds: new Set(), item: null, wrapped: false } };
let store, state = null, readonly = true, storageReady = false, storageLoading = true, storageError = '', toastTimer, audioContext, writing = false;
let appearance = createDefaultAppearance(), appearanceError = '', appearanceWriting = false;
let legacySources = [], migration = { source: null, preview: null, busy: false, error: '' };
const cooldowns = new Map();
const pendingRecordIds = new Map();
const calendarScrolls = new Map();
const storageSpace = resolveSpace(location);
const serviceOrigin = resolveServiceOrigin(location);
store = new RemoteStore({ serviceOrigin, space: storageSpace });
function showError(text) { $('#error-banner').textContent = text; $('#error-banner').hidden = false; }
function clearError() { $('#error-banner').hidden = true; $('#error-banner').textContent = ''; }
function scanLegacySources() {
  try { legacySources = readLegacySnapshots(localStorage); }
  catch { legacySources = []; }
}
function acceptSnapshot(snapshot) {
  store.accept(snapshot);
  state = store.state;
  appearance = store.appearance;
  readonly = false;
  storageReady = true;
  storageLoading = false;
}
async function bootstrapStorage() {
  storageLoading = true;
  storageError = '';
  render();
  try {
    acceptSnapshot(await store.load());
    scanLegacySources();
    clearError();
    render();
  } catch (error) {
    state = null;
    storageReady = false;
    readonly = true;
    storageLoading = false;
    storageError = error instanceof RemoteStoreError ? error.message : `本机存储服务读取失败：${error.message}`;
    render();
    showError(`正式存档没有读取成功。${storageError} 未创建默认空存档，请启动本机服务后重试。`);
  }
}
async function reloadStorage({ silent = false } = {}) {
  if (!store || !storageReady || writing || $('#editor').open || $('#composer').open) return;
  const before = store.snapshot?.revisions ? JSON.stringify(store.snapshot.revisions) : '';
  try {
    const snapshot = await store.reload();
    const after = JSON.stringify(snapshot.revisions);
    if (before !== after) {
      acceptSnapshot(snapshot);
      if (!silent) clearError();
      render();
    }
  } catch (error) {
    if (!silent) showError(`本机存档暂时无法刷新。${error.message} 当前已读取的内容仍保留。`);
  }
}
function toast(text, undoId = null, entryId = null) {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = `${icon('check')}<span>${esc(text)}</span>${entryId ? `<button data-action="note" data-id="${esc(entryId)}">补一句</button>` : ''}${undoId ? `<button data-action="undo" data-id="${esc(undoId)}">撤销</button>` : ''}`;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}
const timeOnly = value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const preciseTime = value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const fullTime = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const shortDate = value => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(value));
function duration(ms) {
  const mins = Math.max(1, Math.ceil(Math.abs(ms) / 60000));
  if (mins < 60) return `${mins} 分钟`;
  if (mins < 1440) return `${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分钟` : ''}`;
  return `${Math.floor(mins / 1440)} 天${Math.floor(mins % 1440 / 60) ? ` ${Math.floor(mins % 1440 / 60)} 小时` : ''}`;
}
function currentAppearance() { return ui.appearanceDraft || appearance; }
function themeInfo(id) { return THEMES.find(theme => theme.id === id) || THEMES[0]; }
function syncWallpaperPreview() {
  const preview = document.querySelector('[data-wallpaper-preview]');
  if (!preview) return;
  const wallpaper = currentAppearance().wallpaper;
  preview.style.backgroundImage = wallpaper ? `url("${wallpaper.dataUrl}")` : '';
  preview.classList.toggle('has-image', Boolean(wallpaper));
}
function syncAppearance() {
  const value = currentAppearance(), theme = themeInfo(value.theme);
  document.body.dataset.theme = value.theme;
  document.body.classList.toggle('has-wallpaper', Boolean(value.wallpaper));
  document.body.style.setProperty('--wallpaper-image', value.wallpaper ? `url("${value.wallpaper.dataUrl}")` : 'none');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme.metaColor;
  syncWallpaperPreview();
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败，请换一张图片。'));
    reader.readAsDataURL(file);
  });
}
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片无法解码，请换一张图片。'));
    image.src = dataUrl;
  });
}
async function prepareWallpaper(file) {
  if (!file?.type || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('支持 JPG、PNG、WebP 或 GIF 图片。');
  if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12 MB。');
  const source = await readFileAsDataUrl(file), image = await loadImage(source);
  const maxSide = 1600, scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法处理这张图片。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let dataUrl = canvas.toDataURL('image/jpeg', .82);
  if (dataUrl.length > MAX_WALLPAPER_DATA_LENGTH) dataUrl = canvas.toDataURL('image/jpeg', .68);
  if (dataUrl.length > MAX_WALLPAPER_DATA_LENGTH) throw new Error('图片压缩后仍然过大，请换一张图片。');
  return { dataUrl, name: file.name.slice(0, 200), type: 'image/jpeg' };
}
function previewAppearance(next) {
  ui.appearanceDraft = cloneAppearance(next);
  syncAppearance();
  render();
}
async function applyAppearance(next, message) {
  if (appearanceWriting) return false;
  if (!storageReady) { showError('本机存储服务尚未连接，外观没有保存。当前预览仍保留，可连接后重试。'); return false; }
  appearanceWriting = true;
  try {
    acceptSnapshot(await store.dispatch('appearance_update', { appearance: next }));
    ui.appearanceDraft = null; appearanceError = ''; appearanceWriting = false; clearError(); syncAppearance(); render(); toast(message); return true;
  } catch (error) {
    if (error.current) acceptSnapshot(error.current);
    appearanceWriting = false; showError(`外观没有保存成功，原设置仍然保留。${error.message}`); render(); return false;
  } finally { appearanceWriting = false; }
}
function cancelAppearancePreview() {
  if (!ui.appearanceDraft) return;
  ui.appearanceDraft = null;
  syncAppearance();
  render();
  toast('已取消外观预览。');
}
function elapsed(at) { const ms = Date.now() - Date.parse(at); return ms < 60000 ? '刚刚' : duration(ms); }
function ruleLabel(card) { const r = card.reminder; return r.type === 'interval' ? `每隔 ${duration(r.minutes * 60000)}` : r.type === 'daily' ? `每天 ${r.time}` : '随时记录'; }
function reminderHTML(card, entries) {
  const info = reminderInfo(card, entries, new Date());
  if (info.status === 'off') return '';
  const label = info.status === 'unstarted' ? '记下第一次后，开始计算间隔' : info.status === 'due' ? `已到期 · 超过 ${duration(info.remainingMs)}` : `距离下一次还有 ${duration(info.remainingMs)}`;
  const meta = info.dueAt ? `期望时间 · ${shortDate(info.dueAt)} ${timeOnly(info.dueAt)}` : '以实际记录的时间为起点';
  return `<div class="reminder-block ${info.status === 'due' ? 'due' : ''}"><div class="reminder-label">${icon('clock')}<span>${label}</span></div><div class="progress-track" role="progressbar" aria-label="${esc(card.title)}的提醒进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(info.progress * 100)}" aria-valuetext="${esc(label)}"><span style="width:${info.progress * 100}%"></span></div><div class="meta">${meta}</div></div>`;
}
function cardHTML(card) {
  const entries = cardEntries(state, card.id), latest = entries[0], confirmed = confirmationEntry(state, card, new Date());
  const cooling = (cooldowns.get(card.id) || 0) > Date.now(), confirm = card.kind === 'confirm';
  const label = confirmed ? '已确认完成' : confirm ? '确认已完成' : latest ? '再记一次' : card.id === 'medication' ? '我已服药，记一下' : '记一下';
  const scene = state.scenes.find(s => s.id === card.sceneId);
  const caption = confirm ? (scene?.mode === 'manual' ? '本次出门' : '今天的确认') : card.id === 'medication' ? '距上次服药记录' : '距上次记录';
  return `<article class="life-card" data-tone="${esc(card.tone)}"><div class="card-top"><span class="card-icon">${icon(card.icon)}</span><div class="card-heading"><h3>${esc(card.title)}</h3><span class="tag">${confirm ? '完成确认' : '随手记录'}${card.reminder.type !== 'none' ? ` · ${esc(ruleLabel(card))}` : ''}</span></div><button class="icon-button card-menu" data-action="edit-card" data-id="${esc(card.id)}" aria-label="设置${esc(card.title)}">${icon('edit')}</button></div><div class="card-stat"><div class="caption">${caption}</div><div class="value ${confirmed ? 'confirmed-value' : ''}">${confirm ? confirmed ? '确认过了' : '还待确认' : latest ? elapsed(latest.at) : '还没有记录'}</div><div class="meta">${confirmed ? `你在 ${shortDate(confirmed.at)} ${timeOnly(confirmed.at)} 亲手确认过` : confirm ? '做完后点一下，给自己一个凭据' : latest ? fullTime(latest.at) : '下一次想知道，打开就看得见'}</div></div>${reminderHTML(card, entries)}<div class="card-actions"><button class="record-button ${confirmed ? 'is-done' : ''}" data-action="record" data-id="${esc(card.id)}" aria-label="${esc(card.title)}：${label}" ${readonly || confirmed || cooling ? 'disabled' : ''}>${icon(confirmed || confirm ? 'check' : 'sparkles')}<span>${cooling ? '记住啦！' : label}</span></button></div><div class="latest-note-slot">${latest ? `<button class="text-button latest-note" data-action="note" data-id="${esc(latest.id)}" ${readonly ? 'disabled' : ''}>${icon('journal')}${latest.note ? '查看 / 修改备注' : '给最近一次补一句'}</button>` : ''}</div><div class="card-foot"><button class="text-button" data-action="detail" data-id="${esc(card.id)}">${icon('calendar')}记录日历${entries.length ? ` · ${entries.length}` : ''}</button>${latest ? `<button class="text-button" data-action="undo" data-id="${esc(card.id)}" ${readonly ? 'disabled' : ''}>撤销最近一次</button>` : ''}</div></article>`;
}
function sceneHTML(scene) {
  const cards = state.cards.filter(c => c.sceneId === scene.id), done = cards.filter(c => confirmationEntry(state, c, new Date())).length;
  return `<section class="scene-card"><div class="scene-header"><span class="scene-icon" data-tone="${scene.id === 'cats' ? 'peach' : 'mint'}">${icon(scene.id === 'cats' ? 'cat' : 'lock')}</span><div class="scene-title"><h3>${esc(scene.title)}</h3><p class="scene-summary">${scene.mode === 'daily' ? `${shortDate(new Date())} · 今天` : `本次始于 ${shortDate(scene.startedAt)} ${timeOnly(scene.startedAt)}`} · ${done}/${cards.length} 已确认</p></div><span class="pill ${done && done === cards.length ? 'complete' : ''}">${done && done === cards.length ? '本轮已完成' : '逐项确认'}</span></div><div class="scene-list">${cards.map(card => {
    const e = confirmationEntry(state, card, new Date()), r = reminderInfo(card, cardEntries(state, card.id), new Date());
    const hint = e ? `你在 ${shortDate(e.at)} ${timeOnly(e.at)} 确认过` : r.status === 'off' ? '本轮还未确认' : r.status === 'due' ? `期望 ${card.reminder.type === 'daily' ? card.reminder.time : timeOnly(r.dueAt)} · 待确认` : r.status === 'upcoming' ? `还有 ${duration(r.remainingMs)}` : '确认后开始计算间隔';
    return `<div class="scene-row ${e ? 'confirmed' : ''}"><span class="check-symbol">${icon(e ? 'check' : card.icon)}</span><div class="scene-item-text"><strong>${esc(card.title)}</strong><span class="confirmation-time">${hint}</span></div>${e ? `<button class="text-button" data-action="detail" data-id="${esc(card.id)}" aria-label="查看${esc(card.title)}的确认记录">查看</button>` : `<button class="confirm-button" data-action="record" data-id="${esc(card.id)}" aria-label="确认${esc(card.title)}" ${readonly ? 'disabled' : ''}>确认</button>`}</div>`;
  }).join('')}</div><div class="scene-footer">${scene.mode === 'manual' ? `<button class="text-button" data-action="new-round" data-id="${esc(scene.id)}" ${readonly ? 'disabled' : ''}>＋ 开始新一次出门</button>` : '<span class="subtle">每天开启新一轮 · 历史一直保留</span>'}<button class="text-button" data-action="category-calendar" data-id="${esc(scene.id)}">${icon('calendar')}记录日历</button><button class="text-button" data-action="new-card" data-scene="${esc(scene.id)}">添加事项 ${icon('arrow')}</button></div></section>`;
}
const heading = (eyebrow, title, lead) => `<div class="page-head"><div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1><p class="lead">${lead}</p></div>`;
function renderHome() {
  const now = new Date(), pending = state.cards.filter(c => c.kind === 'confirm' && !confirmationEntry(state, c, now)).length;
  const due = state.cards.filter(c => reminderInfo(c, cardEntries(state, c.id), now).status === 'due' && !confirmationEntry(state, c, now)).length;
  return `${heading(new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now), '让小事，有个着落。', '随手记下，轻轻确认。剩下的时间，留给生活。')}<div class="overview-strip"><div class="overview-item">${icon('scenes')}<strong>${pending}</strong><span>件事待确认</span></div><div class="overview-item">${icon('clock')}<strong>${due}</strong><span>项提醒已到时间</span></div><div class="overview-item">${icon('check')}<span>每一条记录，都有时间可查</span></div></div>${memoryHTML()}<div class="section-heading"><h2>随手记一下</h2><button class="text-button" data-action="navigate" data-view="cards">全部卡片 ${icon('arrow')}</button></div><div class="cards-grid">${state.cards.filter(c => !c.sceneId).map(cardHTML).join('')}</div><div class="section-heading"><h2>确认过，就安心了</h2><span class="subtle">给刚刚做过的事，留一个凭据</span></div><div class="scenes-grid">${state.scenes.map(sceneHTML).join('')}</div>`;
}

function memoryDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(value));
}

function memoryHTML() {
  const candidates = memoryCandidates(state, new Date());
  const current = ui.memory.item && candidates.find(candidate => candidate.id === ui.memory.item.id);
  if (ui.memory.item && !current) { ui.memory.item = null; ui.memory.wrapped = false; }
  const item = current || null;
  const card = item?.type === 'entry' ? state.cards.find(candidate => candidate.id === item.cardId) : null;
  const source = item ? item.type === 'journal' ? '那天写下的随手记' : `给「${card.title}」补的一句` : '';
  const hasCandidates = candidates.length > 0;
  return `<section class="memory-panel" aria-labelledby="memory-title"><div class="memory-header"><div><div class="eyebrow">给今天一点回声</div><h2 id="memory-title">翻翻以前</h2></div><span class="memory-mark" aria-hidden="true">↺</span></div>${item ? `<article class="memory-card revealed"><div class="memory-card-top"><span>${esc(source)}</span><time datetime="${esc(item.at)}">${esc(memoryDate(item.at))}</time></div><p class="memory-text">${esc(item.text)}</p><p class="memory-caption">这是你在那天留下的内容，原文没有被改动。</p><div class="memory-actions"><button class="button primary" data-action="draw-memory">再翻一张</button><button class="text-button" data-action="open-memory" data-memory-type="${item.type}" data-memory-id="${esc(item.sourceId)}">进入原记录 ${icon('arrow')}</button></div></article>` : `<div class="memory-empty"><strong>${hasCandidates ? '今天想不想遇见一段旧内容？' : '还没有可以翻开的旧内容'}</strong><p>${hasCandidates ? '从真实的随手记和备注里，随机翻一张。' : '写下随手记，或给完成的记录补一句，过几天再回来找。'}</p><div class="memory-actions">${hasCandidates ? '<button class="button primary" data-action="draw-memory">翻一张</button>' : `<button class="button secondary" data-action="new-journal" ${readonly ? 'disabled' : ''}>先留下今天</button>`}</div></div>`}</section>`;
}

function drawMemoryFromHistory() {
  const result = drawRandomMemory(memoryCandidates(state, new Date()), ui.memory.seenIds);
  ui.memory = { seenIds: result.seenIds, item: result.item, wrapped: result.wrapped };
  render();
  document.querySelector('.memory-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openMemory(type, id) {
  if (type === 'entry') {
    const entry = state.entries.find(item => item.id === id);
    if (!entry) { ui.memory.item = null; render(); toast('这段记录已经不存在了。'); return; }
    ui.detailId = entry.cardId;
    ui.detailAll = true;
    ui.calendarPage = 0;
    ui.selectedDay = localDayKey(entry.at);
    renderDetails();
    $('#details').showModal();
    return;
  }
  const journal = state.journal.find(item => item.id === id);
  if (!journal) { ui.memory.item = null; render(); toast('这段随手记已经不存在了。'); return; }
  const journalItems = timelineItems(state, 'journal');
  const index = journalItems.findIndex(item => item.id === id);
  ui.feedFilter = 'journal';
  ui.feedLimit = Math.max(40, index + 1);
  ui.feedFocusId = `journal:${id}`;
  navigate('feed');
}
function colorFor(card) {
  const defaults = { medication: '#82ad6b', sheets: '#5b9fa9', door: '#d4a34d', iron: '#d77e78', 'cat-breakfast': '#f5a051', 'cat-dinner': '#6b9fdf', 'cat-probiotic': '#b28cdb' };
  if (defaults[card.id]) return defaults[card.id];
  const custom = state.cards.filter(c => !defaults[c.id]).findIndex(c => c.id === card.id);
  return `hsl(${(custom * 137.5 + 165) % 360} 45% 52%)`;
}
function calendarGroups() {
  return [{ id: 'all', title: '总览' }, ...state.scenes.map(s => ({ id: `scene:${s.id}`, title: s.title })), { id: 'records', title: '随手记录' }, { id: 'confirms', title: '独立确认' }];
}
function calendarScope() {
  if (ui.filter === 'all') return { title: '所有卡片的记录', entries: state.entries, cards: null };
  const group = calendarGroups().find(g => g.id === ui.filter);
  const cards = state.cards.filter(c => ui.filter.startsWith('scene:') ? c.sceneId === ui.filter.slice(6) : ui.filter === 'records' ? c.kind === 'record' : ui.filter === 'confirms' ? c.kind === 'confirm' && !c.sceneId : c.id === ui.filter);
  const ids = new Set(cards.map(c => c.id));
  return { title: group?.title || cards[0]?.title || '记录日历', entries: state.entries.filter(e => ids.has(e.cardId)), cards: group ? cards : null };
}
function noteButton(e) {
  return `<button class="text-button note-action" data-action="note" data-id="${esc(e.id)}" aria-label="${e.note ? '修改' : '补充'}${esc(state.cards.find(c => c.id === e.cardId)?.title)} ${esc(fullTime(e.at))}的备注" ${readonly ? 'disabled' : ''}>${icon('journal')}${e.note ? '修改备注' : '补一句'}</button>`;
}
function historyItem(e) {
  const c = state.cards.find(c => c.id === e.cardId);
  return `<li class="history-item"><span class="history-icon" style="color:${colorFor(c)}">${icon(c.icon)}</span><div class="history-label"><div class="history-top"><strong>${esc(c.title)}</strong><time datetime="${esc(e.at)}">${ui.detailAll ? fullTime(e.at) : preciseTime(e.at)}</time></div><span class="meta">${c.kind === 'confirm' ? '你已确认完成' : '已记录'}</span>${e.note ? `<p class="entry-note">${esc(e.note)}</p><span class="note-date">补充于 ${fullTime(e.noteUpdatedAt)}</span>` : ''}${noteButton(e)}</div></li>`;
}
function calendarHTML(entries, title = '', categoryCards = null) {
  const model = calendarModel(entries, new Date(), ui.calendarPage), last = ui.calendarPage ? localDayKey(model.end) : model.todayKey;
  if (!ui.selectedDay || ui.selectedDay < localDayKey(model.start) || ui.selectedDay > last) ui.selectedDay = last;
  const months = [];
  model.days.forEach((d, i) => {
    if (i % 7) return; const week = i / 7;
    if (week === 0 ? d.date.getMonth() !== model.days[7].date.getMonth() : d.date.getMonth() === model.days[i - 7].date.getMonth()) return;
    months.push(`<span style="grid-column:${week + 2}/span ${Math.min(2, 12 - week)}">${d.date.getMonth() + 1}月</span>`);
  });
  const selected = ui.detailAll ? entries : model.buckets.get(ui.selectedDay) || [];
  const square = (c, extra = '') => `<span class="activity-square ${extra}" style="--activity-color:${colorFor(c)}" aria-hidden="true"></span>`;
  const cells = model.days.map((d, i) => {
    const position = `grid-column:${Math.floor(i / 7) + 2};grid-row:${i % 7 + 1}`;
    if (d.future) return `<span class="calendar-day future" aria-hidden="true" style="${position}"></span>`;
    let markers = '', description = `${d.key}，${d.count} 条记录`;
    if (categoryCards) {
      const daily = model.buckets.get(d.key) || [], { slots, overflow } = dayMarkers(categoryCards, daily);
      markers = `<span class="day-markers" aria-hidden="true">${slots.map(slot => square(categoryCards.find(c => c.id === slot.cardId), slot.count ? '' : 'unrecorded')).join('')}${overflow ? `<span class="marker-overflow">+${overflow}</span>` : ''}</span>`;
      description += categoryCards.map(c => { const n = daily.filter(e => e.cardId === c.id).length; return n ? `，${c.title} ${n} 次` : ''; }).join('');
    }
    return `<button class="calendar-day ${d.key === model.todayKey ? 'today' : ''} ${d.key === ui.selectedDay && !ui.detailAll ? 'selected' : ''}" ${categoryCards ? '' : `data-heat="${heatLevel(d.count)}"`} style="${position}" data-action="calendar-day" data-day="${d.key}" aria-label="${esc(description)}" aria-pressed="${d.key === ui.selectedDay && !ui.detailAll}" ${d.key === model.todayKey ? 'aria-current="date"' : ''} title="${esc(description)}">${markers}</button>`;
  }).join('');
  const legend = categoryCards ? `<div class="activity-legend">${categoryCards.map(c => `<span>${square(c)}${esc(c.title)}</span>`).join('') || '<span>这个分类还没有卡片</span>'}</div><p class="calendar-help">一个小方块代表这项当天有记录，点开看次数与备注。${categoryCards.length > 4 ? '超过格子容量的事项显示为 +N。' : ''}</p>` : `<div class="calendar-legend heat-legend">${['0', '1', '2–3', '4–6', '7+'].map((label, i) => `<span><i class="legend-dot" data-heat="${i}"></i>${label}</span>`).join('')}<span>条记录</span></div><p class="calendar-help">颜色越深，记录越多。备注和独立随手记不计入次数。</p>`;
  const total = model.days.reduce((n, d) => n + (d.future ? 0 : d.count), 0);
  return `<section class="calendar-panel ${categoryCards ? 'category-calendar' : 'heat-calendar'}" data-scroll-key="${esc(`${categoryCards ? 'category' : 'heat'}:${title}:${localDayKey(model.start)}`)}" aria-label="按天查看记录日历"><div class="calendar-toolbar"><div><strong>${esc(title || '记录日历')}</strong><div class="meta">${ui.calendarPage ? '' : '近 '}12 周 · ${total} 条记录 · ${model.activeDays} 天有记录</div></div><div class="calendar-controls"><button class="icon-button" data-action="calendar-prev" aria-label="查看前12周">‹</button><button class="icon-button" data-action="calendar-next" aria-label="查看后12周" ${ui.calendarPage === 0 ? 'disabled' : ''}>›</button></div></div><div class="calendar-range">${localDayKey(model.start).replace(/-/g, '/')} — ${last.replace(/-/g, '/')}</div><div class="calendar-scroll"><div class="calendar-chart"><div class="calendar-months" aria-hidden="true">${months.join('')}</div><div class="calendar-grid" role="group" aria-label="每天一个方格，按周排列">${['日', '一', '二', '三', '四', '五', '六'].map((d, i) => `<span class="weekday" aria-hidden="true" style="grid-column:1;grid-row:${i + 1}">${d}</span>`).join('')}${cells}</div></div></div>${legend}<div class="section-heading day-heading"><h3>${ui.detailAll ? '全部记录' : ui.selectedDay.replace(/-/g, '/')}${ui.selectedDay === model.todayKey && !ui.detailAll ? ' · 今天' : ''}<span class="subtle"> · ${selected.length} 条</span></h3><button class="text-button" data-action="all-history">${ui.detailAll ? '返回按天查看' : '全部记录'}</button></div><ul class="history-list">${selected.length ? selected.map(historyItem).join('') : '<li class="empty-state compact">这一天没有记录。<span>有需要的时候，再来记一下。</span></li>'}</ul></section>`;
}
function feedHTML() {
  const items = timelineItems(state, ui.feedFilter), shown = items.slice(0, ui.feedLimit);
  let previousDay = '';
  return `${heading('把生活，留给以后的自己', '生活动态', '那些做过的小事，和当时想说的话。')}
    <button class="journal-invite" data-action="new-journal" ${readonly ? 'disabled' : ''}><span class="journal-invite-icon">${icon('edit')}</span><span><strong>今天，有什么想留下的？</strong><small>不用完成一件事，也能随手写几句</small></span><span class="journal-invite-cta">写随手记 ＋</span></button>
    <div class="category-tabs feed-tabs" aria-label="动态筛选">${[['all', '全部动态'], ['notes', '有备注的记录'], ['journal', '独立随手记']].map(([value, title]) => `<button class="filter-chip ${ui.feedFilter === value ? 'active' : ''}" data-action="feed-filter" data-filter="${value}" aria-pressed="${ui.feedFilter === value}">${title}</button>`).join('')}<span class="feed-count">${items.length} 条</span></div>
    <div class="feed-timeline">${shown.map(item => {
      const day = localDayKey(item.at), newDay = day !== previousDay; previousDay = day;
      const journal = item.type === 'journal', card = journal ? null : state.cards.find(c => c.id === item.cardId);
      const feedId = `${item.type}:${item.id}`;
      return `${newDay ? `<h2 class="feed-day">${day === localDayKey(new Date()) ? '今天' : day.replace(/-/g, '/')}<span>${shortDate(item.at)}</span></h2>` : ''}<article class="feed-item ${journal ? 'journal-item' : ''} ${ui.feedFocusId === feedId ? 'is-memory-focus' : ''}" data-feed-id="${esc(feedId)}" tabindex="-1"><div class="feed-symbol" ${card ? `style="color:${colorFor(card)}"` : ''}>${icon(journal ? 'edit' : card.icon)}</div><div class="feed-content"><div class="feed-item-head"><h3>${journal ? '随手记' : esc(card.title)}</h3><time datetime="${esc(item.at)}">${preciseTime(item.at)}</time></div><span class="feed-kind">${journal ? '此刻的想法' : card.kind === 'confirm' ? '确认完成' : '随手记录'}</span>${journal || item.note ? `<p class="feed-text">${esc(journal ? item.text : item.note)}</p>` : ''}${!journal && item.note ? `<span class="note-date">补充于 ${fullTime(item.noteUpdatedAt)}</span>` : ''}<div class="feed-item-actions">${journal ? `<button class="text-button danger" data-action="delete-journal" data-id="${esc(item.id)}" data-updated-at="${esc(item.updatedAt)}" ${readonly ? 'disabled' : ''} aria-label="删除这条随手记">${icon('trash')}删除</button>` : `${noteButton(item)}<button class="text-button" data-action="detail" data-id="${esc(card.id)}">查看卡片记录 ${icon('arrow')}</button>`}</div></div></article>`;
    }).join('') || `<div class="feed-empty">${icon('journal')}<h2>${ui.feedFilter === 'notes' ? '还没有补充过文字' : ui.feedFilter === 'journal' ? '留下一点此刻的想法' : '生活的小事，从这里留下'}</h2><p>${ui.feedFilter === 'notes' ? '在任意记录旁点「补一句」，就会出现在这里。' : '记录、确认，或写一条随手记，都会留在这里。'}</p></div>`}</div>
    ${items.length > shown.length ? '<button class="button secondary feed-more" data-action="feed-more">再往前看看</button>' : shown.length ? '<p class="feed-end">暂时翻到这里，接下来留给生活。</p>' : ''}`;
}
function openComposer(type, id = null) {
  const item = type === 'entry' ? state.entries.find(e => e.id === id) : state.journal.find(p => p.id === id);
  if (id && !item) { toast('这条记录已经不存在了。'); return; }
  const note = type === 'entry', card = note ? state.cards.find(c => c.id === item.cardId) : null;
  ui.composer = { type, id: id || crypto.randomUUID(), requestId: crypto.randomUUID(), expected: note ? item.noteUpdatedAt || null : null };
  const text = note ? item.note || '' : item?.text || '';
  $('#composer').innerHTML = `<div class="dialog-header"><div><div class="eyebrow">${note ? '给这一刻，多留一点细节' : '只留给自己，想写什么都可以'}</div><h2 id="composer-title">${note ? '补一句' : '写一条随手记'}</h2></div><button class="icon-button" data-action="close-composer" aria-label="关闭文字编辑">×</button></div><form id="text-form" class="dialog-form"><div class="composer-context">${icon(note ? card.icon : 'edit')}<div><strong>${note ? esc(card.title) : '独立随手记'}</strong><span>${note ? fullTime(item.at) + ' 的记录' : '不必关联卡片，也不用完成任务'}</span></div></div><label class="composer-label" for="note-text">${note ? '想补充什么？' : '此刻想说的话'}</label><textarea id="note-text" name="text" maxlength="1000" rows="6" ${note ? '' : 'required'} placeholder="${note ? '例如：今天拌在罐头里，终于愿意吃了。' : '今天的小发现、心情，或突然想到的一句话……'}">${esc(text)}</textarea><div class="composer-meta"><span>${note ? '记录已经完成，补一句不增加次数。清空可移除备注。' : '仅保存在本机的生活动态中，保存后不能修改。'}</span><span id="text-count">${text.length}/1000</span></div><p class="error-text" id="text-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="button secondary" data-action="close-composer">先不写了</button><button type="submit" class="button primary" ${readonly ? 'disabled' : ''}>${note ? '保存备注' : '保存随手记'}</button></div></form>`;
  $('#composer').showModal(); $('#note-text').focus();
}
async function submitComposer(form) {
  if (writing || readonly) return;
  const { type, id, requestId, expected } = ui.composer, text = new FormData(form).get('text'), submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  const success = await change(type === 'entry' ? 'save_entry_note' : 'save_journal', type === 'entry'
    ? { entryId: id, text, expectedNoteUpdatedAt: expected, at: new Date().toISOString() }
    : { id, text, at: new Date().toISOString() }, type === 'entry' ? text.trim() ? '这句话，也记住了。' : '备注已移除，原记录仍在。' : '这段生活，留下来了。', null, null, requestId);
  if (success) { $('#composer').close(); if (type === 'journal') { ui.feedFilter = 'all'; ui.feedLimit = 40; navigate('feed'); } }
  else { $('#text-error').textContent = $('#error-banner').textContent; $('#text-error').hidden = false; submit.disabled = readonly; }
}
document.addEventListener('input', event => {
  if (event.target.id === 'note-text') $('#text-count').textContent = `${event.target.value.length}/1000`;
});
function appearanceHTML() {
  const value = currentAppearance(), previewing = Boolean(ui.appearanceDraft), disabled = !storageReady || appearanceWriting;
  return `<section class="appearance-panel" aria-labelledby="appearance-title"><div class="appearance-header"><div><div class="eyebrow">换一种心情</div><h2 id="appearance-title">外观与皮肤</h2></div><span class="pill ${previewing ? 'previewing' : ''}">${previewing ? '预览中' : '已应用'}</span></div><div class="theme-grid">${THEMES.map(theme => `<button class="theme-option ${value.theme === theme.id ? 'active' : ''}" data-action="preview-theme" data-theme-id="${theme.id}" aria-pressed="${value.theme === theme.id}"><span class="theme-preview" data-theme-preview="${theme.id}" aria-hidden="true"><i></i><b></b><em></em></span><span class="theme-option-copy"><strong>${theme.label}</strong><small>${theme.description}</small></span></button>`).join('')}</div><div class="wallpaper-row"><div class="wallpaper-preview ${value.wallpaper ? 'has-image' : ''}" data-wallpaper-preview role="img" aria-label="当前壁纸预览"><span>${value.wallpaper ? '自定义壁纸' : '尚未选择图片'}</span></div><div class="wallpaper-copy"><strong>我的图片</strong><p>${value.wallpaper ? esc(value.wallpaper.name) : '选择一张图片作为页面背景'}</p><div class="wallpaper-actions"><label class="button secondary wallpaper-picker">选择图片<input id="wallpaper-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" ${disabled ? 'disabled' : ''}></label><button class="text-button" data-action="remove-wallpaper" ${disabled || !value.wallpaper ? 'disabled' : ''}>移除图片</button></div></div></div><div class="appearance-actions"><button class="text-button" data-action="cancel-appearance-preview" ${!previewing ? 'disabled' : ''}>取消预览</button><button class="text-button" data-action="reset-appearance" ${disabled ? 'disabled' : ''}>恢复默认</button><button class="button primary" data-action="apply-appearance" ${disabled || !previewing ? 'disabled' : ''}>应用当前预览</button></div></section>`;
}
function legacySourceSummary(source) {
  return `${source.state.cards.length} 张卡片 · ${source.state.entries.length} 条记录 · ${source.state.journal.length} 条随手记${source.appearance.wallpaper ? ' · 含壁纸' : ''}`;
}
function migrationHTML() {
  const selected = migration.source || legacySources[0] || null;
  const preview = migration.preview;
  const disabled = !storageReady || migration.busy;
  return `<section class="settings-panel migration-panel"><div class="setting-row"><div class="setting-copy"><h3>迁入浏览器旧存档</h3><p>当前页面只能读取自己的旧 localStorage。先预览合并结果，再写入本机 SQLite；原来源不会被删除。</p></div><span class="pill">${legacySources.length ? `${legacySources.length} 个来源` : '未发现来源'}</span></div>${legacySources.length ? `<div class="migration-sources">${legacySources.map((source, index) => `<div class="migration-source ${selected?.sourceKey === source.sourceKey ? 'selected' : ''}"><div><strong>旧存档 ${index + 1}</strong><span>${legacySourceSummary(source)}</span></div><button class="text-button" data-action="select-migration-source" data-source-key="${esc(source.sourceKey)}" ${disabled ? 'disabled' : ''}>${selected?.sourceKey === source.sourceKey ? '已选择' : '选择并预览'}</button></div>`).join('')}</div><div class="migration-actions"><button class="button secondary" data-action="preview-migration" ${disabled ? 'disabled' : ''}>${migration.busy ? '正在读取…' : '预览合并结果'}</button></div>${migration.error ? `<p class="error-text">${esc(migration.error)}</p>` : ''}${preview ? `<div class="migration-preview"><strong>合并预览</strong><p>当前存档：${preview.current.cards} 张卡片、${preview.current.entries} 条记录、${preview.current.journal} 条随手记；来源：${preview.source.cards} 张卡片、${preview.source.entries} 条记录、${preview.source.journal} 条随手记；结果：${preview.result.cards} 张卡片、${preview.result.entries} 条记录、${preview.result.journal} 条随手记。</p><p>${preview.conflicts.length ? `发现 ${preview.conflicts.length} 项同 ID 或外观冲突，请选择处理方式。` : '没有发现同 ID 冲突。'}</p><div class="migration-actions"><button class="button secondary" data-action="apply-migration" data-mode="merge" ${disabled ? 'disabled' : ''}>合并迁入</button><button class="text-button" data-action="apply-migration" data-mode="source" ${disabled ? 'disabled' : ''}>以来源为准</button><button class="text-button" data-action="apply-migration" data-mode="current" ${disabled ? 'disabled' : ''}>保留当前</button></div></div>` : ''}` : '<p class="field-hint">没有在当前浏览器发现旧存档。请在持有旧记录的浏览器中打开本页执行迁移；浏览器之间不能直接互读 localStorage。</p>'}</section>`;
}
function settingsHTML() {
  const status = storageLoading ? '连接中' : storageReady ? '已连接' : '未连接';
  const disabled = readonly || !storageReady;
  return `${heading('按你的习惯来', '一点小设置', '让每一次点击，都刚刚好。')}${appearanceHTML()}<section class="settings-panel"><div class="setting-row"><div class="setting-copy"><h3>点击音效</h3><p>保存成功后，播放一声短促的提示音。</p></div><label class="toggle"><input type="checkbox" data-setting="sound" aria-label="点击音效" ${state.settings.sound ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span></span></label></div><div class="setting-row"><div class="setting-copy"><h3>反馈力度</h3><p>轻快收敛模式减少弹跳和粒子。</p></div><select aria-label="反馈力度" data-setting="strength" ${disabled ? 'disabled' : ''}><option value="crisp" ${state.settings.strength === 'crisp' ? 'selected' : ''}>清脆弹跳</option><option value="soft" ${state.settings.strength === 'soft' ? 'selected' : ''}>轻快收敛</option></select></div><div class="setting-row"><div class="setting-copy"><h3>提醒方式</h3><p>本版在页面内显示进度与到期状态。关闭页面后不会发送系统通知。</p></div><span class="pill">页面内提醒</span></div><div class="setting-row"><div class="setting-copy"><h3>正式存档空间</h3><p>${esc(store?.space?.label || storageSpace.label)} · ${esc(serviceOrigin)}</p></div><span class="pill">${status}</span></div></section>${migrationHTML()}`;
}
function render() {
  const topRecordButton = document.querySelector('.topbar [data-action="new-card"]');
  if (topRecordButton) topRecordButton.disabled = !storageReady;
  if (!state) {
    syncAppearance();
    document.body.dataset.strength = 'soft';
    $('#navigation').innerHTML = pages.map(([view, text, glyph]) => `<a href="#${view}" class="nav-item disabled" aria-disabled="true" tabindex="-1">${icon(glyph)}<span>${text}</span></a>`).join('');
    $('#page-label').textContent = '本机存档'; $('.menu-toggle').innerHTML = icon('menu');
    $('#view').innerHTML = `${heading('Life Save 本机存档', storageLoading ? '正在连接本机存储' : '本机存储暂不可用', storageLoading ? '正在读取正式存档，页面不会创建默认空记录。' : '记录服务没有返回正式存档，已有输入不会被覆盖。')}<section class="settings-panel storage-unavailable"><div class="setting-row"><div class="setting-copy"><h3>${storageLoading ? '请稍候' : '需要启动本机服务'}</h3><p>${storageLoading ? '页面正在连接 SQLite 服务。' : esc(storageError || '请启动 Life Save SQLite service 后重新连接。')}</p></div><span class="pill">${storageSpace.isTest ? '测试存档' : '正式存档'}</span></div>${storageLoading ? '' : '<button class="button primary" data-action="retry-storage">重新连接</button>'}</section>`;
    return;
  }
  const focused = document.activeElement, focusData = focused?.dataset?.action ? { ...focused.dataset } : null;
  document.querySelectorAll('.calendar-scroll').forEach(el => calendarScrolls.set(el.closest('.calendar-panel').dataset.scrollKey, el.scrollLeft));
  syncAppearance();
  document.body.dataset.strength = state.settings.strength;
  $('#navigation').innerHTML = pages.map(([view, text, glyph]) => `<a href="#${view}" class="nav-item ${ui.page === view ? 'active' : ''}" ${ui.page === view ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${text}</span>${view === 'cards' ? `<small>${state.cards.length}</small>` : ''}</a>`).join('');
  $('#page-label').textContent = pages.find(p => p[0] === ui.page)?.[1] || '首页'; $('.menu-toggle').innerHTML = icon('menu');
  if (ui.page === 'home') $('#view').innerHTML = renderHome();
  if (ui.page === 'cards') $('#view').innerHTML = `${heading('随你的生活而生', '我的生活卡片', '上次什么时候，下次还有多久，一眼就知道。')}<div class="cards-grid">${state.cards.map(cardHTML).join('')}</div>`;
  if (ui.page === 'scenes') $('#view').innerHTML = `${heading('一件件确认，就不用再猜', '场景清单', '出门、照顾猫咪……把一起做的事情放在一起。')}<div class="scenes-grid">${state.scenes.map(sceneHTML).join('')}</div><p class="page-footnote">这里保存的是你当时的确认记录，不会自动检测门锁或电器状态。</p>`;
  if (ui.page === 'calendar') {
    const scope = calendarScope();
    $('#view').innerHTML = `${heading('一点一点，留下生活的痕迹', '记录日历', '总览看积累，分类看小事。点开一天，把细节找回来。')}
      <div class="category-tabs" aria-label="日历分类">${calendarGroups().map(g => `<button class="filter-chip ${ui.filter === g.id ? 'active' : ''}" data-action="calendar-scope" data-scope="${esc(g.id)}" aria-pressed="${ui.filter === g.id}">${esc(g.title)}</button>`).join('')}</div>
      ${calendarHTML(scope.entries, scope.title, scope.cards)}`;
  }
  if (ui.page === 'feed') $('#view').innerHTML = feedHTML();
  if (ui.page === 'settings') $('#view').innerHTML = settingsHTML();
  if ($('#details').open && ui.detailId) renderDetails();
  if (ui.page === 'feed' && ui.feedFocusId) {
    const focusId = ui.feedFocusId;
    const target = document.querySelector(`[data-feed-id="${CSS.escape(focusId)}"]`);
    if (target) {
      ui.feedFocusId = null;
      requestAnimationFrame(() => { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.focus({ preventScroll: true }); });
    }
  }
  document.querySelectorAll('.calendar-scroll').forEach(el => {
    const panel = el.closest('.calendar-panel');
    const key = panel.dataset.scrollKey;
    el.scrollLeft = calendarScrolls.get(key) ?? (panel.classList.contains('category-calendar') ? el.scrollWidth : 0);
  });
  if (focusData && !$('#editor').open && !$('#composer').open) {
    const qualifiers = ['id', 'day', 'scope', 'filter'].filter(key => focusData[key]).map(key => `[data-${key}="${CSS.escape(focusData[key])}"]`).join('');
    const selector = `[data-action="${CSS.escape(focusData.action)}"]${qualifiers}`;
    ($('#details').open ? $('#details') : $('#view')).querySelector(selector)?.focus({ preventScroll: true });
  }
}
async function change(action, payload, message, undoId, entryId, requestId) {
  if (readonly || !storageReady || writing) return false;
  writing = true;
  try {
    acceptSnapshot(await store.dispatch(action, payload, requestId));
    clearError(); render(); if (message) toast(message, undoId, entryId); return true;
  } catch (error) {
    if (error.current) acceptSnapshot(error.current);
    showError(`这次没有保存成功。原记录仍然保留，可重试。${error.message}`);
    render();
    return false;
  }
  finally { writing = false; }
}
function playFeedback(cardId) {
  const button = $(`[data-action="record"][data-id="${CSS.escape(cardId)}"]`);
  if (button && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    button.classList.add('is-celebrating');
    if (state.settings.strength === 'crisp') for (let i = 0; i < 8; i++) {
      const spark = document.createElement('span'); spark.className = 'spark'; spark.setAttribute('aria-hidden', 'true');
      spark.style.setProperty('--x', `${Math.cos(i * Math.PI / 4) * 70}px`); spark.style.setProperty('--y', `${Math.sin(i * Math.PI / 4) * 45 - 25}px`); button.append(spark);
    }
  }
  if (state.settings.sound) {
    try {
      audioContext ||= new AudioContext();
      audioContext.resume().then(() => {
        const osc = audioContext.createOscillator(), gain = audioContext.createGain(), start = audioContext.currentTime;
        osc.frequency.setValueAtTime(740, start); osc.frequency.setValueAtTime(1046, start + .05);
        gain.gain.setValueAtTime(.035, start); gain.gain.exponentialRampToValueAtTime(.0001, start + .15);
        osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(start + .16); osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      }).catch(() => toast('记录已保存，当前浏览器无法播放音效。'));
    } catch { toast('记录已保存，当前浏览器无法播放音效。'); }
  }
}
function openEditor(id = null, sceneId = '') {
  const card = state.cards.find(c => c.id === id), kind = card?.kind || (sceneId ? 'confirm' : 'record');
  const requestId = crypto.randomUUID();
  const reminder = card?.reminder || { type: 'none' };
  let unit = '60', amount = 24;
  if (reminder.type === 'interval') { unit = reminder.minutes % 1440 === 0 ? '1440' : reminder.minutes % 60 === 0 ? '60' : '1'; amount = reminder.minutes / Number(unit); }
  $('#editor').innerHTML = `<div class="dialog-header"><div><div class="eyebrow">一点小设置</div><h2 id="editor-title">${card ? '编辑卡片' : '添一件生活小事'}</h2></div><button class="icon-button" data-action="close-editor" aria-label="关闭卡片设置">×</button></div><form class="dialog-form" id="card-form" data-id="${esc(id || '')}" data-request-id="${requestId}">
    <div class="field"><label for="card-title">叫什么名字？</label><input id="card-title" name="title" maxlength="40" required placeholder="例如：浇花、猫咪晚饭" value="${esc(card?.title || '')}" autofocus></div>
    <div class="field-grid"><div class="field"><label for="card-kind">卡片用途</label><select id="card-kind" name="kind" ${card ? 'disabled' : ''}><option value="record" ${kind === 'record' ? 'selected' : ''}>随手记录时间</option><option value="confirm" ${kind === 'confirm' ? 'selected' : ''}>一键确认完成</option></select></div><div class="field"><label for="card-icon">小图标</label><select id="card-icon" name="icon">${[['sparkles', '✦ 生活小事'], ['pill', '药品'], ['bed', '家务'], ['lock', '门锁'], ['plug', '电器'], ['cat', '猫咪'], ['clock', '时间']].map(([value, title]) => `<option value="${value}" ${value === (card?.icon || 'sparkles') ? 'selected' : ''}>${title}</option>`).join('')}</select></div></div>
    <div class="field" id="scene-field"><label for="card-scene">放在哪个场景？</label><select id="card-scene" name="scene"><option value="">独立卡片 · 每天确认一次</option>${state.scenes.map(s => `<option value="${esc(s.id)}" ${(card?.sceneId || sceneId) === s.id ? 'selected' : ''}>${s.title} · ${s.mode === 'manual' ? '手动开启新一轮' : '每天确认一次'}</option>`).join('')}</select><p class="field-hint">确认按所选场景归属；提醒到期不会自动清除本轮确认。</p></div>
    <div class="field"><label for="reminder-type">下次什么时候提醒？</label><select id="reminder-type" name="reminder"><option value="none" ${reminder.type === 'none' ? 'selected' : ''}>不用提醒，随时记</option><option value="interval" ${reminder.type === 'interval' ? 'selected' : ''}>从上次完成后，间隔一段时间</option><option value="daily" ${reminder.type === 'daily' ? 'selected' : ''}>每天固定时间</option></select></div>
    <div id="interval-fields" class="field"><label for="interval-amount">间隔多久？</label><div class="field-grid"><input type="number" id="interval-amount" name="amount" min="1" max="5256000" step="1" value="${amount}" aria-label="间隔数值"><select name="unit" aria-label="间隔单位"><option value="1" ${unit === '1' ? 'selected' : ''}>分钟</option><option value="60" ${unit === '60' ? 'selected' : ''}>小时</option><option value="1440" ${unit === '1440' ? 'selected' : ''}>天</option></select></div><p class="field-hint">以上次实际记录为起点。没有记录时，记下第一次才开始计时。</p></div>
    <div id="daily-fields" class="field"><label for="daily-time">每天的期望时间</label><input type="time" id="daily-time" name="time" value="${reminder.time || '09:00'}"><p class="field-hint">今天完成后，下一次仍是明天这个时间。</p></div>
    <p class="field-hint">本版提醒显示在页面内，关闭页面后不发送通知。修改规则会重新计算下一次时间。</p><p class="error-text" id="form-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="button secondary" data-action="close-editor">取消</button><button class="button primary" type="submit" ${readonly ? 'disabled' : ''}>${card ? '保存设置' : '创建卡片'}</button></div></form>`;
  updateEditorFields(); $('#editor').showModal();
}
function updateEditorFields() {
  $('#scene-field').hidden = $('#card-kind').value !== 'confirm';
  const type = $('#reminder-type').value;
  $('#interval-fields').hidden = type !== 'interval'; $('#daily-fields').hidden = type !== 'daily';
  $('#interval-amount').required = type === 'interval'; $('#interval-amount').disabled = type !== 'interval';
  $('#daily-time').required = type === 'daily'; $('#daily-time').disabled = type !== 'daily';
}
function renderDetails() {
  const card = state.cards.find(c => c.id === ui.detailId); if (!card) return;
  const entries = cardEntries(state, card.id);
  $('#details').innerHTML = `<div class="dialog-header"><div><div class="eyebrow">${card.kind === 'confirm' ? '每一次确认，都有迹可循' : '记下的小事，都在这里'}</div><h2 id="details-title">${esc(card.title)}</h2></div><button class="icon-button" data-action="close-detail" aria-label="关闭记录详情">×</button></div><div class="detail-body">${reminderHTML(card, entries)}${calendarHTML(entries, '记录次数')}<div class="form-actions"><button class="button secondary" data-action="edit-from-detail" data-id="${esc(card.id)}">卡片设置</button>${entries.length ? `<button class="text-button" data-action="undo" data-id="${esc(card.id)}" ${readonly ? 'disabled' : ''}>撤销最近一次</button>` : ''}</div></div>`;
}
function closeMenu() { document.body.classList.remove('nav-open'); syncMenu(); }
function syncMenu() {
  const desktop = matchMedia('(min-width: 1000px)').matches;
  const open = desktop ? !document.body.classList.contains('nav-collapsed') : document.body.classList.contains('nav-open');
  $('.menu-toggle').setAttribute('aria-expanded', String(open)); $('.menu-toggle').setAttribute('aria-label', open ? '收起功能菜单' : '展开功能菜单');
  $('#sidebar').inert = !open;
}
function navigate(page) { if (location.hash !== `#${page}`) location.hash = page; else render(); closeMenu(); }
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (action === 'retry-storage') { await bootstrapStorage(); return; }
  if (!state) return;
  if (action === 'draw-memory') { drawMemoryFromHistory(); return; }
  if (action === 'open-memory') { openMemory(button.dataset.memoryType, button.dataset.memoryId); return; }
  if (action === 'toggle-menu') { document.body.classList.toggle(matchMedia('(min-width: 1000px)').matches ? 'nav-collapsed' : 'nav-open'); syncMenu(); }
  if (action === 'close-menu') { closeMenu(); $('.menu-toggle').focus(); }
  if (action === 'navigate') navigate(button.dataset.view);
  if (action === 'new-card') openEditor(null, button.dataset.scene || '');
  if (action === 'edit-card') openEditor(id);
  if (action === 'close-editor') $('#editor').close();
  if (action === 'close-detail') $('#details').close();
  if (action === 'edit-from-detail') { $('#details').close(); openEditor(id); }
  if (action === 'record') {
    if ((cooldowns.get(id) || 0) > Date.now()) return;
    const card = state.cards.find(c => c.id === id); if (confirmationEntry(state, card, new Date())) return;
    cooldowns.set(id, Date.now() + 900);
    const entryId = pendingRecordIds.get(id) || crypto.randomUUID();
    const success = await change('record', { cardId: id, entryId, at: new Date().toISOString() }, card.kind === 'confirm' ? `${card.title}，确认已保存` : `${card.title}，记住啦！`, id, entryId);
    if (success) { pendingRecordIds.delete(id); ui.calendarPage = 0; ui.selectedDay = localDayKey(new Date()); playFeedback(id); }
    else pendingRecordIds.set(id, entryId);
    setTimeout(() => { cooldowns.delete(id); render(); }, 900);
  }
  if (action === 'note') openComposer('entry', id);
  if (action === 'new-journal') openComposer('journal');
  if (action === 'delete-journal') {
    if (!window.confirm('确定删除这条随手记吗？删除后无法恢复。')) return;
    await change('delete_journal', { id, expectedUpdatedAt: button.dataset.updatedAt, at: new Date().toISOString() }, '随手记已删除。', null, null, crypto.randomUUID());
  }
  if (action === 'close-composer') $('#composer').close();
  if (action === 'preview-theme') {
    const theme = THEMES.find(item => item.id === button.dataset.themeId);
    if (theme) previewAppearance({ ...currentAppearance(), theme: theme.id });
  }
  if (action === 'apply-appearance') await applyAppearance(currentAppearance(), '外观已应用。');
  if (action === 'cancel-appearance-preview') cancelAppearancePreview();
  if (action === 'reset-appearance') await applyAppearance(createDefaultAppearance(), '已恢复默认皮肤。');
  if (action === 'remove-wallpaper') previewAppearance({ ...currentAppearance(), wallpaper: null });
  if (action === 'select-migration-source') {
    migration.source = legacySources.find(source => source.sourceKey === button.dataset.sourceKey) || null;
    migration.preview = null; migration.error = ''; render();
  }
  if (action === 'preview-migration') {
    const source = migration.source || legacySources[0];
    if (!source) return;
    migration.source = source; migration.busy = true; migration.error = ''; render();
    try { migration.preview = await store.previewMigration(source); }
    catch (error) { migration.preview = null; migration.error = error.message; }
    finally { migration.busy = false; render(); }
  }
  if (action === 'apply-migration') {
    const source = migration.source || legacySources[0];
    if (!source) return;
    migration.busy = true; migration.error = ''; render();
    try {
      acceptSnapshot(await store.applyMigration(source, button.dataset.mode));
      migration.preview = null; clearError(); toast('旧存档已迁入本机正式存档。');
    } catch (error) {
      if (error.current) acceptSnapshot(error.current);
      migration.error = error.message;
    } finally { migration.busy = false; render(); }
  }
  if (action === 'feed-filter') { ui.feedFilter = button.dataset.filter; ui.feedLimit = 40; render(); }
  if (action === 'feed-more') { ui.feedLimit += 40; render(); }
  if (action === 'category-calendar' || action === 'calendar-scope') {
    ui.filter = action === 'category-calendar' ? `scene:${id}` : button.dataset.scope;
    ui.calendarPage = 0; ui.selectedDay = null; ui.detailAll = false; navigate('calendar');
  }
  if (action === 'undo') {
    const card = state.cards.find(c => c.id === id), latest = card && cardEntries(state, card.id)[0];
    if (latest) await change('undo_entry', { cardId: id, entryId: latest.id }, '已撤销最近一次，其他记录仍然保留。');
  }
  if (action === 'new-round') await change('start_round', { sceneId: id, roundId: crypto.randomUUID(), at: new Date().toISOString() }, '新一次出门已开始，上一次的确认记录仍在。');
  if (action === 'detail') { ui.detailId = id; ui.calendarPage = 0; ui.selectedDay = null; ui.detailAll = false; renderDetails(); $('#details').showModal(); }
  if (action === 'calendar-prev' || action === 'calendar-next') { ui.calendarPage = Math.max(0, ui.calendarPage + (action === 'calendar-prev' ? 1 : -1)); ui.selectedDay = null; ui.detailAll = false; render(); }
  if (action === 'calendar-day') { ui.selectedDay = button.dataset.day; ui.detailAll = false; render(); }
  if (action === 'all-history') { ui.detailAll = !ui.detailAll; render(); }
});
document.addEventListener('change', async event => {
  if (['card-kind', 'reminder-type'].includes(event.target.id)) updateEditorFields();
  if (event.target.id === 'wallpaper-file') {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try { previewAppearance({ ...currentAppearance(), wallpaper: await prepareWallpaper(file) }); toast('图片已加入预览，应用后才会保存。'); }
    catch (error) { showError(`图片没有加入预览。${error.message}`); }
    return;
  }
  if (event.target.dataset.setting) {
    const name = event.target.dataset.setting, value = name === 'sound' ? event.target.checked : event.target.value;
    await change('update_setting', { name, value }, '设置已保存');
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'text-form') { event.preventDefault(); await submitComposer(event.target); return; }
  if (event.target.id !== 'card-form') return;
  event.preventDefault(); const form = event.target, data = new FormData(form), id = form.dataset.id, requestId = form.dataset.requestId;
  const old = state.cards.find(c => c.id === id), kind = old?.kind || data.get('kind'), title = data.get('title').trim();
  const reminder = { type: data.get('reminder') };
  if (reminder.type === 'interval') reminder.minutes = Number(data.get('amount')) * Number(data.get('unit'));
  if (reminder.type === 'daily') reminder.time = data.get('time');
  if (!title || (reminder.type === 'interval' && (!Number.isFinite(reminder.minutes) || reminder.minutes < 1 || reminder.minutes > 5256000))) {
    $('#form-error').textContent = !title ? '给这张卡片起个名字吧。' : '间隔需要在 1 分钟至 10 年内。'; $('#form-error').hidden = false; return;
  }
  const card = { id: old?.id || crypto.randomUUID(), title, icon: data.get('icon'), tone: old?.tone || ['mint', 'blue', 'peach', 'lilac'][state.cards.length % 4], kind, sceneId: kind === 'confirm' ? data.get('scene') || null : null, reminder, createdAt: old?.createdAt || new Date().toISOString() };
  const success = await change('upsert_card', { card, expectedCard: old || null }, old ? '卡片设置已保存' : '新卡片准备好了', null, null, requestId);
  if (success) { $('#editor').close(); if (!old) navigate(card.sceneId ? 'scenes' : 'cards'); }
  else { $('#form-error').textContent = $('#error-banner').textContent; $('#form-error').hidden = false; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('nav-open')) { closeMenu(); $('.menu-toggle').focus(); } });
window.addEventListener('hashchange', () => { ui.page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'home'; ui.calendarPage = 0; ui.selectedDay = null; ui.detailAll = false; closeMenu(); render(); window.scrollTo({ top: 0 }); });
window.addEventListener('resize', syncMenu);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void reloadStorage(); } });
setInterval(() => { if (!document.hidden) void reloadStorage({ silent: true }); }, 5000);
ui.page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'home';
render(); syncMenu(); if (appearanceError) showError(appearanceError); void bootstrapStorage();
