// Connections: which LLM the team talks to, separate from which agent runtime runs the agents.
//
//   runtime     the harness that runs an agent turn (agent loop, tools, sandbox, approvals):
//               "claude" = Claude Agent SDK (Claude Code CLI), "codex" = codex app-server
//   provider    a kind of LLM endpoint + sign-in, served by one runtime (providers.ts)
//   connection  a configured provider: name, endpoint, credential reference, models
//   assignment  which connection the lead and the workers use (per profile)
//
// See docs/plan/2026-10-04-multi-llm-connections.md and docs/adr/0002.

export type RuntimeId = 'claude' | 'codex';

export type ProviderId =
  /** today's claude backend: whatever the environment provides (API key, cloud, gateway, --use-claude-login) */
  | 'claude-env'
  | 'anthropic-api'
  | 'claude-login'
  | 'cloud'
  | 'deepseek'
  | 'anthropic-compatible'
  | 'chatgpt';

export type Role = 'lead' | 'worker';

export interface Connection {
  id: string;
  name: string;
  provider: ProviderId;
  /** endpoint override (anthropic-compatible: required; deepseek: optional) */
  baseUrl?: string;
  /** "keyring:<id>" (OS credential store) or "env:<VAR>"; never the secret itself */
  secretRef?: string;
  models?: { lead?: string; worker?: string };
  /** reasoning effort passed to the runtime when the provider supports it */
  effort?: string;
  /** chatgpt: CODEX_HOME for this connection's sign-in and threads */
  codexHome?: string;
  /** claude-env: also use the `claude` CLI login (--use-claude-login) */
  useClaudeLogin?: boolean;
  /** "cli": derived from flags/env at start (not saved); "user": saved in connections.json */
  source: 'cli' | 'user';
  createdAt: number;
}

export type ConnectionAuth = 'unknown' | 'checking' | 'ok' | 'failed';

export interface ConnectionStatus {
  auth: ConnectionAuth;
  /** banner/UI text: why it failed, the device code to enter, or what it runs */
  message?: string;
  /** e.g. "alex@example.com · plus" or "API key" */
  account?: string;
  /** models the endpoint reported (connection test) */
  models?: string[];
  checkedAt?: number;
}

export interface Assignment {
  lead: string;
  workers: string;
}

/** The connection id derived from the command line / environment (never saved). */
export const CLI_CONNECTION_ID = 'cli';
