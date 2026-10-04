// The team tools (agents/team/tools.ts) as an in-process MCP server for the Agent SDK (server name
// "agentcraft", so the CLI sees them as mcp__agentcraft__<name>).
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Foreman } from '../../foreman.js';
import { buildTeamTools, TEAM_TOOLS_INSTRUCTIONS, teamToolNames, type ToolHooks, type TurnHandle } from '../team/tools.js';

export { closeIfNoChanges, type ToolHooks, type TurnHandle } from '../team/tools.js';

export const MCP_SERVER = 'agentcraft';

export function toolNames(role: 'lead' | 'worker'): string[] {
  return teamToolNames(role).map((n) => `mcp__${MCP_SERVER}__${n}`);
}

export function buildMcpServer(fm: Foreman, agentId: string, role: 'lead' | 'worker', hooks: ToolHooks, turn?: TurnHandle): McpSdkServerConfigWithInstance {
  const tools = buildTeamTools(fm, agentId, role, hooks, turn).map((t) => tool(t.name, t.description, t.shape, (args) => t.handler(args)));
  // alwaysLoad: never hide our tools behind tool search
  return createSdkMcpServer({ name: MCP_SERVER, version: '0.1.0', tools, alwaysLoad: true, instructions: TEAM_TOOLS_INSTRUCTIONS() });
}
