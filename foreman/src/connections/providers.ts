// Provider registry: every kind of LLM connection the team can use. A provider says which runtime
// serves it, what the user fills in (the in-game form is built from `fields`), the environment
// the runtime needs, how to test it, and what it can do (effort, SDK cost).
//
// Claude-runtime providers all run the Claude Code CLI; they differ only in the environment:
// the inherited Anthropic variables are removed first, so a connection never leaks another
// connection's key or endpoint (e.g. the user's Anthropic key to DeepSeek).
import { PROVIDER_SWITCHES } from '../agents/claude/auth.js';
import type { Connection, ProviderId, RuntimeId } from './types.js';

export type FieldKey = 'apiKey' | 'baseUrl' | 'leadModel' | 'workerModel' | 'effort';

export interface ProviderField {
  key: FieldKey;
  label: string;
  kind: 'secret' | 'url' | 'model' | 'choice';
  required: boolean;
  placeholder?: string;
  choices?: string[];
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  runtime: RuntimeId;
  /** one line for the connection list */
  summary: string;
  /** where the repository's code and diffs are sent (shown when adding the connection) */
  dataDestination: string;
  /** the user's own login (subscription): personal use only */
  personalUse: boolean;
  /** can be added from the UI (claude-env is derived from the command line only) */
  userCreatable: boolean;
  fields: ProviderField[];
  defaultBaseUrl?: string;
  /** models when the connection names none (Claude aliases are mapped by compatible endpoints) */
  defaultModels: { lead?: string; worker?: string };
  /** the SDK's total_cost_usd is right for this provider (Claude prices) */
  sdkCost: boolean;
  /** the runtime may send a reasoning effort */
  effort: boolean;
  /** an API key is needed (secretRef) */
  needsSecret: boolean;
}

