#!/usr/bin/env node
import { createConnection } from 'node:net';

// Only stdout connects to OpenSSH/sudo. Never log prompts, responses or errors.
const socketPath = process.env.PI_PRIVATE_SOCKET;
const token = process.env.PI_PRIVATE_TOKEN;
if (!socketPath || !token) process.exit(1);
const socket = createConnection(socketPath);
const chunks = [];
let bytes = 0;
const fail = () => { for (const chunk of chunks) chunk.fill(0); socket.destroy(); process.exitCode = 1; };
socket.setTimeout(120000, fail);
socket.on('error', fail);
socket.on('connect', () => socket.write(JSON.stringify({ token, prompt: process.argv[2] || 'Authentication required' }) + '\n'));
socket.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 65536) { chunk.fill(0); fail(); return; }
  chunks.push(chunk);
});
socket.on('end', () => {
  if (!bytes || process.exitCode === 1) { fail(); return; }
  const answer = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  process.stdout.write(answer, () => answer.fill(0));
});
