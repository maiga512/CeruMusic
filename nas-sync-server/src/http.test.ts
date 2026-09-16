import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {SyncDatabase} from './database.ts';
import {createSyncServer} from './http.ts';
import {MAX_PLUGIN_SCRIPT_BYTES} from './pluginIdentity.ts';

test('oversized request bodies are rejected before reading them into memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ceru-sync-http-test-'));
  const database = new SyncDatabase(join(directory, 'sync.sqlite'));
  const server = createSyncServer({database, host: '127.0.0.1', port: 0});

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/register`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        username: 'a',
        password: 'b',
        padding: 'x'.repeat(MAX_PLUGIN_SCRIPT_BYTES + 128 * 1024),
      }),
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
