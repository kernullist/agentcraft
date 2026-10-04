// Connections: the store (secrets kept apart, assignment, migration from the command line) and
// the provider environments (DeepSeek and friends never inherit another endpoint's key).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/connections/manager.js';
import { ANTHROPIC_ENV_VARS, claudeEnv, ConnectionTestError, listModels, modelFor, type FetchFn } from '../src/connections/providers.js';
import { mask, MemorySecretStore } from '../src/connections/secrets.js';
import { ConnectionStore } from '../src/connections/store.js';
import type { Connection } from '../src/connections/types.js';
import { rmrf, tempDir } from './helpers.js';

const cli: Connection = { id: 'cli', name: 'Claude', provider: 'claude-env', models: { lead: 'opus', worker: 'sonnet' }, source: 'cli', createdAt: 0 };

let home: string | undefined;
afterEach(() => {
  if (home) rmrf(home);
  home = undefined;
});

function store(opts: { profile?: string; secrets?: MemorySecretStore; forced?: { lead?: string; workers?: string } } = {}) {
  home ??= tempDir();
  return new ConnectionStore({ home, profile: opts.profile ?? 'claude', cli, secrets: opts.secrets ?? new MemorySecretStore({ DS_KEY: 'sk-from-env-1234' }), ...(opts.forced ? { forced: opts.forced } : {}) });
}

describe('ConnectionStore', () => {
  it('uses the command-line connection until something else is assigned', () => {
    const s = store();
    expect(s.list().map((c) => c.id)).toEqual(['cli']);
    expect(s.assignment()).toEqual({ lead: 'cli', workers: 'cli' });
  });

  it('keeps secrets out of connections.json and masks them for clients', () => {
    const secrets = new MemorySecretStore();
    const s = store({ secrets });
    const c = s.save({ provider: 'deepseek', name: 'DeepSeek', apiKey: 'sk-deepseek-secret-abcd' });
    expect(c.id).toBe('deepseek');
    expect(c.secretRef).toBe('keyring:deepseek');
    const file = fs.readFileSync(path.join(home!, 'connections.json'), 'utf8');
    expect(file).not.toContain('sk-deepseek-secret');
    expect(s.secretOf(c)).toBe('sk-deepseek-secret-abcd');
    const view = new ConnectionManager(s).view(c);
    expect(view.secret).toBe('sk-…abcd');
    expect(JSON.stringify(view)).not.toContain('secret-abcd');
    expect(view.dataDestination).toContain('DeepSeek');
  });

  it('takes a key from an environment variable reference', () => {
    const s = store();
    const c = s.save({ provider: 'deepseek', apiKeyEnv: 'DS_KEY' });
    expect(c.secretRef).toBe('env:DS_KEY');
    expect(s.secretOf(c)).toBe('sk-from-env-1234');
    expect(new ConnectionManager(s).view(c).secret).toBe('env:DS_KEY');
  });

  it('validates what a client sends', () => {
    const s = store();
    expect(() => s.save({ provider: 'deepseek' })).toThrow(/needs an API key/);
    expect(() => s.save({ provider: 'anthropic-compatible', apiKey: 'k' })).toThrow(/base URL/);
    expect(() => s.save({ provider: 'anthropic-compatible', apiKey: 'k', baseUrl: 'http://gw.example.com' })).toThrow(/https/);
    expect(s.save({ provider: 'anthropic-compatible', apiKey: 'k', baseUrl: 'http://localhost:4000/anthropic', models: { lead: 'm1', worker: 'm2' } }).baseUrl).toBe('http://localhost:4000/anthropic');
    expect(() => s.save({ provider: 'claude-env' })).toThrow(/command line/);
    expect(() => s.save({ provider: 'nope' as never })).toThrow(/unknown provider/);
    expect(() => s.save({ provider: 'anthropic-api', apiKey: 'k', effort: 'turbo' })).toThrow(/effort/);
    expect(() => s.save({ provider: 'deepseek', apiKey: 'k', models: { lead: 'bad model' } })).toThrow(/bad lead model/);
    expect(() => s.save({ id: 'cli', provider: 'deepseek', apiKey: 'k' })).toThrow(/cannot be edited/);
  });

  it('assigns per profile, survives a restart, and falls back when a connection is removed', () => {
    const s = store();
    s.save({ provider: 'deepseek', apiKey: 'k1' });
    expect(s.assign('workers', 'deepseek')).toEqual({ lead: 'cli', workers: 'deepseek' });
    expect(store().assignment()).toEqual({ lead: 'cli', workers: 'deepseek' }); // re-read from disk
    expect(store({ profile: 'other' }).assignment()).toEqual({ lead: 'cli', workers: 'cli' });
    s.delete('deepseek');
    expect(s.assignment()).toEqual({ lead: 'cli', workers: 'cli' });
    expect(() => s.delete('cli')).toThrow(/cannot be removed/);
  });

  it('lets flags override the saved assignment for one run', () => {
    const s = store();
    s.save({ provider: 'deepseek', apiKey: 'k1' });
    expect(store({ forced: { lead: 'deepseek', workers: 'deepseek' } }).assignment()).toEqual({ lead: 'deepseek', workers: 'deepseek' });
    expect(() => store({ forced: { lead: 'missing' } })).toThrow(/no connection "missing"/);
  });

  it('gives a ChatGPT connection its own CODEX_HOME', () => {
    const s = store();
    const c = s.save({ provider: 'chatgpt', name: 'My ChatGPT' });
    expect(c.id).toBe('my-chatgpt');
    expect(c.codexHome).toBe(path.join(home!, 'codex', 'my-chatgpt'));
  });
});

