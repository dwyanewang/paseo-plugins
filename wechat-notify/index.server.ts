import type { PaseoApi, PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { NotificationEngine } from "./server/engine";
import { createIlinkSender } from "./server/ilink";
import { sendStartupNotice } from "./server/startup";
import type { AgentEntry, NotificationWorkspace, RuntimeInspection } from "./server/types";

const PARENT_LABEL = "paseo.parent-agent-id";

async function listAgents(paseo: PaseoApi): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      scope: "active",
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of result.entries) {
      entries.push({
        id: entry.agent.id,
        workspaceId: entry.agent.workspaceId,
        status: entry.agent.status,
        labels: entry.agent.labels,
      });
    }
    cursor = result.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

async function findWorkspace(paseo: PaseoApi, workspaceId: string | null): Promise<NotificationWorkspace | null> {
  if (!workspaceId) return null;
  let cursor: string | undefined;
  do {
    const result = await paseo.workspaces.list({
      ...(cursor ? { page: { limit: 200, cursor } } : { page: { limit: 200 } }),
    });
    const workspace = result.entries.find((entry) => entry.id === workspaceId);
    if (workspace) return toNotificationWorkspace(workspace);
    cursor = result.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

function toNotificationWorkspace(workspace: PaseoWorkspace): NotificationWorkspace {
  return {
    id: workspace.id,
    projectDisplayName: workspace.projectDisplayName,
    projectKind: workspace.projectKind,
    name: workspace.name,
    branch: workspace.gitRuntime?.currentBranch ?? null,
    status: workspace.status,
  };
}

async function inspect(paseo: PaseoApi, agent: PluginHookAgent): Promise<RuntimeInspection> {
  const [workspace, agents] = await Promise.all([findWorkspace(paseo, agent.workspaceId), listAgents(paseo)]);
  return { workspace, agents };
}

export default function contribute(server: PluginServerContext) {
  const log = (message: string, details?: Record<string, unknown>) => {
    // Never include credentials or recipient identifiers in plugin logs.
    console.log(`[wechat-notify] ${message}`, details ?? "");
  };
  const sender = createIlinkSender(server.secrets, { log });
  const engine = new NotificationEngine({
    sender,
    inspect: (agent) => inspect(server.paseo, agent),
    log,
  });
  void sendStartupNotice(sender, log);

  server.on("agent.turn_started", (event) => {
    engine.onTurnStarted(event.agent);
  });
  server.on("agent.turn_ended", (event) => {
    engine.onTurnEnded(event);
  });
  server.on("agent.permission_requested", (event) => {
    engine.onPermissionRequested(event);
  });
  server.on("agent.permission_resolved", (event) => {
    engine.onPermissionResolved(event.requestId);
  });

  return async () => {
    engine.dispose();
    await engine.flush();
  };
}

export { findWorkspace, inspect, listAgents, toNotificationWorkspace, PARENT_LABEL };
export type { AgentPermissionRequest, PaseoAgent };
