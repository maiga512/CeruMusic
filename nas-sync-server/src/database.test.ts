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
