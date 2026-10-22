import { createInitialState, localDayKey, cardEntries, confirmationEntry, addEntry, undoEntry, startRound, reminderInfo, calendarModel } from './model.js';
import { createStore } from './store.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
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
  arrow: '<path d="m9 5 7 7-7 7"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sparkles}</svg>`;
const pages = [['home', '首页', 'home'], ['scenes', '场景清单', 'scenes'], ['cards', '全部卡片', 'cards'], ['calendar', '记录日历', 'calendar'], ['settings', '设置', 'settings']];
const ui = { page: 'home', filter: 'all', calendarPage: 0, selectedDay: null, detailId: null, detailAll: false };
let store, state, readonly = false, toastTimer, audioContext, writing = false;
const cooldowns = new Map();
try { store = createStore(localStorage, location.pathname, location.search); state = store.state; }
catch (error) { state = createInitialState(); readonly = true; showError(`无法读取或保存本地记录，原数据未覆盖，已暂停写入。${error.message}`); }
function showError(text) { $('#error-banner').textContent = text; $('#error-banner').hidden = false; }
function toast(text, undoId = null) {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = `${icon('check')}<span>${esc(text)}</span>${undoId ? `<button data-action="undo" data-id="${esc(undoId)}">撤销</button>` : ''}`;
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
  return `<article class="life-card" data-tone="${esc(card.tone)}"><div class="card-top"><span class="card-icon">${icon(card.icon)}</span><div class="card-heading"><h3>${esc(card.title)}</h3><span class="tag">${confirm ? '完成确认' : '随手记录'}${card.reminder.type !== 'none' ? ` · ${esc(ruleLabel(card))}` : ''}</span></div><button class="icon-button card-menu" data-action="edit-card" data-id="${esc(card.id)}" aria-label="设置${esc(card.title)}">${icon('edit')}</button></div><div class="card-stat"><div class="caption">${caption}</div><div class="value ${confirmed ? 'confirmed-value' : ''}">${confirm ? confirmed ? '确认过了' : '还待确认' : latest ? elapsed(latest.at) : '还没有记录'}</div><div class="meta">${confirmed ? `你在 ${shortDate(confirmed.at)} ${timeOnly(confirmed.at)} 亲手确认过` : confirm ? '做完后点一下，给自己一个凭据' : latest ? fullTime(latest.at) : '下一次想知道，打开就看得见'}</div></div>${reminderHTML(card, entries)}<div class="card-actions"><button class="record-button ${confirmed ? 'is-done' : ''}" data-action="record" data-id="${esc(card.id)}" aria-label="${esc(card.title)}：${label}" ${readonly || confirmed || cooling ? 'disabled' : ''}>${icon(confirmed || confirm ? 'check' : 'sparkles')}<span>${cooling ? '记住啦！' : label}</span></button></div><div class="card-foot"><button class="text-button" data-action="detail" data-id="${esc(card.id)}">${icon('calendar')}记录日历${entries.length ? ` · ${entries.length}` : ''}</button>${latest ? `<button class="text-button" data-action="undo" data-id="${esc(card.id)}" ${readonly ? 'disabled' : ''}>撤销最近一次</button>` : ''}</div></article>`;
}
function sceneHTML(scene) {
  const cards = state.cards.filter(c => c.sceneId === scene.id), done = cards.filter(c => confirmationEntry(state, c, new Date())).length;
  return `<section class="scene-card"><div class="scene-header"><span class="scene-icon" data-tone="${scene.id === 'cats' ? 'peach' : 'mint'}">${icon(scene.id === 'cats' ? 'cat' : 'lock')}</span><div class="scene-title"><h3>${esc(scene.title)}</h3><p class="scene-summary">${scene.mode === 'daily' ? `${shortDate(new Date())} · 今天` : `本次始于 ${shortDate(scene.startedAt)} ${timeOnly(scene.startedAt)}`} · ${done}/${cards.length} 已确认</p></div><span class="pill ${done && done === cards.length ? 'complete' : ''}">${done && done === cards.length ? '本轮已完成' : '逐项确认'}</span></div><div class="scene-list">${cards.map(card => {
    const e = confirmationEntry(state, card, new Date()), r = reminderInfo(card, cardEntries(state, card.id), new Date());
    const hint = e ? `你在 ${shortDate(e.at)} ${timeOnly(e.at)} 确认过` : r.status === 'off' ? '本轮还未确认' : r.status === 'due' ? `期望 ${card.reminder.type === 'daily' ? card.reminder.time : timeOnly(r.dueAt)} · 待确认` : r.status === 'upcoming' ? `还有 ${duration(r.remainingMs)}` : '确认后开始计算间隔';
    return `<div class="scene-row ${e ? 'confirmed' : ''}"><span class="check-symbol">${icon(e ? 'check' : card.icon)}</span><div class="scene-item-text"><strong>${esc(card.title)}</strong><span class="confirmation-time">${hint}</span></div>${e ? `<button class="text-button" data-action="detail" data-id="${esc(card.id)}" aria-label="查看${esc(card.title)}的确认记录">查看</button>` : `<button class="confirm-button" data-action="record" data-id="${esc(card.id)}" aria-label="确认${esc(card.title)}" ${readonly ? 'disabled' : ''}>确认</button>`}</div>`;
  }).join('')}</div><div class="scene-footer">${scene.mode === 'manual' ? `<button class="text-button" data-action="new-round" data-id="${esc(scene.id)}" ${readonly ? 'disabled' : ''}>＋ 开始新一次出门</button>` : '<span class="subtle">每天开启新一轮 · 历史一直保留</span>'}<button class="text-button" data-action="new-card" data-scene="${esc(scene.id)}">添加事项 ${icon('arrow')}</button></div></section>`;
}
const heading = (eyebrow, title, lead) => `<div class="page-head"><div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1><p class="lead">${lead}</p></div>`;
function renderHome() {
  const now = new Date(), pending = state.cards.filter(c => c.kind === 'confirm' && !confirmationEntry(state, c, now)).length;
  const due = state.cards.filter(c => reminderInfo(c, cardEntries(state, c.id), now).status === 'due' && !confirmationEntry(state, c, now)).length;
  return `${heading(new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now), '让小事，有个着落。', '随手记下，轻轻确认。剩下的时间，留给生活。')}<div class="overview-strip"><div class="overview-item">${icon('scenes')}<strong>${pending}</strong><span>件事待确认</span></div><div class="overview-item">${icon('clock')}<strong>${due}</strong><span>项提醒已到时间</span></div><div class="overview-item">${icon('check')}<span>每一条记录，都有时间可查</span></div></div><div class="section-heading"><h2>随手记一下</h2><button class="text-button" data-action="navigate" data-view="cards">全部卡片 ${icon('arrow')}</button></div><div class="cards-grid">${state.cards.filter(c => !c.sceneId).map(cardHTML).join('')}</div><div class="section-heading"><h2>确认过，就安心了</h2><span class="subtle">给刚刚做过的事，留一个凭据</span></div><div class="scenes-grid">${state.scenes.map(sceneHTML).join('')}</div>`;
}
function calendarHTML(entries, title = '') {
  const model = calendarModel(entries, new Date(), ui.calendarPage), last = ui.calendarPage ? localDayKey(model.end) : model.todayKey;
  if (!ui.selectedDay || ui.selectedDay < localDayKey(model.start) || ui.selectedDay > last) ui.selectedDay = last;
  const months = [];
  model.days.forEach((d, i) => {
    if (i % 7) return; const week = i / 7;
    if (week === 0 ? d.date.getMonth() !== model.days[7].date.getMonth() : d.date.getMonth() === model.days[i - 7].date.getMonth()) return;
    months.push(`<span style="grid-column:${week + 2}/span ${Math.min(2, 12 - week)}">${d.date.getMonth() + 1}月</span>`);
  });
  const selected = ui.detailAll ? entries : model.buckets.get(ui.selectedDay) || [];
  return `<section class="calendar-panel" aria-label="按天查看记录日历"><div class="calendar-toolbar"><div><strong>${esc(title || '记录日历')}</strong><div class="meta">${ui.calendarPage ? '' : '近 '}12 周 · ${model.activeDays} 天有记录</div></div><div class="calendar-controls"><button class="icon-button" data-action="calendar-prev" aria-label="查看前12周">‹</button><button class="icon-button" data-action="calendar-next" aria-label="查看后12周" ${ui.calendarPage === 0 ? 'disabled' : ''}>›</button></div></div><div class="calendar-range">${localDayKey(model.start).replace(/-/g, '/')} — ${last.replace(/-/g, '/')}</div><div class="calendar-scroll"><div class="calendar-chart"><div class="calendar-months" aria-hidden="true">${months.join('')}</div><div class="calendar-grid" role="group" aria-label="每天一个方格，按周排列">${['日', '一', '二', '三', '四', '五', '六'].map((d, i) => `<span class="weekday" aria-hidden="true" style="grid-column:1;grid-row:${i + 1}">${d}</span>`).join('')}${model.days.map((d, i) => d.future ? `<span class="calendar-day future" aria-hidden="true" style="grid-column:${Math.floor(i / 7) + 2};grid-row:${i % 7 + 1}"></span>` : `<button class="calendar-day ${d.count ? 'filled' : ''} ${d.key === model.todayKey ? 'today' : ''} ${d.key === ui.selectedDay && !ui.detailAll ? 'selected' : ''}" style="grid-column:${Math.floor(i / 7) + 2};grid-row:${i % 7 + 1}" data-action="calendar-day" data-day="${d.key}" aria-label="${d.key}，${d.count} 条记录" aria-pressed="${d.key === ui.selectedDay && !ui.detailAll}" ${d.key === model.todayKey ? 'aria-current="date"' : ''} title="${d.key} · ${d.count} 条记录"></button>`).join('')}</div></div></div><div class="calendar-legend"><span class="legend-dot"></span>未记录 <span class="legend-dot filled"></span>有记录</div><div class="section-heading day-heading"><h3>${ui.detailAll ? '全部记录' : ui.selectedDay.replace(/-/g, '/')}${ui.selectedDay === model.todayKey && !ui.detailAll ? ' · 今天' : ''}<span class="subtle"> · ${selected.length} 条</span></h3><button class="text-button" data-action="all-history">${ui.detailAll ? '返回按天查看' : '全部记录'}</button></div><ul class="history-list">${selected.length ? selected.map(e => { const c = state.cards.find(c => c.id === e.cardId); return `<li class="history-item"><span class="history-icon">${icon(c.icon)}</span><div class="history-label"><strong>${esc(c.title)}</strong><span class="meta">${c.kind === 'confirm' ? '你已确认完成' : '已记录'}</span></div><time datetime="${esc(e.at)}">${ui.detailAll ? fullTime(e.at) : preciseTime(e.at)}</time></li>`; }).join('') : '<li class="empty-state compact">这一天没有记录。<span>有需要的时候，再来记一下。</span></li>'}</ul></section>`;
}
function settingsHTML() {
  return `${heading('按你的习惯来', '一点小设置', '让每一次点击，都刚刚好。')}<section class="settings-panel"><div class="setting-row"><div class="setting-copy"><h3>点击音效</h3><p>保存成功后，播放一声短促的提示音。</p></div><label class="toggle"><input type="checkbox" data-setting="sound" aria-label="点击音效" ${state.settings.sound ? 'checked' : ''} ${readonly ? 'disabled' : ''}><span></span></label></div><div class="setting-row"><div class="setting-copy"><h3>反馈力度</h3><p>轻快收敛模式减少弹跳和粒子。</p></div><select aria-label="反馈力度" data-setting="strength" ${readonly ? 'disabled' : ''}><option value="crisp" ${state.settings.strength === 'crisp' ? 'selected' : ''}>清脆弹跳</option><option value="soft" ${state.settings.strength === 'soft' ? 'selected' : ''}>轻快收敛</option></select></div><div class="setting-row"><div class="setting-copy"><h3>提醒方式</h3><p>本版在页面内显示进度与到期状态。关闭页面后不会发送系统通知。</p></div><span class="pill">页面内提醒</span></div><div class="setting-row"><div class="setting-copy"><h3>记录在这台设备上</h3><p>刷新后仍然保留。清除浏览器数据或更换浏览器后不会同步。</p></div><span class="pill">本地保存</span></div></section>`;
}
function render() {
  const focused = document.activeElement, focusData = focused?.dataset?.action ? { ...focused.dataset } : null;
  document.body.dataset.strength = state.settings.strength;
  $('#navigation').innerHTML = pages.map(([view, text, glyph]) => `<a href="#${view}" class="nav-item ${ui.page === view ? 'active' : ''}" ${ui.page === view ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${text}</span>${view === 'cards' ? `<small>${state.cards.length}</small>` : ''}</a>`).join('');
  $('#page-label').textContent = pages.find(p => p[0] === ui.page)?.[1] || '首页'; $('.menu-toggle').innerHTML = icon('menu');
  if (ui.page === 'home') $('#view').innerHTML = renderHome();
  if (ui.page === 'cards') $('#view').innerHTML = `${heading('随你的生活而生', '我的生活卡片', '上次什么时候，下次还有多久，一眼就知道。')}<div class="cards-grid">${state.cards.map(cardHTML).join('')}</div>`;
  if (ui.page === 'scenes') $('#view').innerHTML = `${heading('一件件确认，就不用再猜', '场景清单', '出门、照顾猫咪……把一起做的事情放在一起。')}<div class="scenes-grid">${state.scenes.map(sceneHTML).join('')}</div><p class="page-footnote">这里保存的是你当时的确认记录，不会自动检测门锁或电器状态。</p>`;
  if (ui.page === 'calendar') {
    const entries = ui.filter === 'all' ? state.entries : cardEntries(state, ui.filter);
    $('#view').innerHTML = `${heading('一点一点，留下生活的痕迹', '记录日历', '有记录的日子亮起。点一个方格，看看那天的小事。')}<div class="filter-bar"><label for="calendar-filter">查看记录</label><select id="calendar-filter">${[['all', '全部卡片'], ...state.cards.map(c => [c.id, c.title])].map(([id, title]) => `<option value="${esc(id)}" ${id === ui.filter ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></div>${calendarHTML(entries)}`;
  }
  if (ui.page === 'settings') $('#view').innerHTML = settingsHTML();
  if ($('#details').open && ui.detailId) renderDetails();
  if (focusData && !$('#editor').open) {
    const selector = `[data-action="${CSS.escape(focusData.action)}"]${focusData.id ? `[data-id="${CSS.escape(focusData.id)}"]` : ''}${focusData.day ? `[data-day="${CSS.escape(focusData.day)}"]` : ''}`;
    ($('#details').open ? $('#details') : $('#view')).querySelector(selector)?.focus({ preventScroll: true });
  }
}
async function change(update, message, undoId) {
  if (readonly || writing) return false;
  writing = true;
  try {
    const write = () => { state = store.commit(update); };
    if (navigator.locks?.request) await navigator.locks.request(store.key, write); else write();
    $('#error-banner').hidden = true; render(); if (message) toast(message, undoId); return true;
  } catch (e) { showError(`这次没有保存成功。${e.name === 'QuotaExceededError' ? '浏览器存储空间不足，原记录仍然保留。' : e.message}`); return false; }
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
  const reminder = card?.reminder || { type: 'none' };
  let unit = '60', amount = 24;
  if (reminder.type === 'interval') { unit = reminder.minutes % 1440 === 0 ? '1440' : reminder.minutes % 60 === 0 ? '60' : '1'; amount = reminder.minutes / Number(unit); }
  $('#editor').innerHTML = `<div class="dialog-header"><div><div class="eyebrow">一点小设置</div><h2 id="editor-title">${card ? '编辑卡片' : '添一件生活小事'}</h2></div><button class="icon-button" data-action="close-editor" aria-label="关闭卡片设置">×</button></div><form class="dialog-form" id="card-form" data-id="${esc(id || '')}">
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
  $('#details').innerHTML = `<div class="dialog-header"><div><div class="eyebrow">${card.kind === 'confirm' ? '每一次确认，都有迹可循' : '记下的小事，都在这里'}</div><h2 id="details-title">${esc(card.title)}</h2></div><button class="icon-button" data-action="close-detail" aria-label="关闭记录详情">×</button></div><div class="detail-body">${reminderHTML(card, entries)}${calendarHTML(entries)}<div class="form-actions"><button class="button secondary" data-action="edit-from-detail" data-id="${esc(card.id)}">卡片设置</button>${entries.length ? `<button class="text-button" data-action="undo" data-id="${esc(card.id)}" ${readonly ? 'disabled' : ''}>撤销最近一次</button>` : ''}</div></div>`;
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
    const success = await change(s => addEntry(s, id, new Date(), crypto.randomUUID()), card.kind === 'confirm' ? `${card.title}，确认已保存` : `${card.title}，记住啦！`, id);
    if (success) { ui.calendarPage = 0; ui.selectedDay = localDayKey(new Date()); playFeedback(id); }
    setTimeout(() => { cooldowns.delete(id); render(); }, 900);
  }
  if (action === 'undo') await change(s => undoEntry(s, id), '已撤销最近一次，其他记录仍然保留。');
  if (action === 'new-round') await change(s => startRound(s, id, new Date(), crypto.randomUUID()), '新一次出门已开始，上一次的确认记录仍在。');
  if (action === 'detail') { ui.detailId = id; ui.calendarPage = 0; ui.selectedDay = null; ui.detailAll = false; renderDetails(); $('#details').showModal(); }
  if (action === 'calendar-prev' || action === 'calendar-next') { ui.calendarPage = Math.max(0, ui.calendarPage + (action === 'calendar-prev' ? 1 : -1)); ui.selectedDay = null; ui.detailAll = false; render(); }
  if (action === 'calendar-day') { ui.selectedDay = button.dataset.day; ui.detailAll = false; render(); }
  if (action === 'all-history') { ui.detailAll = !ui.detailAll; render(); }
});
document.addEventListener('change', async event => {
  if (['card-kind', 'reminder-type'].includes(event.target.id)) updateEditorFields();
  if (event.target.id === 'calendar-filter') { ui.filter = event.target.value; ui.detailAll = false; render(); }
  if (event.target.dataset.setting) {
    const name = event.target.dataset.setting, value = name === 'sound' ? event.target.checked : event.target.value;
    await change(s => ({ ...s, settings: { ...s.settings, [name]: value } }), '设置已保存'); render();
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'card-form') return;
  event.preventDefault(); const form = event.target, data = new FormData(form), id = form.dataset.id;
  const old = state.cards.find(c => c.id === id), kind = old?.kind || data.get('kind'), title = data.get('title').trim();
  const reminder = { type: data.get('reminder') };
  if (reminder.type === 'interval') reminder.minutes = Number(data.get('amount')) * Number(data.get('unit'));
  if (reminder.type === 'daily') reminder.time = data.get('time');
  if (!title || (reminder.type === 'interval' && (!Number.isFinite(reminder.minutes) || reminder.minutes < 1 || reminder.minutes > 5256000))) {
    $('#form-error').textContent = !title ? '给这张卡片起个名字吧。' : '间隔需要在 1 分钟至 10 年内。'; $('#form-error').hidden = false; return;
  }
  const card = { id: old?.id || crypto.randomUUID(), title, icon: data.get('icon'), tone: old?.tone || ['mint', 'blue', 'peach', 'lilac'][state.cards.length % 4], kind, sceneId: kind === 'confirm' ? data.get('scene') || null : null, reminder, createdAt: old?.createdAt || new Date().toISOString() };
  const success = await change(s => ({ ...s, cards: old ? s.cards.map(c => c.id === id ? card : c) : [...s.cards, card] }), old ? '卡片设置已保存' : '新卡片准备好了');
  if (success) { $('#editor').close(); if (!old) navigate(card.sceneId ? 'scenes' : 'cards'); }
  else { $('#form-error').textContent = $('#error-banner').textContent; $('#form-error').hidden = false; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('nav-open')) { closeMenu(); $('.menu-toggle').focus(); } });
window.addEventListener('hashchange', () => { ui.page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'home'; ui.calendarPage = 0; ui.selectedDay = null; ui.detailAll = false; closeMenu(); render(); window.scrollTo({ top: 0 }); });
window.addEventListener('storage', event => {
  if (event.key !== store?.key && event.key !== null) return;
  try { state = store.reload(); render(); } catch (e) { readonly = true; showError(e.message); render(); }
});
window.addEventListener('resize', syncMenu);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
setInterval(() => { if (!$('#editor').open && !writing) render(); }, 30000);
ui.page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'home';
render(); syncMenu();
