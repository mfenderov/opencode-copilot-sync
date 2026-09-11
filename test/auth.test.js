import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStoredOpenCodeKey } from '../out/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('getStoredOpenCodeKey finds key in opencode auth file if it exists', () => {
  const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (fs.existsSync(authPath)) {
    const key = getStoredOpenCodeKey();
    assert.ok(typeof key === 'string');
    assert.ok(key.startsWith('sk-'));
  }
});

test('getStoredOpenCodeKey returns null if file does not exist', () => {
  const key = getStoredOpenCodeKey('/non/existent/path/auth.json');
  assert.equal(key, null);
});
