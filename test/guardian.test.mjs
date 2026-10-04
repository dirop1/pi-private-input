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

test('agent guardian cleans up after Pi owner is killed, without touching any external agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'private-guardian-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), agentDir = join(root, 'agent');
  await mkdir(bin); await mkdir(agentDir);
  // Fake agent, no real SSH key, agent or credentials are used by this test.
  await writeFile(join(bin, 'ssh-agent'), '#!/bin/bash\ntrap "exit 0" TERM INT\nwhile true; do sleep 0.1; done\n', { mode: 0o700 });
  const guardianPath = fileURLToPath(new URL('../src/agent-guardian.mjs', import.meta.url));
  const ownerSource = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[process.argv[1],String(process.pid),process.argv[2]],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['-e', ownerSource, guardianPath, agentDir], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let guardianPid;
  try {
    guardianPid = await new Promise((resolve, reject) => { owner.stdout.once('data', data => resolve(Number(data.toString().trim()))); owner.once('error', reject); });
    assert.ok(Number.isSafeInteger(guardianPid));
    await new Promise(resolve => setTimeout(resolve, 150));
    const exited = new Promise(resolve => owner.once('exit', resolve));
    owner.kill('SIGKILL'); await exited;
    await until(async () => { try { await stat(agentDir); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } });
  } finally {
    owner.kill('SIGKILL');
    if (guardianPid) { try { process.kill(guardianPid, 'SIGTERM'); } catch {} }
  }
});
