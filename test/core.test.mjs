import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretStore, createAskpass, findKeys, prepareEnvUpdate, redact, run, shellQuote, validateSecret, writeEnvFile } from '../src/core.mjs';

const SECRET = 'synthetic-key-7$#`"\\end';
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pi-private-input-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('opaque handles are one-use; stored buffers are copies and cleared', () => {
  const store = new SecretStore(), value = Buffer.from(SECRET);
  const handle = store.put(value);
  value.fill(0);
  assert.ok(!handle.includes(SECRET));
  const taken = store.take(handle);
  assert.equal(taken.toString(), SECRET);
  assert.throws(() => store.take(handle));
  taken.fill(0);
  store.put(Buffer.from('another-fake-key'));
  store.clear();
  assert.equal(store.size, 0);
  assert.throws(() => validateSecret(Buffer.from('line\nbreak')));
});

test('redacts raw, base64, URL and JSON-escaped echoes, including nested serialized results', () => {
  const value = Buffer.from(SECRET);
  const output = [SECRET, value.toString('base64'), encodeURIComponent(SECRET), JSON.stringify(SECRET).slice(1, -1)].join('\n');
  assert.equal(redact(output, [value]), '[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]');
  assert.ok(!JSON.stringify({ content: redact(output, [value]), details: undefined }).includes('synthetic-key'));
  value.fill(0);
});

test('dotenv update preserves unrelated values and quotes shell metacharacters literally', () => {
  const result = prepareEnvUpdate('OTHER=keep\r\nexport API_KEY=old\r\nAPI_KEY=duplicate\r\n', 'API_KEY', Buffer.from(SECRET));
  assert.equal(result, `OTHER=keep\r\nAPI_KEY='${SECRET}'\r\n`);
  assert.equal(prepareEnvUpdate('', 'TOKEN', Buffer.from('abc')), "TOKEN='abc'\n");
  assert.throws(() => prepareEnvUpdate('', 'BAD;NAME', Buffer.from('abc')));
  assert.throws(() => prepareEnvUpdate('', 'TOKEN', Buffer.from("can't-quote")));
});

test('private env writes are atomic, mode 0600, and reject links', async t => {
  const dir = await temp(t), path = join(dir, '.env');
  await writeFile(path, 'OTHER=keep\n', { mode: 0o644 });
  await writeEnvFile(path, 'API_KEY', Buffer.from(SECRET));
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, 'utf8'), `OTHER=keep\nAPI_KEY='${SECRET}'\n`);
  assert.deepEqual(await readdir(dir), ['.env']);
  await symlink(path, join(dir, 'linked'));
  await assert.rejects(writeEnvFile(join(dir, 'linked'), 'API_KEY', Buffer.from('fake')), /regular file/);
});

test('env and stdin injection do not place the secret in shell source/argv', async () => {
  const value = Buffer.from(SECRET);
  const envCommand = 'process.stdout.write(process.env.PRIVATE_TEST)';
  assert.ok(!envCommand.includes(SECRET));
  const envResult = await run(process.execPath, ['-e', envCommand], { env: { ...process.env, PRIVATE_TEST: SECRET } });
  assert.equal(redact(envResult.stdout, [value]), '[REDACTED]');
  const stdinResult = await run(process.execPath, ['-e', "process.stdin.on('data', data => process.stdout.write(data))"], { input: Buffer.from(SECRET + '\n') });
  assert.equal(redact(stdinResult.stdout, [value]), '[REDACTED]\n');
  value.fill(0);
});

test('overflow withholds all output instead of returning a partial secret', async () => {
  const result = await run(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { maxOutput: 100 });
  assert.equal(result.stdout, '[Output withheld: size limit exceeded.]');
  assert.equal(result.stderr, '');
});

test('execution timeout and cancellation terminate the process group', async () => {
  const timeout = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 });
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.equal((await pending).cancelled, true);
});

test('key discovery reads fingerprints from public keys only and does not read private contents', async t => {
  const dir = await temp(t), calls = [];
  await writeFile(join(dir, 'demo'), 'not-a-real-private-key');
  await writeFile(join(dir, 'demo.pub'), 'not-a-real-public-key');
  await writeFile(join(dir, 'orphan.pub'), 'orphan');
  await writeFile(join(dir, 'demo-cert.pub'), 'certificate');
  const keys = await findKeys(dir, async (program, args) => { calls.push({ program, args }); return { code: 0, stdout: '256 SHA256:FAKE demo (ED25519)\n' }; });
  assert.equal(keys.length, 1);
  assert.equal(calls[0].program, 'ssh-keygen');
  assert.deepEqual(calls[0].args, ['-lf', join(dir, 'demo.pub')]);
});

test('askpass helper transports a synthetic secret over a private channel and removes resources', async () => {
  let prompts = 0;
  const bridge = await createAskpass(async () => { prompts++; return Buffer.from(SECRET); });
  const socket = bridge.env.PI_PRIVATE_SOCKET;
  assert.equal((await lstat(socket)).mode & 0o777, 0o600);
  assert.equal((await lstat(bridge.env.SUDO_ASKPASS)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(bridge.env).includes(SECRET));
  try {
    const result = await run(bridge.env.SUDO_ASKPASS, ['Password:'], { env: bridge.env });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, SECRET);
    assert.equal(redact(result.stdout, bridge.secrets), '[REDACTED]');
    assert.equal(prompts, 1);
    const rejected = await run(bridge.env.SUDO_ASKPASS, ['Password:'], { env: { ...bridge.env, PI_PRIVATE_TOKEN: 'invalid' } });
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, '');
    assert.equal(prompts, 1);
    const held = bridge.secrets[0];
    await bridge.close();
    assert.ok(held.every(byte => byte === 0));
    await assert.rejects(lstat(socket), { code: 'ENOENT' });
  } finally { await bridge.close(); }
});

test('askpass cancellation returns no secret', async () => {
  const bridge = await createAskpass(async () => undefined);
  try {
    const result = await run(bridge.env.SUDO_ASKPASS, ['Password:'], { env: bridge.env });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(bridge.secrets.length, 0);
  } finally { await bridge.close(); }
});

test('remote sudo-style bootstrap consumes authentication input before the approved command', async t => {
  const dir = await temp(t), fakeSudo = join(dir, 'sudo');
  await writeFile(fakeSudo, '#!/bin/bash\nif [[ "$*" == *" -v"* ]]; then IFS= read -r value; [[ "$value" == "$EXPECTED" ]]; else shift 2; "$@"; fi\n', { mode: 0o700 });
  await chmod(fakeSudo, 0o700);
  const command = "printf 'approved-command'; cat";
  const bootstrap = `set +x\nIFS= builtin read -r PRIVATE_PASSWORD\nbuiltin printf '%s\\n' "$PRIVATE_PASSWORD" | sudo -S -v\nresult=$?\nbuiltin unset PRIVATE_PASSWORD\n[ "$result" = 0 ] || exit "$result"\nsudo -n -- bash --noprofile --norc -c ${shellQuote(command)}`;
  const result = await run('bash', ['--noprofile', '--norc', '-c', bootstrap], { input: Buffer.from(SECRET + '\n'), env: { ...process.env, PATH: dir + ':' + process.env.PATH, EXPECTED: SECRET } });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'approved-command');
  assert.ok(!result.stderr.includes(SECRET));
});
