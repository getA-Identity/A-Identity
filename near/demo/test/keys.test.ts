import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, test } from 'node:test';
import { describeKey, EXPOSED_PUBLIC_KEYS, findKey, isPrivateMode, readKeyFile, revokedKeys } from '../lib/keys.ts';

// Fake key material: the right prefix, but "-" is not base58, so it can never be a key and the
// repository's gitleaks rule for NEAR secret keys has nothing to match.
const SECRET = 'ed25519:FAKE-secret-for-tests-only';
const PUBLIC = 'ed25519:FAKE-public-for-tests';

function writeKey(dir: string, name: string, body: Record<string, unknown>, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  chmodSync(path, mode);
  return path;
}

describe('key files', () => {
  test('mode: group or other bits refuse the file', () => {
    assert.equal(isPrivateMode(0o100600), true);
    assert.equal(isPrivateMode(0o100400), true);
    assert.equal(isPrivateMode(0o100644), false);
    assert.equal(isPrivateMode(0o100640), false);
  });

  test('a 0600 legacy keychain file loads; the secret never serializes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    const path = writeKey(dir, 'k.json', { account_id: 'vault.aid-demo-owner.testnet', public_key: PUBLIC, private_key: SECRET, master_seed_phrase: 'never read' });
    const r = readKeyFile(path, 'agent', 'vault.aid-demo-owner.testnet');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.key.publicKey, PUBLIC);
    assert.equal(r.key.secret(), SECRET);
    assert.ok(!JSON.stringify(r.key).includes(SECRET), 'JSON.stringify drops the secret');
    assert.ok(!inspect(r.key, { depth: 5 }).includes(SECRET), 'util.inspect does not show it');
    assert.ok(!describeKey(r.key).includes(SECRET));
    assert.ok(!JSON.stringify(r.key).includes('never read'), 'the seed phrase is never copied');
  });

  test('a 0644 file is refused with the chmod fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    const path = writeKey(dir, 'k.json', { account_id: 'a.testnet', public_key: PUBLIC, private_key: SECRET }, 0o644);
    const r = readKeyFile(path, 'owner', 'a.testnet');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /chmod 600/);
    assert.ok(!(r.ok ? '' : r.reason).includes(SECRET));
  });

  test('a key for another account is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    const path = writeKey(dir, 'k.json', { account_id: 'other.testnet', public_key: PUBLIC, private_key: SECRET });
    const r = readKeyFile(path, 'owner', 'a.testnet');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /expected a\.testnet/);
  });

  test('findKey: the env path is the only place looked at when set', () => {
    const r = findKey('oracle', 'oracle.a-identity.testnet', { AID_ORACLE_KEY_FILE: '/nonexistent/oracle.json', NEAR_CREDENTIALS_DIR: '/nonexistent' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok ? [] : r.tried, ['/nonexistent/oracle.json']);
  });

  test('findKey: the legacy keychain layout, deduplicated by public key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-cred-'));
    const body = { account_id: 'aid-demo-owner.testnet', public_key: PUBLIC, private_key: SECRET };
    writeKey(dir, 'aid-demo-owner.testnet.json', body);
    mkdirSync(join(dir, 'aid-demo-owner.testnet'));
    writeKey(join(dir, 'aid-demo-owner.testnet'), 'ed25519_x.json', body);
    const r = findKey('owner', 'aid-demo-owner.testnet', { NEAR_CREDENTIALS_DIR: dir });
    assert.equal(r.ok, true);
  });

  test('findKey: two different keys need a choice, unless the on-chain list narrows them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-cred-'));
    mkdirSync(join(dir, 'vault.aid-demo-owner.testnet'));
    writeKey(join(dir, 'vault.aid-demo-owner.testnet'), 'a.json', { account_id: 'vault.aid-demo-owner.testnet', public_key: PUBLIC, private_key: SECRET });
    writeKey(join(dir, 'vault.aid-demo-owner.testnet'), 'b.json', { account_id: 'vault.aid-demo-owner.testnet', public_key: 'ed25519:Old', private_key: SECRET });
    const many = findKey('agent', 'vault.aid-demo-owner.testnet', { NEAR_CREDENTIALS_DIR: dir });
    assert.equal(many.ok, false);
    assert.match(many.ok ? '' : many.reason, /AID_AGENT_KEY_FILE/);
    const one = findKey('agent', 'vault.aid-demo-owner.testnet', { NEAR_CREDENTIALS_DIR: dir }, [PUBLIC]);
    assert.equal(one.ok && one.key.publicKey, PUBLIC);
  });

  test('findKey: nothing there is a clean answer, not a throw', () => {
    const r = findKey('agent', 'vault.aid-demo-owner.testnet', { NEAR_CREDENTIALS_DIR: mkdtempSync(join(tmpdir(), 'aid-empty-')) });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /no key file/);
  });
});