/** Variables that select or authenticate a Claude endpoint: removed before a connection sets its own. */
export const ANTHROPIC_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  ...Object.keys(PROVIDER_SWITCHES),
];

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const apiKey = (placeholder: string): ProviderField => ({ key: 'apiKey', label: 'API key', kind: 'secret', required: true, placeholder });
const models = (lead: string, worker: string): ProviderField[] => [
  { key: 'leadModel', label: 'Lead model', kind: 'model', required: false, placeholder: lead },
  { key: 'workerModel', label: 'Worker model', kind: 'model', required: false, placeholder: worker },
];

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  'claude-env': {
    id: 'claude-env',
    label: 'Claude (environment)',
    runtime: 'claude',
    summary: 'ANTHROPIC_API_KEY, a cloud provider or --use-claude-login, as set when the Foreman started',
    dataDestination: 'Anthropic (or the cloud provider set in the environment)',
    personalUse: false,
    userCreatable: false,
    fields: [],
    defaultModels: { lead: 'opus', worker: 'sonnet' },
    sdkCost: true,
    effort: true,
    needsSecret: false,
  },
  'anthropic-api': {
    id: 'anthropic-api',
    label: 'Anthropic API',
    runtime: 'claude',
    summary: 'Claude with an API key from console.anthropic.com',
    dataDestination: 'Anthropic (api.anthropic.com)',
    personalUse: false,
    userCreatable: true,
    fields: [apiKey('sk-ant-...'), ...models('opus', 'sonnet'), { key: 'effort', label: 'Effort', kind: 'choice', required: false, choices: CLAUDE_EFFORTS }],
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModels: { lead: 'opus', worker: 'sonnet' },
    sdkCost: true,
    effort: true,
    needsSecret: true,
  },
  'claude-login': {
    id: 'claude-login',
    label: 'Claude login (personal)',
    runtime: 'claude',
    summary: 'your own `claude` CLI login (claude.ai plan); personal use only',
    dataDestination: 'Anthropic (your claude.ai account)',
    personalUse: true,
    userCreatable: true,
    fields: [...models('opus', 'sonnet'), { key: 'effort', label: 'Effort', kind: 'choice', required: false, choices: CLAUDE_EFFORTS }],
    defaultModels: { lead: 'opus', worker: 'sonnet' },
    sdkCost: true,
    effort: true,
    needsSecret: false,
  },
  cloud: {
    id: 'cloud',
    label: 'Claude on a cloud provider',
    runtime: 'claude',
    summary: 'Amazon Bedrock / Google Vertex AI / Microsoft Foundry, from the Foreman environment',
    dataDestination: 'your cloud provider account',
    personalUse: false,
    userCreatable: true,
    fields: models('opus', 'sonnet'),
    defaultModels: { lead: 'opus', worker: 'sonnet' },
    sdkCost: true,
    effort: true,
    needsSecret: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude',
    summary: 'DeepSeek API through its Anthropic-compatible endpoint',
    dataDestination: 'DeepSeek (api.deepseek.com)',
    personalUse: false,
    userCreatable: true,
    // Claude aliases are mapped by DeepSeek (opus -> its pro model, sonnet/haiku -> its fast model)
    fields: [apiKey('sk-...'), ...models('opus', 'sonnet')],
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultModels: { lead: 'opus', worker: 'sonnet' },
    sdkCost: false,
    effort: false,
    needsSecret: true,
  },
  'anthropic-compatible': {
    id: 'anthropic-compatible',
    label: 'Anthropic-compatible endpoint',
    runtime: 'claude',
    summary: 'any endpoint that speaks the Anthropic Messages API (gateway, proxy, other vendors)',
    dataDestination: 'the endpoint you enter',
    personalUse: false,
    userCreatable: true,
    fields: [{ key: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://example.com/anthropic' }, apiKey('key'), ...models('model id', 'model id')],
    defaultModels: {},
    sdkCost: false,
    effort: false,
    needsSecret: true,
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT (Codex)',
    runtime: 'codex',
    summary: 'OpenAI Codex on your ChatGPT plan, signed in with a device code; personal use',
    dataDestination: 'OpenAI (your ChatGPT account)',
    personalUse: true,
    userCreatable: true,
    fields: [...models('Codex default', 'Codex default'), { key: 'effort', label: 'Effort', kind: 'choice', required: false, choices: CODEX_EFFORTS }],
    defaultModels: {},
    sdkCost: false,
    effort: true,
    needsSecret: false,
  },
};

export function provider(id: ProviderId): ProviderDef {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider "${id}"`);
  return p;
}

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/** The model a role runs on this connection (undefined: the runtime's own default). */
export function modelFor(conn: Connection, role: 'lead' | 'worker'): string | undefined {
  const p = provider(conn.provider);
  return conn.models?.[role] ?? p.defaultModels[role];
}

/** The endpoint a connection talks to. */
export function baseUrlFor(conn: Connection): string | undefined {
  return (conn.baseUrl?.trim() || provider(conn.provider).defaultBaseUrl)?.replace(/\/+$/, '');
}

/**
 * Environment for the Claude Code CLI of one agent on this connection. `base` is the agent's
 * environment (git safety etc.); `secret` the connection's key. claude-env and cloud keep what
 * the Foreman environment provides; every other provider replaces it.
 */
export function claudeEnv(base: Record<string, string | undefined>, conn: Connection, secret: string | undefined, model: string | undefined): Record<string, string | undefined> {
  const p = provider(conn.provider);
  if (p.runtime !== 'claude') throw new Error(`${p.label} does not run on the Claude runtime`);
  const env = { ...base };
  if (conn.provider === 'claude-env') {
    // unchanged behaviour: the claude.ai login token only when --use-claude-login
    if (!conn.useClaudeLogin) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return env;
  }
  if (conn.provider === 'cloud') {
    // keep the provider switch and its credentials; drop direct-API keys so they cannot win
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
    return env;
  }
  for (const k of ANTHROPIC_ENV_VARS) delete env[k];
  if (conn.provider === 'claude-login') return env;
  if (conn.provider === 'anthropic-api') {
    if (secret) env.ANTHROPIC_API_KEY = secret;
    return env;
  }
  // DeepSeek and other compatible endpoints: bearer token + base URL, every model slot pinned to
  // the connection's model so no Claude model name (or background Haiku call) leaks through, and
  // no Anthropic-only traffic (telemetry, update checks)
  const url = baseUrlFor(conn);
  if (url) env.ANTHROPIC_BASE_URL = url;
  if (secret) env.ANTHROPIC_AUTH_TOKEN = secret;
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.ANTHROPIC_SMALL_FAST_MODEL = model;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.API_TIMEOUT_MS = '600000';
  return env;
}

export class ConnectionTestError extends Error {
  constructor(
    message: string,
    readonly auth: boolean,
  ) {
    super(message);
  }
}

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

async function getModels(fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<string[] | undefined> {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new ConnectionTestError(`the endpoint rejected the key (HTTP ${res.status})`, true);
  if (res.status === 404) return undefined; // reachable, but no model list there
  if (!res.ok) throw new ConnectionTestError(`HTTP ${res.status} from ${url}`, false);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
}

/**
 * An API-key connection's quick test: list the endpoint's models (costs no tokens, proves the key).
 * Returns the model ids, or [] when the endpoint has no model list. Throws ConnectionTestError.
 */
export async function listModels(conn: Connection, secret: string | undefined, fetchFn: FetchFn): Promise<string[]> {
  const p = provider(conn.provider);
  if (p.needsSecret && !secret) throw new ConnectionTestError('no API key saved for this connection', true);
  const url = baseUrlFor(conn);
  try {
    if (conn.provider === 'anthropic-api') {
      return (await getModels(fetchFn, `${url}/v1/models?limit=100`, { 'x-api-key': secret!, 'anthropic-version': '2023-06-01' })) ?? [];
    }
    if (conn.provider === 'deepseek') {
      // the OpenAI-compatible root lists the models; the same key works on both endpoints
      const root = (url ?? 'https://api.deepseek.com/anthropic').replace(/\/anthropic$/, '');
      return (await getModels(fetchFn, `${root}/models`, { Authorization: `Bearer ${secret}` })) ?? [];
    }
    if (conn.provider === 'anthropic-compatible') {
      if (!url) throw new ConnectionTestError('no base URL', false);
      return (await getModels(fetchFn, `${url}/v1/models`, { 'x-api-key': secret!, Authorization: `Bearer ${secret}`, 'anthropic-version': '2023-06-01' })) ?? [];
    }
  } catch (e) {
    if (e instanceof ConnectionTestError) throw e;
    throw new ConnectionTestError(`could not reach ${url}: ${(e as Error).message}`, false);
  }
  throw new ConnectionTestError(`${p.label} has no model list to test`, false);
}
