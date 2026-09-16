import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {SyncDatabase} from './database.ts';

const song = (id: string) => ({
  id,
  songmid: id,
  source: 'wy',
  title: `Song ${id}`,
  singer: 'Artist',
});

const withDatabase = (run: (database: SyncDatabase, userId: string, playlistId: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'ceru-sync-test-'));
  const database = new SyncDatabase(join(directory, 'sync.sqlite'));
  const user = database.createUser({username: `test-${Date.now()}`, passwordHash: 'hash'});
  const playlist = database.createPlaylist(user.id, {
    localId: 'system:favorites',
    title: '我的喜欢',
    semanticType: 'favorites',
    songlist: [song('seed')],
  });
  assert.ok(playlist?.id);

  try {
    run(database, user.id, playlist.id);
  } finally {
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
};

test('cross-device stale add cannot resurrect a later remove', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'seed-add',
      deviceId: 'seed-device',
      sequence: 1,
      occurredAtMs: 1_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:1',
      song: song('1'),
    });
    const removed = database.applySongOperation(userId, {
      operationId: 'phone-remove',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:1',
    });
    assert.equal(removed?.changed, true);

    const delayedAdd = database.applySongOperation(userId, {
      operationId: 'desktop-delayed-add',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 1_500,
      playlistId,
      action: 'add',
      trackKey: 'wy:1',
      song: song('1'),
    });

    assert.equal(delayedAdd?.stale, true);
    assert.equal(database.getPlaylistSongs(userId, playlistId)?.total, 1);
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['seed'],
    );
  });
});

test('playlist detail reuses one converted song array for list and songs', () => {
  withDatabase((database, userId, playlistId) => {
    const detail = database.getPlaylistSongs(userId, playlistId);
    assert.ok(detail);
    assert.strictEqual(detail.list, detail.songs);
    assert.equal(detail.list[0]?.songmid, 'seed');
  });
});

test('waiting for sync events releases immediately when aborted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ceru-sync-abort-test-'));
  const database = new SyncDatabase(join(directory, 'sync.sqlite'));
  const user = database.createUser({username: `abort-${Date.now()}`, passwordHash: 'hash'});
  const controller = new AbortController();

  try {
    const startedAt = Date.now();
    const waiting = database.waitForSyncEvents(user.id, 0, 20_000, controller.signal);
    controller.abort();
    const result = await waiting;
    assert.equal(result.events.length, 0);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a genuinely later add still wins after a remove', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'add-1',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 1_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:2',
      song: song('2'),
    });
    database.applySongOperation(userId, {
      operationId: 'remove-1',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:2',
    });
    const laterAdd = database.applySongOperation(userId, {
      operationId: 'add-2',
      deviceId: 'desktop',
      sequence: 2,
      occurredAtMs: 3_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:2',
      song: song('2'),
    });

    assert.equal(laterAdd?.changed, true);
    assert.equal(laterAdd?.stale, false);
    assert.ok(
      database
        .getPlaylistSongs(userId, playlistId)
        ?.songs.some((item) => item.songmid === '2'),
    );
  });
});

test('favorite snapshots and legacy bulk mutations cannot bypass operation history', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'remove-seed',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:seed',
    });

    database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      songlist: [song('seed'), song('stale')],
    });
    const added = database.addSongs(userId, {playlistId, songlist: [song('legacy')]});
    const removed = database.removeSongs(userId, {playlistId, songmids: ['seed']});

    assert.equal(Boolean(added && 'skipped' in added && added.skipped), true);
    assert.equal(Boolean(removed && 'skipped' in removed && removed.skipped), true);
    assert.equal(database.getPlaylistSongs(userId, playlistId)?.total, 0);
  });
});

test('order-only snapshots can reorder favorites but cannot change membership', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'add-second',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:second',
      song: song('second'),
    });
    database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      orderOnly: true,
      songlist: [song('second'), song('seed')],
    });
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['second', 'seed'],
    );

    database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      orderOnly: true,
      songlist: [song('seed'), song('new')],
    });
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['second', 'seed'],
    );
  });
});


test('plugin operations union music-source scripts by identity and ignore stale later', () => {
  withDatabase((database, userId) => {
    const first = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    const second = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo2"}');
    const added = database.applyPluginOperation(userId, {
      operationId: 'plugin-add-1',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: first.contentHash,
    });
    assert.equal(added?.applied, true);
    const stale = database.applyPluginOperation(userId, {
      operationId: 'plugin-add-stale',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 500,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '0.9.0',
      enabled: false,
      contentHash: second.contentHash,
    });
    assert.equal(stale?.stale, true);
    const items = database.listPlugins(userId);
    assert.equal(items.length, 1);
    assert.equal(items[0].contentHash, first.contentHash);
    assert.equal(items[0].enabled, true);
  });
});

