// Minimal client for `codex app-server`: the official Codex CLI's JSON-RPC protocol over stdio
// (one JSON object per line, the same channel the Codex IDE extensions use). Only what the codex
// backend needs: requests with replies, notifications, and server -> client requests (approvals,
// dynamic tool calls). Protocol reference: `codex app-server generate-ts --experimental`.
//
// One client = one app-server process. The codex backend starts one per agent turn, with that
// agent's environment (git identity, git safety), so every command the agent runs inherits it.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface CodexCommand {
  command: string;
  /** arguments before `app-server` (e.g. the codex.js launcher script) */
  args: string[];
}

/**
 * How to start the Codex CLI without a shell: an explicit `--codex-bin`, else `codex` on PATH. On
 * Windows the npm install is a `codex.cmd` shim, which Node cannot spawn without cmd.exe; its
 * launcher script (node_modules/@openai/codex/bin/codex.js) is run with this Node instead.
 */
export function resolveCodexCommand(explicit?: string, env: NodeJS.ProcessEnv = process.env): CodexCommand {
  const viaNode = (js: string): CodexCommand => ({ command: process.execPath, args: [js] });
  if (explicit) return /\.(c|m)?js$/i.test(explicit) ? viaNode(explicit) : { command: explicit, args: [] };
  if (process.platform !== 'win32') return { command: 'codex', args: [] };
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const d of dirs) {
    if (fs.existsSync(path.join(d, 'codex.exe'))) return { command: path.join(d, 'codex.exe'), args: [] };
    const js = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(path.join(d, 'codex.cmd')) && fs.existsSync(js)) return viaNode(js);
  }
  return { command: 'codex.exe', args: [] };
}

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => void;

export interface AppServerOptions {
  cmd: CodexCommand;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** stderr lines (debug logging) */
  onStderr?: (line: string) => void;
}

export class AppServerClient {
  readonly child: ChildProcess;
  readonly spawnedAt = Date.now();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private anyNotification: Array<(method: string, params: unknown) => void> = [];
  private closedError: Error | undefined;
  /** settles when the process has exited */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(opts: AppServerOptions) {
    this.child = spawn(opts.cmd.command, [...opts.cmd.args, 'app-server'], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise((res) => {
      this.child.once('exit', (code, signal) => {
        this.failAll(new AppServerError(`codex app-server exited (${signal ?? `code ${code}`})`));
        res({ code, signal });
      });
      this.child.once('error', (e) => {
        this.failAll(new AppServerError(`codex app-server could not start: ${e.message}`));
        res({ code: null, signal: null });
      });
    });
    this.child.stdin?.on('error', () => undefined); // EPIPE after exit: reported via 'exit'
    this.child.stderr?.setEncoding('utf8');
    if (opts.onStderr) readline.createInterface({ input: this.child.stderr! }).on('line', (l) => opts.onStderr!(l));
    readline.createInterface({ input: this.child.stdout! }).on('line', (l) => this.onLine(l));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null && !this.closedError;
  }

  /** Handle a server -> client request (approvals, dynamic tool calls). Unhandled ones get an error reply. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
    return () => this.notificationHandlers.set(method, (this.notificationHandlers.get(method) ?? []).filter((h) => h !== handler));
  }

  onAnyNotification(handler: (method: string, params: unknown) => void): void {
    this.anyNotification.push(handler);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(id, {
        method,
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** `initialize` + `initialized`. Experimental API is needed for dynamic tools. */
  async initialize(clientName: string, version: string): Promise<{ userAgent?: string; codexHome?: string }> {
    const r = await this.request<{ userAgent?: string; codexHome?: string }>('initialize', {
      clientInfo: { name: clientName, title: 'AgentCraft', version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
    return r;
  }

  /** Close stdin and give the process `graceMs` to exit; the caller kills its tree if it does not. */
  async close(graceMs = 2000): Promise<boolean> {
    this.failAll(new AppServerError('codex app-server closed'));
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true;
    const t = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref?.())]);
    return t;
  }

  private write(o: unknown): void {
    if (this.closedError || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(o)}\n`);
  }

  private failAll(e: Error): void {
    this.closedError ??= e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      m = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (m.method === undefined && m.id !== undefined) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.error) p.reject(new AppServerError(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`, m.error.code));
      else p.resolve(m.result);
      return;
    }
    if (m.method && m.id !== undefined) {
      void this.answer(m.id, m.method, m.params);
      return;
    }
    if (m.method) {
      for (const h of this.anyNotification) h(m.method, m.params);
      for (const h of this.notificationHandlers.get(m.method) ?? []) h(m.params);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const h = this.requestHandlers.get(method);
    if (!h) {
      this.write({ id, error: { code: -32601, message: `AgentCraft does not handle ${method}` } });
      return;
    }
    try {
      const result = await h(params);
      this.write({ id, result: result ?? {} });
    } catch (e) {
      this.write({ id, error: { code: -32000, message: (e as Error).message } });
    }
  }
}
