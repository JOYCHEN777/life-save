import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultAppearance } from './appearance.js';
import { RemoteStore, RemoteStoreError, resolveServiceOrigin, resolveSpace } from './sqlite-store.js';

const snapshot = {
  ok: true,
  space: { id: 'default', isTest: false, label: '本机正式存档' },
  state: { version: 4, revision: 0, cards: [], scenes: [], entries: [], journal: [], settings: { sound: false, strength: 'crisp' } },
  appearance: createDefaultAppearance(),
  revisions: { state: 0, appearance: 0 },
};

test('service origin and space resolution keep test data explicit', () => {
  assert.equal(resolveServiceOrigin({ protocol: 'http:', hostname: '127.0.0.1', port: '8080', search: '' }), 'http://127.0.0.1:8787');
  assert.equal(resolveServiceOrigin({ protocol: 'http:', hostname: 'localhost', port: '8787', search: '' }), 'http://localhost:8787');
  assert.deepEqual(resolveSpace({ search: '' }), { id: 'default', isTest: false, label: '本机正式存档' });
  assert.deepEqual(resolveSpace({ search: '?check=notes-square' }), { id: 'test:notes-square', isTest: true, label: '测试存档 · notes-square' });
});

test('RemoteStore accepts bootstrap and action snapshots', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new RemoteStore({ serviceOrigin: 'http://127.0.0.1:8787', space: resolveSpace({ search: '' }), fetchImpl });
  await store.load();
  await store.dispatch('update_setting', { name: 'sound', value: true }, 'request-1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/bootstrap\?space=default$/u);
  assert.equal(JSON.parse(calls[1].options.body).requestId, 'request-1');
  assert.equal(store.state.settings.sound, false);
});

test('RemoteStore exposes connection failures and server conflicts', async () => {
  const unavailable = new RemoteStore({ serviceOrigin: 'http://127.0.0.1:8787', space: resolveSpace({ search: '' }), fetchImpl: async () => { throw new Error('refused'); } });
  await assert.rejects(() => unavailable.load(), error => error instanceof RemoteStoreError && error.code === 'service_unavailable');

  const conflict = new RemoteStore({
    serviceOrigin: 'http://127.0.0.1:8787',
    space: resolveSpace({ search: '' }),
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { code: 'conflict', message: '版本冲突', current: snapshot } }), { status: 409, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(() => conflict.dispatch('save_entry_note', {}), error => error instanceof RemoteStoreError && error.code === 'conflict' && error.current?.state?.revision === snapshot.state.revision);
});
