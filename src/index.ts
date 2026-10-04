import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, CURSOR_MARKER, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretStore, cleanLabel, createAskpass, findKeys, redact, run, shellQuote, validateSecret, writeEnvFile } from './core.mjs';
import { renderPrivatePanel } from './panel.mjs';

// Process-scoped agent ownership survives conversation switches and /reload.
// Secrets and askpass channels are operation/session-scoped, never serialized.
const RUNTIME = Symbol.for('pi-private-input.runtime.v1');
type Runtime = {
  store: InstanceType<typeof SecretStore>;
  busy: boolean;
  abort: AbortController;
  owned?: { guardian: ChildProcess; socket: string; previousSocket?: string; previousPid?: string };
};
const globals = globalThis as typeof globalThis & { [RUNTIME]?: Runtime };

function requireUI(ctx: ExtensionContext) {
  if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Private input requires Pi interactive terminal mode. No plain-input fallback is allowed.');
}

async function secretPrompt(ctx: ExtensionContext, title: string, message: string, signal: AbortSignal): Promise<Buffer | undefined> {
  requireUI(ctx);
  if (signal.aborted) return undefined;
  return ctx.ui.custom<Buffer | undefined>((tui, theme, _keys, done) => {
    const input = new Input();
    let finished = false;
    let validationError: string | undefined;
    const deadline = Date.now() + 120000;
    const finish = (value?: Buffer) => {
      if (finished) { value?.fill(0); return; }
      finished = true;
      clearTimeout(timer);
      clearInterval(ticker);
      signal.removeEventListener('abort', cancel);
      input.setValue('');
      done(value);
    };
    const cancel = () => finish();
    const timer = setTimeout(cancel, 120000);
    const ticker = setInterval(() => { if (!finished) tui.requestRender(); }, 1000);
    signal.addEventListener('abort', cancel, { once: true });
    input.onSubmit = value => {
      const buffer = Buffer.from(value, 'utf8');
      try { validateSecret(buffer); finish(buffer); }
      catch { buffer.fill(0); input.setValue(''); validationError = 'Enter a non-empty, single-line secret (max. 64 KiB).'; tui.requestRender(); }
    };
    input.onEscape = cancel;
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) {
        return renderPrivatePanel({
          width, height: Math.max(5, Math.floor((tui.terminal?.rows || 24) * 0.9) - 2),
          title, message, length: input.getValue().length, focused: input.focused,
          seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), error: validationError,
        }, { theme, truncateToWidth, visibleWidth, wrapTextWithAnsi, cursorMarker: CURSOR_MARKER });
      },
      handleInput(data: string) { validationError = undefined; input.handleInput(data); tui.requestRender(); },
      invalidate() { input.invalidate(); },
    };
  }, { overlay: true, overlayOptions: { anchor: 'center', width: 72, maxHeight: '90%', margin: { left: 2, right: 2, top: 1, bottom: 1 } } });
}

function safeResult(message: string, isError = false) {
  return { content: [{ type: 'text' as const, text: message }], details: undefined, ...(isError ? { isError: true } : {}) };
}
function commandResult(result: Awaited<ReturnType<typeof run>>, secrets: Buffer[]) {
  const status = result.cancelled ? 'Cancelled' : result.timedOut ? 'Timed out' : `Exit ${result.code ?? 'unknown'}`;
  const text = [status, result.stdout, result.stderr].filter(Boolean).join('\n');
  return safeResult(redact(text, secrets), result.code !== 0 || result.cancelled || result.timedOut);
}

