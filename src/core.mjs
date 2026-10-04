import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, lstat, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_SECRET_BYTES = 65536;
export function validateSecret(secret) {
  if (!Buffer.isBuffer(secret) || !secret.length || secret.length > MAX_SECRET_BYTES || secret.includes(0) || secret.includes(10) || secret.includes(13)) {
    throw new Error('Enter a non-empty, single-line secret (maximum 64 KiB).');
  }
}
export function cleanLabel(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
}
export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export class SecretStore {
  #values = new Map();
  put(value) {
    validateSecret(value);
    if (this.#values.size >= 32) throw new Error('Too many private inputs. Forget unused inputs first.');
    const handle = `private:${randomBytes(16).toString('hex')}`;
    this.#values.set(handle, Buffer.from(value));
    return handle;
  }
  take(handle) {
    const value = this.#values.get(handle);
    if (!value) throw new Error('Private input is unavailable. Request it again.');
    this.#values.delete(handle);
    return value;
  }
  clear() { for (const value of this.#values.values()) value.fill(0); this.#values.clear(); }
  get size() { return this.#values.size; }
}

// Defense against common accidental echoes, not arbitrary secret transformations.
export function redact(value, secrets) {
  let text = String(value);
  const patterns = [];
  for (const secret of secrets) {
    if (!secret?.length) continue;
    const raw = secret.toString('utf8');
    patterns.push(raw, secret.toString('base64'), encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1), raw.replaceAll("'", "'\\''"));
  }
  for (const pattern of [...new Set(patterns)].sort((a, b) => b.length - a.length)) {
    if (pattern) text = text.split(pattern).join('[REDACTED]');
  }
  return text;
}

export async function run(program, args, { cwd, env = process.env, input, signal, timeout = 120000, maxOutput = 1024 * 1024 } = {}) {
  if (signal?.aborted) throw new Error('Operation cancelled.');
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stdout = [], stderr = [];
    let bytes = 0, overflow = false, cancelled = false, timedOut = false;
    const kill = (kind) => {
      if (kind === 'timeout') timedOut = true;
      else cancelled = true;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
      forceTimer = setTimeout(() => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      }, 1000);
      forceTimer.unref();
    };
    let forceTimer;
    const timer = setTimeout(() => kill('timeout'), timeout); timer.unref();
    const onAbort = () => kill('cancel');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutput) { overflow = true; stdout.length = 0; stderr.length = 0; }
      if (!overflow) target.push(chunk);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const cleanup = () => { clearTimeout(timer); if (!cancelled && !timedOut) clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', () => { cleanup(); reject(new Error('Unable to start the requested executable.')); });
    child.once('close', (code) => {
      cleanup();
      resolveResult({ code, cancelled, timedOut, stdout: overflow ? '[Output withheld: size limit exceeded.]' : Buffer.concat(stdout).toString('utf8'), stderr: overflow ? '' : Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export function prepareEnvUpdate(text, name, secret) {
  validateSecret(secret);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment variable name.');
  // Single quotes preserve $, #, backticks and backslashes in common dotenv parsers.
  // Embedded quotes differ between dotenv dialects: reject rather than guess.
  const raw = secret.toString('utf8');
  if (raw.includes("'")) throw new Error('This secret cannot be safely written with the supported dotenv quoting. Use environment injection instead.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const assignment = `${name}='${raw}'`;
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const updated = lines.flatMap(line => {
    if (!matcher.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    return [assignment];
  });
  if (!replaced) {
    if (updated.at(-1) === '') updated.pop();
    updated.push(assignment, '');
  }
  return updated.join(eol);
}

export async function writeEnvFile(path, name, secret) {
  const target = resolve(path);
  let previous = '';
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Destination must be a regular file, not a link.');
    previous = await readFile(target, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const content = prepareEnvUpdate(previous, name, secret);
  const temporary = join(dirname(target), `.private-input-${randomBytes(12).toString('hex')}`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content); await file.sync(); await file.close(); file = undefined;
    await rename(temporary, target);
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}

export async function findKeys(directory = join(homedir(), '.ssh'), runner = run) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const keys = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.pub') || name.endsWith('-cert.pub')) continue;
    const path = join(directory, name.slice(0, -4));
    try {
      if (!(await stat(path)).isFile()) continue;
      const fingerprint = await runner('ssh-keygen', ['-lf', `${path}.pub`], { timeout: 5000 });
      if (fingerprint.code === 0) keys.push({ path, label: `${name.slice(0, -4)} — ${cleanLabel(fingerprint.stdout.trim())}` });
    } catch {}
  }
  return keys;
}

export async function createAskpass(prompt, { signal } = {}) {
  if (process.platform === 'win32') throw new Error('Use WSL; native Windows is not supported in this first version.');
  const dir = await mkdtemp(join(tmpdir(), 'pi-private-askpass-'));
  await chmod(dir, 0o700);
  const socketPath = join(dir, 's');
  const token = randomBytes(32).toString('hex');
  const launcher = join(dir, 'askpass');
  const file = await open(launcher, 'wx', 0o700);
  await file.writeFile(`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('./askpass.mjs', import.meta.url)))} "$@"\n`);
  await file.close();
  const secrets = [], sockets = new Set();
  let pending = false, attempts = 0, closed = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(120000, () => socket.destroy());
    let data = '', handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      data += chunk.toString('utf8');
      if (data.length > 8192) { handled = true; socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      let secret, ownsPrompt = false;
      try {
        const request = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (request.token !== token || pending || closed || signal?.aborted || ++attempts > 3) { socket.end(); return; }
        pending = true; ownsPrompt = true;
        secret = await prompt(cleanLabel(request.prompt || 'Authentication required'));
        if (!secret || closed || signal?.aborted) { socket.end(); return; }
        validateSecret(secret);
        secrets.push(Buffer.from(secret));
        socket.end(secret);
      } catch { socket.end(); }
      finally { secret?.fill(0); if (ownsPrompt) pending = false; }
    });
  });
  try {
    await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(socketPath, resolveReady); });
    await chmod(socketPath, 0o600);
  } catch { server.close(); await rm(dir, { recursive: true, force: true }); throw new Error('Unable to create the private authentication channel.'); }
  const onAbort = () => { for (const socket of sockets) socket.destroy(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    env: { ...process.env, SSH_ASKPASS: launcher, SSH_ASKPASS_REQUIRE: 'force', SUDO_ASKPASS: launcher, PI_PRIVATE_SOCKET: socketPath, PI_PRIVATE_TOKEN: token },
    secrets,
    async close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolveClosed => server.close(resolveClosed));
      for (const secret of secrets) secret.fill(0);
      secrets.length = 0;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
