import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Node loads a local env file and exported variables retain precedence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'commuteguard-env-test-'));
  try {
    const file = join(directory, '.env.local');
    writeFileSync(file, 'MTA_BUS_TIME_API_KEY=fixture-only-not-real\n');
    for (const inherited of [false, true]) {
      const expected = inherited ? 'exported-fixture-only' : 'fixture-only-not-real';
      const child = spawnSync(process.execPath, [`--env-file-if-exists=${file}`, '--eval',
        `process.exit(process.env.MTA_BUS_TIME_API_KEY === ${JSON.stringify(expected)} ? 0 : 1)`], {
        env: { NODE_ENV: 'test', ...(inherited ? { MTA_BUS_TIME_API_KEY: expected } : {}) }, encoding: 'utf8',
      });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, '');
      assert.equal(child.stderr, '');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
