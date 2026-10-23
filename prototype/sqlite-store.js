import { migrateState } from './model.js';
import { cloneAppearance, createDefaultAppearance, validateAppearance } from './appearance.js';

export const DEFAULT_SERVICE_PORT = 8787;

export class RemoteStoreError extends Error {
  constructor(message, { code = 'remote_error', status = 0, current = null, details = null } = {}) {
    super(message);
    this.name = 'RemoteStoreError';
    this.code = code;
    this.status = status;
    this.current = current;
    this.details = details;
  }
}

function randomRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function servicePort(locationLike) {
  const requested = new URLSearchParams(locationLike.search || '').get('servicePort');
  if (requested && /^\d{2,5}$/.test(requested)) return requested;
  if (locationLike.port && locationLike.port !== '8080' && locationLike.port !== '8081') return locationLike.port;
  return String(DEFAULT_SERVICE_PORT);
}

export function resolveServiceOrigin(locationLike = globalThis.location) {
  if (!locationLike) return `http://127.0.0.1:${DEFAULT_SERVICE_PORT}`;
  const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(locationLike.hostname);
  if (localHost) return `${locationLike.protocol || 'http:'}//${locationLike.hostname}:${servicePort(locationLike)}`;
  return locationLike.origin;
}

export function resolveSpace(locationLike = globalThis.location) {
  const check = new URLSearchParams(locationLike?.search || '').get('check');
  if (!check) return { id: 'default', isTest: false, label: '本机正式存档' };
  const label = check.length > 48 ? `${check.slice(0, 48)}…` : check;
  return { id: `test:${check}`, isTest: true, label: `测试存档 · ${label}` };
}

export class RemoteStore {
  constructor({ serviceOrigin, space, fetchImpl = (...args) => globalThis.fetch(...args) }) {
    this.serviceOrigin = serviceOrigin.replace(/\/$/, '');
    this.space = space;
    this.fetchImpl = fetchImpl;
    this.key = `sqlite:${space.id}`;
    this._state = null;
    this._appearance = createDefaultAppearance();
    this._snapshot = null;
  }

  get state() { return this._state; }
  get appearance() { return this._appearance; }
  get snapshot() { return this._snapshot; }

  async request(path, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.serviceOrigin}${path}`, {
        ...options,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      });
    } catch (error) {
      throw new RemoteStoreError(`无法连接本机存储服务。${error.message}`, { code: 'service_unavailable' });
    }
    let body;
    try { body = await response.json(); }
    catch { throw new RemoteStoreError(`本机存储服务返回了无法读取的响应（${response.status}）。`, { status: response.status }); }
    if (!response.ok || body?.ok === false) {
      const error = body?.error || {};
      throw new RemoteStoreError(error.message || `本机存储服务请求失败（${response.status}）。`, { code: error.code || 'remote_error', status: response.status, current: error.current || null, details: error.details || null });
    }
    return body;
  }

  accept(snapshot) {
    this._snapshot = snapshot;
    this._state = snapshot.state;
    this._appearance = cloneAppearance(snapshot.appearance);
    this.space = snapshot.space || this.space;
    return snapshot;
  }

  async load() {
    return this.accept(await this.request(`/api/bootstrap?space=${encodeURIComponent(this.space.id)}`));
  }

  async reload() {
    return this.load();
  }

  async dispatch(action, payload = {}, requestId = randomRequestId()) {
    return this.accept(await this.request('/api/actions', { method: 'POST', body: JSON.stringify({ space: this.space.id, action, payload, requestId }) }));
  }

  async previewMigration(source) {
    return this.request('/api/migrations/preview', { method: 'POST', body: JSON.stringify({ space: this.space.id, source }) });
  }

  async applyMigration(source, mode) {
    return this.accept(await this.request('/api/migrations/apply', { method: 'POST', body: JSON.stringify({ space: this.space.id, source, mode }) }));
  }
}

function parseStored(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function appearanceForKey(storage, key) {
  const suffix = key.slice('life-save:app-v3:'.length);
  const appearanceKey = `life-save:appearance-v1:${suffix}`;
  const value = parseStored(storage, appearanceKey);
  if (!value) return createDefaultAppearance();
  try { return cloneAppearance(validateAppearance(value)); } catch { return createDefaultAppearance(); }
}

export function readLegacySnapshots(storage) {
  const sources = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith('life-save:app-v3:') || key.endsWith(':before-v4')) continue;
    const raw = parseStored(storage, key);
    if (!raw) continue;
    try {
      const state = migrateState(raw);
      sources.push({ sourceKey: key, state, appearance: appearanceForKey(storage, key) });
    } catch { /* Keep malformed legacy data untouched and out of the import list. */ }
  }
  return sources.sort((a, b) => b.state.revision - a.state.revision || a.sourceKey.localeCompare(b.sourceKey));
}

export function readLegacySnapshot(storage, pathname, search) {
  const suffix = JSON.stringify([pathname, search]);
  const preferred = `life-save:app-v3:${suffix}`;
  return readLegacySnapshots(storage).find(source => source.sourceKey === preferred) || readLegacySnapshots(storage)[0] || null;
}