export default function privateInput(pi: ExtensionAPI) {
  const state = globals[RUNTIME] ??= { store: new SecretStore(), busy: false, abort: new AbortController() };
  let epoch = 0;
  pi.on('session_start', () => { if (state.abort.signal.aborted) state.abort = new AbortController(); });
  pi.on('session_shutdown', () => { epoch++; state.abort.abort(); state.store.clear(); });

  async function operation(ctx: ExtensionContext, signal: AbortSignal | undefined, callback: (active: AbortSignal) => Promise<ReturnType<typeof safeResult>>) {
    try { requireUI(ctx); } catch { return safeResult('Private input requires interactive terminal mode.', true); }
    if (state.busy) return safeResult('Another private-input operation is active. Wait for it to finish.', true);
    state.busy = true;
    const current = epoch;
    const active = signal ? AbortSignal.any([signal, state.abort.signal]) : state.abort.signal;
    try {
      if (active.aborted) return safeResult('Operation cancelled.', true);
      const result = await callback(active);
      return current === epoch && !active.aborted ? result : safeResult('Operation cancelled.', true);
    } catch {
      // Exceptions can include filesystem contents, child errors or credentials.
      // Do not serialize exception messages, stacks or arbitrary error details.
      return safeResult('Private operation failed. Check the destination/executable and try again; no credential was returned.', true);
    } finally { state.busy = false; }
  }

  async function ensureAgent(active: AbortSignal) {
    const existing = await run('ssh-add', ['-l'], { signal: active, timeout: 5000 });
    if (existing.code === 0 || existing.code === 1) return;
    if (state.owned) {
      state.owned.guardian.kill('SIGTERM'); state.owned = undefined;
    }
    const directory = await mkdtemp(join(tmpdir(), 'pi-private-agent-'));
    await chmod(directory, 0o700);
    const previousSocket = process.env.SSH_AUTH_SOCK, previousPid = process.env.SSH_AGENT_PID;
    const socket = join(directory, 'agent.sock');
    const guardian = spawn(process.execPath, [fileURLToPath(new URL('./agent-guardian.mjs', import.meta.url)), String(process.pid), directory], { stdio: 'ignore' });
    let failed = false;
    guardian.once('error', () => { failed = true; });
    guardian.once('exit', () => {
      failed = true;
      if (state.owned?.guardian === guardian) {
        state.owned = undefined;
        if (process.env.SSH_AUTH_SOCK === socket) {
          if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK;
          else process.env.SSH_AUTH_SOCK = previousSocket;
          if (previousPid === undefined) delete process.env.SSH_AGENT_PID;
          else process.env.SSH_AGENT_PID = previousPid;
        }
      }
    });
    try {
      let ready = false;
      for (let i = 0; i < 40 && !failed && !active.aborted; i++) {
        const check = await run('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: socket }, signal: active, timeout: 1000 });
        if (check.code === 0 || check.code === 1) { ready = true; break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      if (!ready) throw new Error('Agent unavailable.');
      state.owned = { guardian, socket, previousSocket, previousPid };
      process.env.SSH_AUTH_SOCK = socket;
      delete process.env.SSH_AGENT_PID;
      guardian.unref();
      process.once('exit', () => { guardian.kill('SIGTERM'); });
    } catch {
      guardian.kill('SIGTERM'); await rm(directory, { recursive: true, force: true }); throw new Error('Unable to start a private SSH agent.');
    }
  }

  async function unlock(ctx: ExtensionContext, active: AbortSignal) {
    const keys = await findKeys();
    if (!keys.length) return safeResult('No key pairs with matching .pub files found in ~/.ssh.', true);
    let key = keys[0];
    if (keys.length > 1) {
      const selected = await ctx.ui.select('Select SSH key to load', keys.map(item => item.label), { signal: active });
      if (!selected) return safeResult('SSH unlock cancelled.');
      key = keys.find(item => item.label === selected)!;
    }
    if (!await ctx.ui.confirm('Load SSH key?', `${key.label}\nThe key becomes available to SSH/Git in this Pi process. An inherited/shared agent is not cleared when Pi exits.`, { signal: active })) return safeResult('SSH unlock cancelled.');
    await ensureAgent(active);
    const bridge = await createAskpass(prompt => secretPrompt(ctx, 'SSH key passphrase', prompt, active), { signal: active });
    try {
      const result = await run('ssh-add', [key.path], { env: bridge.env, signal: active });
      // ssh-add diagnostics reveal key paths/comments; return fixed state only.
      return result.code === 0 ? safeResult('SSH key loaded. SSH/Git can use it in this Pi process.') : safeResult('SSH key was not loaded. Cancelled, incorrect passphrase or unsupported authentication.', true);
    } finally { await bridge.close(); }
  }

  async function sudo(ctx: ExtensionContext, active: AbortSignal, command: string | undefined, host?: string, reason?: string) {
    if (host && (!/^[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*$/.test(host) || host.startsWith('-'))) return safeResult('Invalid SSH destination. Use a host alias or user@host.', true);
    if (!await ctx.ui.confirm(command ? 'Allow privileged command?' : 'Authenticate sudo?', `${host ? `Remote: ${host}` : 'Local machine'}\n${command || 'sudo -v (authentication only)'}\n${reason ? `Reason: ${cleanLabel(reason)}\n` : ''}Authentication does not authorize other commands.`, { signal: active })) return safeResult('Sudo request cancelled.');
    if (host) {
      // The password is consumed by a fixed bootstrap, never by the approved
      // command's stdin. Shell tracing/startup injection is disabled remotely.
      const password = await secretPrompt(ctx, 'Remote sudo password', `Destination: ${host}`, active);
      if (!password) return safeResult('Sudo request cancelled.');
      const input = Buffer.concat([password, Buffer.from('\n')]);
      const bootstrap = [
        'set +x',
        'IFS= builtin read -r PRIVATE_SUDO_PASSWORD || exit 1',
        "builtin printf '%s\\n' \"$PRIVATE_SUDO_PASSWORD\" | sudo -S -p '' -v",
        'result=$?',
        'builtin unset PRIVATE_SUDO_PASSWORD',
        '[ "$result" = 0 ] || exit "$result"',
        command ? `sudo -n -- bash --noprofile --norc -c ${shellQuote(command)}` : 'true',
      ].join('\n');
      const remote = `env -u BASH_ENV -u SHELLOPTS -u BASHOPTS bash --noprofile --norc -c ${shellQuote(bootstrap)}`;
      try {
        const result = await run('ssh', ['-T', '-o', 'BatchMode=yes', host, remote], { cwd: ctx.cwd, input, signal: active });
        return commandResult(result, [password]);
      } finally { input.fill(0); password.fill(0); }
    }
    const bridge = await createAskpass(prompt => secretPrompt(ctx, 'Sudo password', prompt, active), { signal: active });
    try {
      const args = command ? ['-A', '--', 'bash', '--noprofile', '--norc', '-c', command] : ['-A', '-v'];
      const env = { ...bridge.env }; delete env.BASH_ENV;
      const result = await run('sudo', args, { cwd: ctx.cwd, env, signal: active });
      if (!command) return result.code === 0 ? safeResult('Sudo authentication succeeded. Cache scope/expiry follows the machine policy; other shells may still need authentication.') : safeResult('Sudo authentication failed or was cancelled.', true);
      return commandResult(result, bridge.secrets);
    } finally { await bridge.close(); }
  }

  pi.registerTool({
    name: 'private_input', label: 'Private Input',
    description: 'Ask the user for a secret in a private masked terminal modal. Returns a one-use opaque handle, never the secret. Do not ask the user to paste credentials into chat. Use private_apply to write/inject the handle.',
    parameters: Type.Object({ label: Type.String({ maxLength: 200, description: 'Public purpose/name only, never a secret.' }) }),
    async execute(_id, params, signal, _update, ctx) {
      return operation(ctx, signal, async active => {
        const value = await secretPrompt(ctx, 'Private input', params.label, active);
        if (!value) return safeResult('Private input cancelled.');
        try { return safeResult(`Private input ready: ${state.store.put(value)}\nUse this handle once with private_apply. It expires on reload or conversation change.`); }
        finally { value.fill(0); }
      });
    },
  });

  pi.registerTool({
    name: 'private_apply', label: 'Use Private Input',
    description: 'Use a one-use private_input handle, with user confirmation: write an env variable to a dotenv file, inject an env variable into one command, or send the secret plus newline to stdin. Never interpolate the secret into shell source or print it for the model. Outputs mask common echoes; this is not a sandbox.',
    parameters: Type.Object({
      handle: Type.String(), mode: Type.Union([Type.Literal('write-env'), Type.Literal('run-env'), Type.Literal('run-stdin')]),
      path: Type.Optional(Type.String()), variable: Type.Optional(Type.String()), command: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      return operation(ctx, signal, async active => {
        if (params.mode === 'write-env' && (!params.path || !params.variable)) return safeResult('write-env requires path and variable.', true);
        if (params.mode !== 'write-env' && !params.command) return safeResult('Command required.', true);
        if (params.mode !== 'run-stdin' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.variable || '')) return safeResult('Invalid variable name.', true);
        const target = params.mode === 'write-env' ? resolve(ctx.cwd, params.path!) : params.command!;
        if (!await ctx.ui.confirm('Use private input?', `${params.mode}\n${target}\n${params.variable ? `Variable: ${params.variable}\n` : ''}The secret is consumed once and is not returned. ${params.mode === 'write-env' ? 'The destination file will contain the secret (mode 0600).' : 'The approved command will receive the secret.'}`, { signal: active })) return safeResult('Private input use cancelled.');
        const value = state.store.take(params.handle);
        let input: Buffer | undefined;
        try {
          if (params.mode === 'write-env') {
            await withFileMutationQueue(target, () => writeEnvFile(target, params.variable, value));
            return safeResult('Private environment variable configured. No value or diff returned.');
          }
          const env = { ...process.env }; delete env.BASH_ENV;
          if (params.mode === 'run-env') env[params.variable!] = value.toString('utf8');
          else input = Buffer.concat([value, Buffer.from('\n')]);
          const result = await run('bash', ['--noprofile', '--norc', '-c', params.command!], { cwd: ctx.cwd, env, input, signal: active });
          return commandResult(result, [value]);
        } finally { input?.fill(0); value.fill(0); }
      });
    },
  });

  pi.registerTool({
    name: 'ssh_unlock', label: 'Unlock SSH Key',
    description: 'Explicitly ask the user to select/load a local SSH key for Git/SSH. A private modal sends the passphrase only to ssh-add. Reuses an accessible agent, even when empty; otherwise starts a Pi-owned agent. Never retry failed SSH operations automatically.',
    parameters: Type.Object({}),
    execute(_id, _params, signal, _update, ctx) { return operation(ctx, signal, active => unlock(ctx, active)); },
  });
  pi.registerTool({
    name: 'sudo_exec', label: 'Privileged Command',
    description: 'Run an explicitly user-approved sudo command locally or on a POSIX SSH host. Credentials are entered privately and not cached by this extension. Remote SSH must already authenticate non-interactively (use ssh_unlock first). Use this instead of guessing credentials or repeatedly trying sudo in bash.',
    parameters: Type.Object({ command: Type.String(), host: Type.Optional(Type.String()), reason: Type.String({ description: 'Public explanation; no credentials.' }) }),
    execute(_id, params, signal, _update, ctx) { return operation(ctx, signal, active => sudo(ctx, active, params.command, params.host, params.reason)); },
  });

  pi.registerCommand('private-input', {
    description: 'Collect a private one-use input, or forget retained inputs with /private-input forget',
    async handler(args, ctx) {
      if (args.trim() === 'forget') { state.store.clear(); ctx.ui.notify('Private inputs forgotten.', 'info'); return; }
      const result = await operation(ctx, undefined, async active => {
        const label = args.trim() || 'Credential or API key';
        const value = await secretPrompt(ctx, 'Private input', label, active);
        if (!value) return safeResult('Private input cancelled.');
        try { return safeResult(`Private input ready: ${state.store.put(value)}\nPass only this handle to the agent, never the secret.`); }
        finally { value.fill(0); }
      });
      ctx.ui.notify(result.content[0].text, result.isError ? 'error' : 'info');
    },
  });
  pi.registerCommand('ssh-unlock', {
    description: 'Select and load an SSH key without putting the passphrase in chat',
    async handler(_args, ctx) { const result = await operation(ctx, undefined, active => unlock(ctx, active)); ctx.ui.notify(result.content[0].text, result.isError ? 'error' : 'info'); },
  });
  pi.registerCommand('sudo-auth', {
    description: 'Privately authenticate sudo: /sudo-auth [SSH host]; cache scope follows the machine policy',
    async handler(args, ctx) { const result = await operation(ctx, undefined, active => sudo(ctx, active, undefined, args.trim() || undefined)); ctx.ui.notify(result.content[0].text, result.isError ? 'error' : 'info'); },
  });
}
