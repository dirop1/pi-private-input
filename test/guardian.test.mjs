import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Timed out waiting for guardian lifecycle.');
}

// The owner reports the guardian pid as the first stdout line. Spawn failures
// and early exits surface captured output instead of a bare assertion, so a
// transient environment hiccup is diagnosable instead of cryptic.
async function spawnOwner(guardianPath, agentDir, bin) {
  const ownerSource = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[process.argv[1],String(process.pid),process.argv[2]],{stdio:'ignore'}); child.once('error',error=>{console.error('guardian spawn failed: '+((error&&error.code)||error));}); console.log(child.pid); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['-e', ownerSource, guardianPath, agentDir], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  owner.stdout.on('data', chunk => { output.stdout += chunk.toString('utf8'); });
  owner.stderr.on('data', chunk => { output.stderr += chunk.toString('utf8'); });
  const guardianPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for guardian pid. stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`)), 10000);
    const finish = (fn, value) => { clearTimeout(timer); owner.removeListener('exit', onExit); fn(value); };
    const onExit = code => finish(reject, new Error(`Owner exited before reporting a guardian pid (code ${code}). stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`));
    const check = () => {
      const line = output.stdout.split('\n')[0].trim();
      if (/^\d+$/.test(line)) finish(resolve, Number(line));
    };
    owner.once('error', error => finish(reject, error));
    owner.once('exit', onExit);
    owner.stdout.on('data', check);
    check();
  });
  return { owner, guardianPid, output };
}

test('agent guardian cleans up after Pi owner is killed, without touching any external agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'private-guardian-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), agentDir = join(root, 'agent');
  await mkdir(bin, { recursive: true });
  // Fake agent, no real SSH key, agent or credentials are used by this test.
  await writeFile(join(bin, 'ssh-agent'), '#!/bin/bash\ntrap "exit 0" TERM INT\nwhile true; do sleep 0.1; done\n', { mode: 0o700 });
  const guardianPath = fileURLToPath(new URL('../src/agent-guardian.mjs', import.meta.url));
  let owner, guardianPid, output;
  // Spawning can fail transiently under load; the behaviour under test is the
  // guardian cleanup afterwards, so retry owner setup a few times.
  let ready = false, lastError;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    await mkdir(agentDir, { recursive: true });
    try {
      ({ owner, guardianPid, output } = await spawnOwner(guardianPath, agentDir, bin));
      ready = true;
    } catch (error) {
      lastError = error;
      try { owner?.kill('SIGKILL'); } catch {}
      if (guardianPid) { try { process.kill(guardianPid, 'SIGTERM'); } catch {} }
      owner = undefined; guardianPid = undefined;
      await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    }
  }
  if (!ready) throw lastError;
  try {
    assert.ok(Number.isSafeInteger(guardianPid), `guardian pid was not numeric: stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const exited = new Promise(resolve => owner.once('exit', resolve));
    owner.kill('SIGKILL'); await exited;
    await until(async () => { try { await stat(agentDir); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } });
  } finally {
    try { owner?.kill('SIGKILL'); } catch {}
    if (guardianPid) { try { process.kill(guardianPid, 'SIGTERM'); } catch {} }
  }
});