describe('exposed keys', () => {
  // The exposed owner key's PUBLIC half (public, nothing secret), with a fake secret beside it.
  const EXPOSED = Object.keys(EXPOSED_PUBLIC_KEYS)[0] ?? '';

  test('a key file holding an exposed public key is refused, whatever its mode or path', () => {
    assert.match(EXPOSED, /^ed25519:/);
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    const path = writeKey(dir, 'owner.json', { account_id: 'aid-demo-owner.testnet', public_key: EXPOSED, private_key: SECRET });
    const r = readKeyFile(path, 'owner', 'aid-demo-owner.testnet');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /never signs with/);
    assert.ok(!(r.ok ? '' : r.reason).includes(SECRET));
    const viaEnv = findKey('owner', 'aid-demo-owner.testnet', { AID_OWNER_KEY_FILE: path });
    assert.equal(viaEnv.ok, false, 'naming the file does not get around it');
  });

  test('the keychain: the exposed key is passed over and a rotated key is used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-cred-'));
    writeKey(dir, 'aid-demo-owner.testnet.json', { account_id: 'aid-demo-owner.testnet', public_key: EXPOSED, private_key: SECRET });
    mkdirSync(join(dir, 'aid-demo-owner.testnet'));
    writeKey(join(dir, 'aid-demo-owner.testnet'), 'ed25519_new.json', { account_id: 'aid-demo-owner.testnet', public_key: PUBLIC, private_key: SECRET });
    const r = findKey('owner', 'aid-demo-owner.testnet', { NEAR_CREDENTIALS_DIR: dir });
    assert.equal(r.ok && r.key.publicKey, PUBLIC);
    const only = mkdtempSync(join(tmpdir(), 'aid-cred-'));
    writeKey(only, 'aid-demo-owner.testnet.json', { account_id: 'aid-demo-owner.testnet', public_key: EXPOSED, private_key: SECRET });
    const none = findKey('owner', 'aid-demo-owner.testnet', { NEAR_CREDENTIALS_DIR: only });
    assert.equal(none.ok, false, 'with only the exposed key there is no owner key: owner writes become prepared calls');
  });

  test('AID_REVOKED_KEYS adds keys to refuse', () => {
    assert.equal(revokedKeys({ AID_REVOKED_KEYS: ` ${PUBLIC} ,` }).get(PUBLIC), 'listed in AID_REVOKED_KEYS');
    const dir = mkdtempSync(join(tmpdir(), 'aid-keys-'));
    const path = writeKey(dir, 'k.json', { account_id: 'a.testnet', public_key: PUBLIC, private_key: SECRET });
    assert.equal(findKey('owner', 'a.testnet', { AID_OWNER_KEY_FILE: path, AID_REVOKED_KEYS: PUBLIC }).ok, false);
    assert.equal(findKey('owner', 'a.testnet', { AID_OWNER_KEY_FILE: path }).ok, true);
  });

  test('a key path under the home folder is shown as ~/..., never as one machine\'s absolute path', () => {
    const key = { role: 'owner' as const, accountId: 'a.testnet', publicKey: PUBLIC, path: join(homedir(), '.near-credentials', 'testnet', 'a.testnet.json'), secret: () => SECRET };
    assert.equal(describeKey(key), `a.testnet ${PUBLIC} (~/.near-credentials/testnet/a.testnet.json)`);
  });
});
