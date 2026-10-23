import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addEntry, createInitialState, saveJournal } from './model.js';
import { createDefaultAppearance } from './appearance.js';
import { createLifeSaveServer } from './server.mjs';

async function startServer(dataDir) {
  const server = createLifeSaveServer({ dataDir });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.closeLifeSave(error => error ? reject(error) : resolve()));
}

async function request(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('SQLite service persists concurrent records and request retries without duplication', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'life-save-server-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let running = await startServer(dataDir);
  t.after(() => stopServer(running.server));

  const initial = await request(running.origin, '/api/bootstrap?space=default');
  assert.equal(initial.status, 200);
  const cardId = initial.body.state.cards[0].id;
  const first = { space: 'default', action: 'record', requestId: 'request-a', payload: { cardId, entryId: 'entry-a', at: '2026-10-23T01:00:00.000Z' } };
  const second = { space: 'default', action: 'record', requestId: 'request-b', payload: { cardId, entryId: 'entry-b', at: '2026-10-23T01:01:00.000Z' } };
  const responses = await Promise.all([request(running.origin, '/api/actions', first), request(running.origin, '/api/actions', second)]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 200]);
  assert.equal(responses.every(result => result.body.state.entries.length >= 1), true);

  const retry = await request(running.origin, '/api/actions', first);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.state.entries.filter(entry => entry.id === 'entry-a').length, 1);
  assert.equal((await request(running.origin, '/api/bootstrap?space=default')).body.state.entries.length, 2);

  await stopServer(running.server);
  running = await startServer(dataDir);
  const reopened = await request(running.origin, '/api/bootstrap?space=default');
  assert.equal(reopened.body.state.entries.length, 2);
  assert.equal(reopened.body.state.entries.some(entry => entry.id === 'entry-a'), true);
});

test('stale note writes return a conflict and preserve the newer text', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'life-save-server-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { server, origin } = await startServer(dataDir);
  t.after(() => stopServer(server));

  const initial = await request(origin, '/api/bootstrap?space=default');
  const cardId = initial.body.state.cards[0].id;
  await request(origin, '/api/actions', { space: 'default', action: 'record', requestId: 'record-note', payload: { cardId, entryId: 'entry-note', at: '2026-10-23T02:00:00.000Z' } });
  const saved = await request(origin, '/api/actions', { space: 'default', action: 'save_entry_note', requestId: 'note-new', payload: { entryId: 'entry-note', text: '第一份备注', expectedNoteUpdatedAt: null, at: '2026-10-23T02:01:00.000Z' } });
  assert.equal(saved.status, 200);
  const stale = await request(origin, '/api/actions', { space: 'default', action: 'save_entry_note', requestId: 'note-stale', payload: { entryId: 'entry-note', text: '旧页面覆盖', expectedNoteUpdatedAt: null, at: '2026-10-23T02:02:00.000Z' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'conflict');
  assert.equal(stale.body.error.current.state.entries.find(entry => entry.id === 'entry-note').note, '第一份备注');
});

test('test spaces are isolated from the formal archive', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'life-save-server-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { server, origin } = await startServer(dataDir);
  t.after(() => stopServer(server));

  const formal = await request(origin, '/api/bootstrap?space=default');
  const testSpace = await request(origin, '/api/bootstrap?space=test:notes-square');
  assert.equal(formal.body.state.entries.length, 0);
  assert.equal(testSpace.body.space.isTest, true);
  await request(origin, '/api/actions', { space: 'test:notes-square', action: 'record', requestId: 'test-record', payload: { cardId: testSpace.body.state.cards[0].id, entryId: 'test-entry', at: '2026-10-23T03:00:00.000Z' } });
  assert.equal((await request(origin, '/api/bootstrap?space=default')).body.state.entries.length, 0);
  assert.equal((await request(origin, '/api/bootstrap?space=test:notes-square')).body.state.entries.length, 1);
});

