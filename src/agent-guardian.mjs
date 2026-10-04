import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

// Private agent ownership follows the Pi process, not a conversation/reload.
// The guardian also cleans up if Pi is killed without running its exit hooks.
const [ownerText, dir] = process.argv.slice(2);
const owner = Number(ownerText);
if (!Number.isSafeInteger(owner) || owner <= 1 || !dir) process.exit(1);
const agent = spawn('ssh-agent', ['-D', '-a', join(dir, 'agent.sock')], { stdio: 'ignore' });
let stopping = false;
const finish = () => { clearInterval(watch); rmSync(dir, { recursive: true, force: true }); };
const stop = () => {
  if (stopping) return;
  stopping = true;
  agent.kill('SIGTERM');
  setTimeout(() => agent.kill('SIGKILL'), 1000).unref();
};
const watch = setInterval(() => {
  // A reparented guardian must not trust a reused PID belonging to another Pi.
  if (process.ppid !== owner) { stop(); return; }
  try { process.kill(owner, 0); } catch { stop(); }
}, 1000);
agent.once('error', () => { finish(); process.exitCode = 1; });
agent.once('exit', finish);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
