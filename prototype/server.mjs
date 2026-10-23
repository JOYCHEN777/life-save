import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { addEntry, createInitialState, deleteJournal, migrateState, saveEntryNote, saveJournal, startRound, validateState } from './model.js';
import { APPEARANCE_VERSION, cloneAppearance, createDefaultAppearance, MAX_WALLPAPER_DATA_LENGTH, validateAppearance } from './appearance.js';

export const DEFAULT_PORT = 8787;
const SERVER_FILE = fileURLToPath(import.meta.url);
const PROTOTYPE_DIR = path.dirname(SERVER_FILE);
const MAX_BODY_LENGTH = 10 * 1024 * 1024;
const MIME_TYPES = { '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

export class ServiceError extends Error {
  constructor(message, { code = 'service_error', status = 500, current = null, details = null } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
    this.current = current;
    this.details = details;
  }
}

export function resolveDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Life Save');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Life Save');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'life-save');
}

export function normalizeSpace(value = 'default') {
  const raw = String(value || 'default');
  if (raw === 'default') return { id: 'default', isTest: false, label: '本机正式存档', fileKey: 'main' };
  if (!raw.startsWith('test:') || raw.length > 96 || /[\\/\0]/u.test(raw)) throw new ServiceError('测试存档标识无效。', { code: 'invalid_space', status: 400 });
  const name = raw.slice(5);
  if (!name) throw new ServiceError('测试存档标识不能为空。', { code: 'invalid_space', status: 400 });
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 20);
  return { id: raw, isTest: true, label: `测试存档 · ${name.slice(0, 48)}${name.length > 48 ? '…' : ''}`, fileKey: `test-${digest}` };
}

function ensureDir(directory) { mkdirSync(directory, { recursive: true }); }
function isoNow() { return new Date().toISOString(); }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function safeJson(value) { return JSON.stringify(value); }
function safeText(value, max = 200) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function requireCondition(condition, message, code = 'invalid_request') {
  if (!condition) throw new ServiceError(message, { code, status: code === 'conflict' ? 409 : 422 });
}

function sourceHash(source) {
  return createHash('sha256').update(safeJson({ sourceKey: source.sourceKey, state: source.state, appearance: source.appearance })).digest('hex');
}