test('capability upsert merges secrets and never stores plaintext in sqlite', () => {
  withDatabase((database, userId) => {
    database.applyPluginOperation(userId, {
      operationId: 'cap-1',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'capability',
      action: 'upsert',
      role: 'feiniu',
      config: {
        host: 'Fn.example.com',
        port: 11443,
        useHttps: true,
        username: 'song',
        password: 'secret-pass',
        accessCode: '1234',
      },
    });
    database.applyPluginOperation(userId, {
      operationId: 'cap-2',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      kind: 'capability',
      action: 'upsert',
      role: 'feiniu',
      config: {
        host: 'fn.example.com',
        port: 11443,
        useHttps: true,
        username: 'song',
        password: '',
        accessCode: '',
      },
    });
    const items = database.listPlugins(userId);
    assert.equal(items.length, 1);
    assert.equal(items[0].identityKey, 'capability:feiniu');
    assert.equal(items[0].config?.password, 'secret-pass');
    assert.equal(items[0].config?.accessCode, '1234');
    const events = database.getSyncEvents(userId, 0).events.filter((event) => event.entityType === 'plugin');
    assert.ok(events.length >= 1);
    const payload = JSON.stringify(events.at(-1)?.payload || {});
    assert.equal(payload.includes('secret-pass'), true);
  });
});

test('identical playlist metadata patches do not advance revision or emit events', () => {
  withDatabase((database, userId, playlistId) => {
    const before = database.getCurrentRevision(userId);
    const updated = database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
    });

    assert.equal(updated?.revision, before);
    assert.equal(database.getCurrentRevision(userId), before);
    assert.equal(database.getSyncEvents(userId, before).events.length, 0);
  });
});

test('identical plugin upserts do not advance revision or emit events', () => {
  withDatabase((database, userId) => {
    const blob = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    const first = database.applyPluginOperation(userId, {
      operationId: 'plugin-first',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    const revisionAfterFirst = database.getCurrentRevision(userId);
    assert.equal(first?.changed, true);

    const duplicate = database.applyPluginOperation(userId, {
      operationId: 'plugin-duplicate',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 2_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });

    assert.equal(duplicate?.changed, false);
    assert.equal(database.getCurrentRevision(userId), revisionAfterFirst);
    assert.equal(database.getSyncEvents(userId, revisionAfterFirst).events.length, 0);
  });
});

test('removing one of several identical music-source scripts hides every copy', () => {
  withDatabase((database, userId) => {
    const blob = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    database.applyPluginOperation(userId, {
      operationId: 'plugin-copy-a',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    database.applyPluginOperation(userId, {
      operationId: 'plugin-copy-b',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'B',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });

    const items = database.listPlugins(userId);
    assert.equal(items.length, 1);
    assert.equal(items[0].contentHash, blob.contentHash);

    const removed = database.applyPluginOperation(userId, {
      operationId: 'plugin-remove-a',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 3_000,
      kind: 'music-source',
      action: 'remove',
      identityKey: items[0].identityKey,
    });

    assert.equal(removed?.changed, true);
    assert.equal(database.listPlugins(userId).length, 0);
    assert.equal(database.listPlugins(userId, {includeDeleted: true}).length, 2);
  });
});

test('old plugin upsert cannot resurrect a later delete, but a newer re-add can', () => {
  withDatabase((database, userId) => {
    const blob = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    const added = database.applyPluginOperation(userId, {
      operationId: 'plugin-add-before-delete',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    assert.equal(added?.changed, true);
    const identityKey = database.listPlugins(userId)[0]?.identityKey || '';
    assert.notEqual(identityKey, '');

    database.applyPluginOperation(userId, {
      operationId: 'plugin-delete-after-add',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 3_000,
      kind: 'music-source',
      action: 'remove',
      identityKey,
    });
    assert.equal(database.listPlugins(userId).length, 0);

    const staleReAdd = database.applyPluginOperation(userId, {
      operationId: 'plugin-old-re-add',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    assert.equal(staleReAdd?.stale, true);
    assert.equal(database.listPlugins(userId).length, 0);

    const newerReAdd = database.applyPluginOperation(userId, {
      operationId: 'plugin-new-re-add',
      deviceId: 'desktop',
      sequence: 2,
      occurredAtMs: 4_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    assert.equal(newerReAdd?.stale, false);
    assert.equal(database.listPlugins(userId).length, 1);
  });
});