test('migration previews, creates a backup, and is idempotent', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'life-save-server-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { server, origin } = await startServer(dataDir);
  t.after(() => stopServer(server));

  const sourceCardState = createInitialState(new Date('2026-10-23T04:00:00.000Z'));
  const sourceState = addEntry(sourceCardState, sourceCardState.cards[0].id, new Date('2026-10-23T04:01:00.000Z'), 'migrated-entry');
  const sourceWithJournal = saveJournal(sourceState, 'migrated-journal', '迁入的随手记', new Date('2026-10-23T04:02:00.000Z'));
  const source = { sourceKey: 'life-save:app-v3:[legacy]', state: sourceWithJournal, appearance: createDefaultAppearance() };
  const preview = await request(origin, '/api/migrations/preview', { space: 'default', source });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.source.entries, 1);
  assert.equal(preview.body.source.journal, 1);
  assert.equal(preview.body.result.entries, 1);

  const applied = await request(origin, '/api/migrations/apply', { space: 'default', source, mode: 'merge' });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.migration.alreadyApplied, false);
  assert.equal(applied.body.state.entries.length, 1);
  assert.equal(applied.body.state.journal.length, 1);

  const repeated = await request(origin, '/api/migrations/apply', { space: 'default', source, mode: 'merge' });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.migration.alreadyApplied, true);
  assert.equal(repeated.body.state.entries.length, 1);
  assert.equal(repeated.body.state.journal.length, 1);
  assert.equal((await readFile(path.join(dataDir, 'data.sqlite'))).length > 0, true);
});

test('migration merge keeps existing card, preference and appearance changes', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'life-save-server-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { server, origin } = await startServer(dataDir);
  t.after(() => stopServer(server));

  const initial = await request(origin, '/api/bootstrap?space=default');
  const originalCard = initial.body.state.cards[0];
  const customCard = { ...originalCard, title: '我改过的默认卡片' };
  await request(origin, '/api/actions', { space: 'default', action: 'upsert_card', requestId: 'migration-card', payload: { card: customCard, expectedCard: originalCard } });
  await request(origin, '/api/actions', { space: 'default', action: 'update_setting', requestId: 'migration-setting', payload: { name: 'sound', value: true } });
  await request(origin, '/api/actions', { space: 'default', action: 'appearance_update', requestId: 'migration-appearance', payload: { appearance: { version: 1, theme: 'rainbow', wallpaper: null } } });

  const sourceState = addEntry(createInitialState(new Date('2026-10-23T04:00:00.000Z')), originalCard.id, new Date('2026-10-23T04:01:00.000Z'), 'migration-history');
  const source = { sourceKey: 'life-save:app-v3:[existing-customizations]', state: sourceState, appearance: createDefaultAppearance() };
  const applied = await request(origin, '/api/migrations/apply', { space: 'default', source, mode: 'merge' });

  assert.equal(applied.status, 200);
  assert.equal(applied.body.state.entries.length, 1);
  assert.equal(applied.body.state.cards[0].title, '我改过的默认卡片');
  assert.equal(applied.body.state.settings.sound, true);
  assert.equal(applied.body.appearance.theme, 'rainbow');
});

test('appearance updates store wallpaper as a file reference', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'life-save-server-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { server, origin } = await startServer(dataDir);
  t.after(() => stopServer(server));

  const appearance = { version: 1, theme: 'rainbow', wallpaper: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'tiny.png', type: 'image/png' } };
  const result = await request(origin, '/api/actions', { space: 'default', action: 'appearance_update', requestId: randomUUID(), payload: { appearance } });
  assert.equal(result.status, 200);
  assert.equal(result.body.appearance.theme, 'rainbow');
  assert.equal(result.body.appearance.wallpaper.name, 'tiny.png');
  const files = await readdir(path.join(dataDir, 'files'));
  assert.equal(files.some(file => file.startsWith('wallpaper-') && file.endsWith('.png')), true);
});