function stripFields(value, fields) {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

function stateHasRealContent(state) {
  const baseline = createInitialState(new Date(0));
  if (state.entries.length > 0 || state.journal.length > 0) return true;
  if (state.cards.length !== baseline.cards.length || state.scenes.length !== baseline.scenes.length) return true;
  const baselineCards = new Map(baseline.cards.map(card => [card.id, card]));
  for (const card of state.cards) {
    const expected = baselineCards.get(card.id);
    if (!expected || !deepEqual(stripFields(card, ['createdAt']), stripFields(expected, ['createdAt']))) return true;
  }
  const baselineScenes = new Map(baseline.scenes.map(scene => [scene.id, scene]));
  for (const scene of state.scenes) {
    const expected = baselineScenes.get(scene.id);
    if (!expected) return true;
    const actualComparable = stripFields(scene, ['startedAt']);
    const expectedComparable = stripFields(expected, ['startedAt']);
    if (scene.id === 'outing' && actualComparable.roundId?.startsWith('outing:')) actualComparable.roundId = 'outing:<initial>';
    if (scene.id === 'outing' && expectedComparable.roundId?.startsWith('outing:')) expectedComparable.roundId = 'outing:<initial>';
    if (!deepEqual(actualComparable, expectedComparable)) return true;
  }
  return !deepEqual(state.settings, baseline.settings);
}

function snapshotHasRealContent(snapshot) {
  return stateHasRealContent(snapshot.state) || !deepEqual(snapshot.appearance, createDefaultAppearance());
}

function summarizeState(state, appearance) {
  return {
    cards: state.cards.length,
    scenes: state.scenes.length,
    entries: state.entries.length,
    journal: state.journal.length,
    hasWallpaper: Boolean(appearance.wallpaper),
    theme: appearance.theme,
  };
}

function mergeRows(currentRows, sourceRows, conflicts, kind) {
  const rows = new Map(currentRows.map(row => [row.id, row]));
  for (const row of sourceRows) {
    if (!rows.has(row.id)) rows.set(row.id, row);
    else if (!deepEqual(rows.get(row.id), row)) conflicts.push({ kind, id: row.id });
  }
  return [...rows.values()];
}

export function mergeSnapshots(current, source, mode = 'merge') {
  const conflicts = [];
  const currentIsFresh = !snapshotHasRealContent(current);
  const sourceHasContent = snapshotHasRealContent(source);
  const sourcePreferred = mode === 'source' || (mode === 'merge' && currentIsFresh && sourceHasContent);
  if (mode === 'current') return { state: current.state, appearance: current.appearance, conflicts, preferred: 'current' };
  if (sourcePreferred) return { state: source.state, appearance: source.appearance, conflicts, preferred: 'source' };

  const state = {
    ...current.state,
    cards: mergeRows(current.state.cards, source.state.cards, conflicts, 'card'),
    scenes: mergeRows(current.state.scenes, source.state.scenes, conflicts, 'scene'),
    entries: mergeRows(current.state.entries, source.state.entries, conflicts, 'entry').sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    journal: mergeRows(current.state.journal, source.state.journal, conflicts, 'journal').sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    settings: current.state.settings,
  };
  if (deepEqual(current.state.settings, createInitialState(new Date(0)).settings)) state.settings = source.state.settings;
  const appearance = deepEqual(current.appearance, createDefaultAppearance()) ? source.appearance : current.appearance;
  if (!deepEqual(current.appearance, source.appearance) && !deepEqual(current.appearance, createDefaultAppearance())) conflicts.push({ kind: 'appearance', id: 'appearance' });
  validateState({ ...state, revision: current.state.revision });
  return { state, appearance, conflicts, preferred: 'merge' };
}

function mimeFromDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new ServiceError('壁纸格式无法读取。', { code: 'invalid_wallpaper', status: 422 });
  if (dataUrl.length > MAX_WALLPAPER_DATA_LENGTH) throw new ServiceError('壁纸文件过大。', { code: 'invalid_wallpaper', status: 422 });
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
}

