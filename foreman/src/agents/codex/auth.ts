// How the codex backend authenticates: the user's ChatGPT subscription, signed in with a device
// code through the official Codex CLI (`codex app-server`, account/login/start chatgptDeviceCode).
//
// AgentCraft never sees a token: Codex runs the OAuth device flow and stores the credentials in
// the agents' own CODEX_HOME (default <home>/<profile>/codex, apart from the user's ~/.codex).
// The Foreman only relays the verification URL and the one-time code to the user (console,
// in-game banner, desktop notification) and waits for Codex to report the result. Personal use:
// the agents run on the user's own ChatGPT plan.
import type { AppServerClient } from './appserver.js';

export interface CodexAccount {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface DeviceCode {
  verificationUrl: string;
  userCode: string;
}

export type LoginResult = { ok: true; account: CodexAccount } | { ok: false; error: string };

/** One line for the status banner: "kernullist@example.com · plus". */
export function describeAccount(a: CodexAccount): string {
  const plan = a.planType && a.planType !== 'unknown' ? a.planType : undefined;
  return [a.email, plan].filter(Boolean).join(' · ') || (a.type === 'chatgpt' ? 'ChatGPT' : a.type);
}

/** Banner text while a device code waits for the user. */
export function deviceCodeMessage(d: DeviceCode): string {
  return `Sign in to ChatGPT for Codex: open ${d.verificationUrl} and enter the code ${d.userCode}`;
}

export async function readAccount(client: AppServerClient): Promise<CodexAccount | null> {
  const r = await client.request<{ account: CodexAccount | null }>('account/read', { refreshToken: false });
  return r.account;
}

/**
 * Signed in with ChatGPT already, or sign in now with a device code. `onCode` is called with each
 * code (a new one if the previous expired, up to `attempts`). Only a ChatGPT account counts: an
 * API key login in this CODEX_HOME is not what the codex backend is for.
 */
export async function ensureChatgptLogin(
  client: AppServerClient,
  opts: { onCode: (d: DeviceCode) => void; attempts?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<LoginResult> {
  const current = await readAccount(client);
  if (current?.type === 'chatgpt') return { ok: true, account: current };
  const attempts = opts.attempts ?? 3;
  let lastError = 'not signed in';
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) return { ok: false, error: 'cancelled' };
    let onDone!: (p: { success: boolean; error: string | null; loginId: string | null }) => void;
    const done = new Promise<{ success: boolean; error: string | null; loginId: string | null }>((res) => (onDone = res));
    const off = client.onNotification('account/login/completed', (p) => onDone(p as { success: boolean; error: string | null; loginId: string | null }));
    try {
      const r = await client.request<{ type: string; loginId: string; verificationUrl: string; userCode: string }>('account/login/start', { type: 'chatgptDeviceCode' });
      if (r.type !== 'chatgptDeviceCode') return { ok: false, error: `unexpected login type ${r.type}` };
      opts.onCode({ verificationUrl: r.verificationUrl, userCode: r.userCode });
      const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
      const res = await Promise.race([
        done,
        client.exited.then(() => ({ success: false, error: 'codex app-server exited', loginId: null })),
        new Promise<{ success: boolean; error: string | null; loginId: string | null }>((r2) => setTimeout(() => r2({ success: false, error: 'the code expired', loginId: null }), timeoutMs).unref?.()),
        new Promise<{ success: boolean; error: string | null; loginId: string | null }>((r2) => opts.signal?.addEventListener('abort', () => r2({ success: false, error: 'cancelled', loginId: null }), { once: true })),
      ]);
      if (res.success) {
        const a = await readAccount(client);
        if (a?.type === 'chatgpt') return { ok: true, account: a };
        lastError = 'signed in, but not with a ChatGPT account';
        break;
      }
      lastError = res.error ?? 'login failed';
      if (lastError === 'cancelled' || !client.alive) break;
      // an expired or abandoned code: cancel it on the server, then offer a fresh one
      await client.request('account/login/cancel', { loginId: r.loginId }).catch(() => undefined);
    } finally {
      off();
    }
  }
  return { ok: false, error: lastError };
}