describe('provider environments', () => {
  const base = { PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-real', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', GIT_ALLOW_PROTOCOL: 'agentcraft-none' };
  const conn = (o: Partial<Connection>): Connection => ({ id: 'x', name: 'X', provider: 'deepseek', source: 'user', createdAt: 0, ...o });

  it('DeepSeek: its endpoint and key only, every model slot pinned, no Anthropic credentials', () => {
    const env = claudeEnv(base, conn({ provider: 'deepseek' }), 'sk-ds', 'deepseek-pro');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ds');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) expect(env[k]).toBe('deepseek-pro');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('agentcraft-none'); // the agent environment is kept
  });

  it('Anthropic API: its own key replaces the inherited one', () => {
    const env = claudeEnv(base, conn({ provider: 'anthropic-api' }), 'sk-ant-conn', 'opus');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-conn');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('claude-env keeps the environment (OAuth token only with --use-claude-login); cloud keeps the switch', () => {
    expect(claudeEnv(base, conn({ provider: 'claude-env' }), undefined, 'opus').CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(claudeEnv(base, conn({ provider: 'claude-env', useClaudeLogin: true }), undefined, 'opus').CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(claudeEnv(base, conn({ provider: 'claude-env' }), undefined, 'opus').ANTHROPIC_API_KEY).toBe('sk-ant-real');
    const cloud = claudeEnv(base, conn({ provider: 'cloud' }), undefined, 'opus');
    expect(cloud.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(cloud.ANTHROPIC_API_KEY).toBeUndefined();
    const login = claudeEnv(base, conn({ provider: 'claude-login' }), undefined, 'opus');
    for (const k of ANTHROPIC_ENV_VARS) expect(login[k]).toBeUndefined();
  });

  it('refuses a Codex connection on the Claude runtime', () => {
    expect(() => claudeEnv(base, conn({ provider: 'chatgpt' }), undefined, undefined)).toThrow(/Claude runtime/);
  });

  it('DeepSeek runs its own model ids, never Claude aliases', () => {
    const ds = conn({ provider: 'deepseek' });
    expect(modelFor(ds, 'lead')).toBe('deepseek-v4-pro');
    expect(modelFor(ds, 'worker')).toBe('deepseek-flash');
    // listed by the endpoint: used as is
    expect(modelFor(ds, 'lead', ['deepseek-flash', 'deepseek-v4-pro'])).toBe('deepseek-v4-pro');
    // renamed by the endpoint: the default is replaced by a listed model of the right kind
    expect(modelFor(ds, 'lead', ['deepseek-v5-flash', 'deepseek-v5-pro'])).toBe('deepseek-v5-pro');
    expect(modelFor(ds, 'worker', ['deepseek-v5-pro', 'deepseek-v5-flash'])).toBe('deepseek-v5-flash');
    expect(modelFor(ds, 'worker', ['only-one'])).toBe('only-one');
    // the user's choice always wins
    expect(modelFor(conn({ provider: 'deepseek', models: { lead: 'x-model' } }), 'lead', ['deepseek-v4-pro'])).toBe('x-model');
  });

  it('masks keys', () => {
    expect(mask('sk-1234567890abcd')).toBe('sk-…abcd');
    expect(mask('short')).toBe('••••');
    expect(mask(undefined)).toBeUndefined();
  });
});

describe('connection test (model list)', () => {
  const fetchOk = (calls: Array<{ url: string; headers: Record<string, string> }>, status = 200, data: unknown = { data: [{ id: 'deepseek-pro' }, { id: 'deepseek-flash' }] }): FetchFn =>
    async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status, ok: status < 300, json: async () => data };
    };
  const conn = (o: Partial<Connection>): Connection => ({ id: 'x', name: 'X', provider: 'deepseek', source: 'user', createdAt: 0, ...o });

  it('DeepSeek lists models on the OpenAI-compatible root with a bearer key', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    expect(await listModels(conn({}), 'sk-ds', fetchOk(calls))).toEqual(['deepseek-pro', 'deepseek-flash']);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/models');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-ds');
  });

  it('Anthropic API uses x-api-key; a rejected key is an auth error', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    await listModels(conn({ provider: 'anthropic-api' }), 'sk-ant', fetchOk(calls));
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant');
    await expect(listModels(conn({ provider: 'anthropic-api' }), 'bad', fetchOk([], 401))).rejects.toMatchObject({ auth: true });
    await expect(listModels(conn({}), undefined, fetchOk([]))).rejects.toBeInstanceOf(ConnectionTestError);
  });

  it('an endpoint without a model list is still reachable', async () => {
    expect(await listModels(conn({ provider: 'anthropic-compatible', baseUrl: 'https://gw.example.com/anthropic/' }), 'k', fetchOk([], 404))).toEqual([]);
  });
});