function extensionForMime(mime) { return mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.jpg'; }
function dataUrlForFile(mime, bytes) { return `data:${mime};base64,${bytes.toString('base64')}`; }

function storedAppearanceFromClient(input, filesDir) {
  const appearance = cloneAppearance(validateAppearance(input));
  if (!appearance.wallpaper) return { stored: { version: APPEARANCE_VERSION, theme: appearance.theme, wallpaper: null }, createdFile: null };
  const { mime, bytes } = mimeFromDataUrl(appearance.wallpaper.dataUrl);
  ensureDir(filesDir);
  const relativePath = path.join('files', `wallpaper-${randomUUID()}${extensionForMime(mime)}`);
  const absolutePath = path.join(path.dirname(filesDir), relativePath);
  writeFileSync(absolutePath, bytes, { flag: 'wx' });
  return {
    stored: { version: APPEARANCE_VERSION, theme: appearance.theme, wallpaper: { path: relativePath, name: appearance.wallpaper.name, type: mime } },
    createdFile: absolutePath,
  };
}

function clientAppearanceFromStored(stored, dataRoot) {
  requireCondition(stored && stored.version === APPEARANCE_VERSION, '外观配置版本无法读取。', 'corrupt_database');
  let wallpaper = null;
  const warnings = [];
  if (stored.wallpaper) {
    const absolutePath = path.resolve(dataRoot, stored.wallpaper.path);
    const filesRoot = path.resolve(dataRoot, 'files');
    if (!absolutePath.startsWith(`${filesRoot}${path.sep}`) || !existsSync(absolutePath)) {
      warnings.push(`壁纸文件「${stored.wallpaper.name}」不可用，已保留主题并忽略壁纸。`);
    } else {
      wallpaper = { dataUrl: dataUrlForFile(stored.wallpaper.type, readFileSync(absolutePath)), name: stored.wallpaper.name, type: stored.wallpaper.type };
    }
  }
  const appearance = { version: APPEARANCE_VERSION, theme: stored.theme, wallpaper };
  validateAppearance(appearance);
  return { appearance, warnings };
}

function createSchema(db) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      name TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      request_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      state_json TEXT NOT NULL,
      appearance_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migrations (
      source_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function rowPayload(db, name) {
  const row = db.prepare('SELECT revision, payload FROM documents WHERE name = ?').get(name);
  if (!row) throw new ServiceError('正式存档不完整，未覆盖原数据库。', { code: 'corrupt_database', status: 500 });
  return { revision: row.revision, value: JSON.parse(row.payload) };
}

function saveDocument(db, name, revision, value) {
  db.prepare('INSERT INTO documents(name, revision, payload, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision, payload=excluded.payload, updated_at=excluded.updated_at').run(name, revision, safeJson(value), isoNow());
}

export class SQLiteRepository {
  constructor({ dataDir, space }) {
    this.dataDir = dataDir;
    this.space = space;
    this.spaceDir = space.isTest ? path.join(dataDir, 'tests', space.fileKey) : dataDir;
    this.dbPath = path.join(this.spaceDir, 'data.sqlite');
    this.filesDir = path.join(this.spaceDir, 'files');
    ensureDir(this.spaceDir);
    ensureDir(this.filesDir);
    this.db = new DatabaseSync(this.dbPath);
    createSchema(this.db);
    this.ensureDocuments();
  }

  ensureDocuments() {
    if (!this.db.prepare('SELECT 1 FROM documents WHERE name = ?').get('state')) saveDocument(this.db, 'state', 0, createInitialState(new Date()));
    if (!this.db.prepare('SELECT 1 FROM documents WHERE name = ?').get('appearance')) saveDocument(this.db, 'appearance', 0, { version: APPEARANCE_VERSION, theme: 'meadow', wallpaper: null });
  }

  snapshot() {
    const stateRow = rowPayload(this.db, 'state');
    const appearanceRow = rowPayload(this.db, 'appearance');
    const { appearance, warnings } = clientAppearanceFromStored(appearanceRow.value, this.spaceDir);
    const state = validateState(stateRow.value);
    return { ok: true, space: { id: this.space.id, isTest: this.space.isTest, label: this.space.label }, state, appearance, revisions: { state: state.revision, appearance: appearanceRow.revision }, warnings };
  }

  withTransaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    const createdFiles = [];
    try {
      const result = callback(createdFiles);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      for (const file of createdFiles) { try { unlinkSync(file); } catch { /* Best effort cleanup. */ } }
      throw error;
    }
  }

  readCurrent() {
    const current = this.snapshot();
    return { state: current.state, appearance: current.appearance };
  }

  execute(action, payload = {}, requestId = randomUUID()) {
    requireCondition(safeText(requestId, 100), '提交标识无效。');
    return this.withTransaction(createdFiles => {
      const previous = this.db.prepare('SELECT response_json FROM operations WHERE request_id = ?').get(requestId);
      if (previous) return JSON.parse(previous.response_json);
      const stateRow = rowPayload(this.db, 'state');
      const appearanceRow = rowPayload(this.db, 'appearance');
      const currentAppearance = clientAppearanceFromStored(appearanceRow.value, this.spaceDir).appearance;
      let nextState = validateState(stateRow.value);
      let nextAppearance = currentAppearance;
      let nextStoredAppearance = appearanceRow.value;
      let stateChanged = false;
      let appearanceChanged = false;

      if (action === 'appearance_update') {
        const result = storedAppearanceFromClient(payload.appearance, this.filesDir);
        if (result.createdFile) createdFiles.push(result.createdFile);
        nextStoredAppearance = result.stored;
        nextAppearance = cloneAppearance(validateAppearance(payload.appearance));
        appearanceChanged = !deepEqual(nextStoredAppearance, appearanceRow.value);
      } else {
        const result = this.applyStateAction(nextState, action, payload);
        nextState = result;
        stateChanged = !deepEqual(result, stateRow.value);
      }

      if (stateChanged) {
        nextState = { ...nextState, revision: nextState.revision + 1 };
        validateState(nextState);
        saveDocument(this.db, 'state', nextState.revision, nextState);
      }
      if (appearanceChanged) saveDocument(this.db, 'appearance', appearanceRow.revision + 1, nextStoredAppearance);
      if (stateChanged || appearanceChanged) this.db.prepare('INSERT INTO change_log(request_id, action, payload_json, created_at) VALUES(?, ?, ?, ?)').run(requestId, action, safeJson(payload), isoNow());
      const response = this.snapshot();
      this.db.prepare('INSERT INTO operations(request_id, action, response_json, created_at) VALUES(?, ?, ?, ?)').run(requestId, action, safeJson(response), isoNow());
      return response;
    });
  }

  applyStateAction(state, action, payload) {
    const now = payload.at && Number.isFinite(Date.parse(payload.at)) ? new Date(payload.at) : new Date();
    if (action === 'record') {
      requireCondition(safeText(payload.cardId, 100) && safeText(payload.entryId, 100), '记录提交缺少标识。');
      if (state.entries.some(entry => entry.id === payload.entryId)) return state;
      return addEntry(state, payload.cardId, now, payload.entryId);
    }
    if (action === 'undo_entry') {
      requireCondition(safeText(payload.cardId, 100) && safeText(payload.entryId, 100), '撤销提交缺少标识。');
      const target = state.entries.find(entry => entry.id === payload.entryId);
      if (!target || target.cardId !== payload.cardId) return state;
      return { ...state, entries: state.entries.filter(entry => entry.id !== payload.entryId) };
    }
    if (action === 'save_entry_note') {
      const entry = state.entries.find(item => item.id === payload.entryId);
      requireCondition(entry, '这条记录已被撤销，文字仍在输入框中。', 'conflict');
      const currentStamp = entry.noteUpdatedAt || null;
      if (currentStamp !== (payload.expectedNoteUpdatedAt || null)) throw new ServiceError('这段备注已在另一页面修改；输入内容仍保留，请重新打开后核对。', { code: 'conflict', status: 409, current: this.snapshot() });
      return saveEntryNote(state, payload.entryId, payload.text, now);
    }
    if (action === 'save_journal') {
      requireCondition(safeText(payload.id, 100), '随手记提交缺少标识。');
      const existing = state.journal.find(item => item.id === payload.id);
      if (existing) {
        if (existing.text === String(payload.text || '').trim()) return state;
        throw new ServiceError('这条随手记已经在另一页面保存。', { code: 'conflict', status: 409, current: this.snapshot() });
      }
      return saveJournal(state, payload.id, payload.text, now);
    }
    if (action === 'delete_journal') {
      requireCondition(safeText(payload.id, 100), '删除随手记缺少标识。');
      const existing = state.journal.find(item => item.id === payload.id);
      if (!existing) return state;
      if (existing.updatedAt !== payload.expectedUpdatedAt) throw new ServiceError('这条随手记已在另一页面发生变化，请刷新后确认是否删除。', { code: 'conflict', status: 409, current: this.snapshot() });
      return deleteJournal(state, payload.id);
    }
    if (action === 'start_round') return startRound(state, payload.sceneId, now, payload.roundId);
    if (action === 'update_setting') {
      requireCondition(['sound', 'strength'].includes(payload.name), '设置项无效。');
      const value = payload.name === 'sound' ? payload.value === true : payload.value;
      requireCondition(payload.name === 'sound' ? typeof payload.value === 'boolean' : ['crisp', 'soft'].includes(value), '设置值无效。');
      return { ...state, settings: { ...state.settings, [payload.name]: value } };
    }
    if (action === 'upsert_card') {
      requireCondition(payload.card && typeof payload.card === 'object' && safeText(payload.card.id, 100), '卡片提交无效。');
      const current = state.cards.find(card => card.id === payload.card.id);
      if (current && payload.expectedCard && !deepEqual(current, payload.expectedCard)) throw new ServiceError('这张卡片已在另一页面修改，请刷新后重试。', { code: 'conflict', status: 409, current: this.snapshot() });
      if (current) return { ...state, cards: state.cards.map(card => card.id === payload.card.id ? payload.card : card) };
      if (state.cards.some(card => card.id === payload.card.id)) throw new ServiceError('这张卡片已经存在。', { code: 'conflict', status: 409, current: this.snapshot() });
      return { ...state, cards: [...state.cards, payload.card] };
    }
    throw new ServiceError(`未知的存储操作：${action}`, { code: 'unknown_action', status: 400 });
  }

  migrationPreview(source) {
    const normalized = normalizeSource(source);
    const current = this.readCurrent();
    const merged = mergeSnapshots(current, normalized, 'merge');
    return { sourceId: sourceHash(normalized), current: summarizeState(current.state, current.appearance), source: summarizeState(normalized.state, normalized.appearance), result: summarizeState(merged.state, merged.appearance), conflicts: merged.conflicts, recommended: merged.preferred };
  }

  applyMigration(source, mode = 'merge') {
    const normalized = normalizeSource(source);
    requireCondition(['merge', 'source', 'current'].includes(mode), '迁入方式无效。');
    const sourceId = sourceHash(normalized);
    return this.withTransaction(createdFiles => {
      const existing = this.db.prepare('SELECT summary_json FROM migrations WHERE source_id = ?').get(sourceId);
      if (existing) return { ...this.snapshot(), migration: { sourceId, alreadyApplied: true, summary: JSON.parse(existing.summary_json) } };
      const current = this.readCurrent();
      const merged = mergeSnapshots(current, normalized, mode);
      const backup = this.snapshot();
      this.db.prepare('INSERT INTO backups(id, reason, state_json, appearance_json, created_at) VALUES(?, ?, ?, ?, ?)').run(randomUUID(), 'migration', safeJson(backup.state), safeJson(backup.appearance), isoNow());
      const nextState = { ...merged.state, revision: current.state.revision + 1 };
      validateState(nextState);
      saveDocument(this.db, 'state', nextState.revision, nextState);
      const stored = storedAppearanceFromClient(merged.appearance, this.filesDir);
      if (stored.createdFile) createdFiles.push(stored.createdFile);
      const appearanceRow = rowPayload(this.db, 'appearance');
      saveDocument(this.db, 'appearance', appearanceRow.revision + 1, stored.stored);
      const summary = { mode, sourceId, conflicts: merged.conflicts, before: summarizeState(current.state, current.appearance), after: summarizeState(nextState, merged.appearance) };
      this.db.prepare('INSERT INTO migrations(source_id, source_key, summary_json, created_at) VALUES(?, ?, ?, ?)').run(sourceId, normalized.sourceKey, safeJson(summary), isoNow());
      this.db.prepare('INSERT INTO change_log(request_id, action, payload_json, created_at) VALUES(?, ?, ?, ?)').run(`migration:${sourceId}`, 'migration', safeJson({ sourceKey: normalized.sourceKey, mode }), isoNow());
      return { ...this.snapshot(), migration: { sourceId, alreadyApplied: false, summary } };
    });
  }

  close() { this.db.close(); }
}

function normalizeSource(source) {
  requireCondition(source && safeText(source.sourceKey, 500) && source.state && source.appearance, '旧存档来源不完整。');
  let state;
  try { state = migrateState(source.state); } catch (error) { throw new ServiceError(`旧存档无法读取：${error.message}`, { code: 'invalid_source', status: 422 }); }
  let appearance;
  try { appearance = cloneAppearance(validateAppearance(source.appearance)); } catch (error) { throw new ServiceError(`旧外观无法读取：${error.message}`, { code: 'invalid_source', status: 422 }); }
  return { sourceKey: source.sourceKey, state, appearance };
}

function contentType(filePath) { return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'; }
function allowedOrigin(origin) { return !origin || /^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(origin); }

function sendJson(response, status, body, request) {
  const origin = request.headers.origin;
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
  if (allowedOrigin(origin) && origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_LENGTH) throw new ServiceError('请求内容过大。', { code: 'body_too_large', status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('请求内容不是有效 JSON。', { code: 'invalid_json', status: 400 }); }
}

function staticPath(urlPath) {
  const relative = urlPath === '/prototype/' || urlPath === '/prototype' ? 'index.html' : urlPath.startsWith('/prototype/') ? urlPath.slice('/prototype/'.length) : null;
  if (!relative || relative.includes('..') || relative.includes('\0')) return null;
  const resolved = path.resolve(PROTOTYPE_DIR, relative);
  if (!resolved.startsWith(`${PROTOTYPE_DIR}${path.sep}`)) return null;
  return resolved;
}

export function createLifeSaveServer({ dataDir = resolveDataDir(), host = '127.0.0.1' } = {}) {
  const repositories = new Map();
  const getRepository = value => {
    const space = normalizeSpace(value);
    if (!repositories.has(space.id)) repositories.set(space.id, new SQLiteRepository({ dataDir, space }));
    return repositories.get(space.id);
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${DEFAULT_PORT}`}`);
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': allowedOrigin(request.headers.origin) ? request.headers.origin || '*' : 'null', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
        response.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health' && request.method === 'GET') { sendJson(response, 200, { ok: true, service: 'life-save-sqlite', dataDir }, request); return; }
        const body = request.method === 'POST' ? await readBody(request) : null;
        const repository = getRepository(url.searchParams.get('space') || body?.space || 'default');
        if (url.pathname === '/api/bootstrap' && request.method === 'GET') { sendJson(response, 200, repository.snapshot(), request); return; }
        if (url.pathname === '/api/actions' && request.method === 'POST') { sendJson(response, 200, repository.execute(body.action, body.payload, body.requestId), request); return; }
        if (url.pathname === '/api/migrations/preview' && request.method === 'POST') { sendJson(response, 200, { ok: true, ...repository.migrationPreview(body.source) }, request); return; }
        if (url.pathname === '/api/migrations/apply' && request.method === 'POST') { sendJson(response, 200, repository.applyMigration(body.source, body.mode), request); return; }
        throw new ServiceError('找不到本机存储接口。', { code: 'not_found', status: 404 });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ServiceError('不支持此请求方式。', { code: 'method_not_allowed', status: 405 });
      const filePath = staticPath(url.pathname);
      if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) throw new ServiceError('页面资源不存在。', { code: 'not_found', status: 404 });
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': contentType(filePath) });
      if (request.method === 'HEAD') response.end(); else response.end(readFileSync(filePath));
    } catch (error) {
      const serviceError = error instanceof ServiceError ? error : new ServiceError(`本机存储服务出错：${error.message}`, { code: 'internal_error', status: 500 });
      sendJson(response, serviceError.status, { ok: false, error: { code: serviceError.code, message: serviceError.message, current: serviceError.current, details: serviceError.details } }, request);
    }
  });
  server.dataDir = dataDir;
  server.host = host;
  server.repositories = repositories;
  server.closeLifeSave = callback => server.close(() => { for (const repository of repositories.values()) repository.close(); if (callback) callback(); });
  return server;
}

function cli() {
  const portArg = process.argv.find(arg => arg.startsWith('--port='))?.slice('--port='.length);
  const port = Number(portArg || process.env.PORT || DEFAULT_PORT);
  const dataDir = process.env.LIFE_SAVE_DATA_DIR || resolveDataDir();
  const server = createLifeSaveServer({ dataDir });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Life Save SQLite service: http://127.0.0.1:${port}/prototype/`);
    console.log(`Data directory: ${dataDir}`);
  });
  const stop = () => server.closeLifeSave(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (path.resolve(process.argv[1] || '') === SERVER_FILE) cli();
