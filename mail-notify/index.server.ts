import { hostname } from "node:os";
import type { PaseoApi, PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { hasPassword, readConfig, readCredentials, writeConfig } from "./server/credentials";
import { NotificationEngine } from "./server/engine";
import { createMailSender } from "./server/mailer";
import { LIVE_RECHECK_MS } from "./server/constants";
import { isWatching, type PresenceLike } from "./server/presence";
import { testMessage } from "./server/notices";
import { sendStartupNotice } from "./server/startup";
import type { AgentEntry, NotificationWorkspace, RuntimeInspection } from "./server/types";
import { readSmtpConfig, saveSmtpConfig, sendTestMail } from "./shared/smtp";

const PARENT_LABEL = "paseo.parent-agent-id";

interface PresenceReader {
  presence?: () => Promise<PresenceLike>;
}

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
    diffStat: workspace.diffStat ?? null,
  };
}

/**
 * Streams agent and workspace changes into `onChange` so background waits end as soon as the work
 * does. Each subscription re-snapshots after a reconnect, which also triggers `onChange`.
 */
async function watchRuntime(paseo: PaseoApi, onChange: () => void): Promise<() => Promise<void>> {
  const observer = { snapshot: onChange, update: onChange };
  const agents = await paseo.agents.list({ scope: "active", subscribe: {} });
  const stopAgents = agents.subscription.subscribe(observer);
  try {
    const workspaces = await paseo.workspaces.list({ subscribe: {} });
    const stopWorkspaces = workspaces.subscription.subscribe(observer);
    return async () => {
      stopAgents();
      stopWorkspaces();
      await Promise.all([agents.subscription.release(), workspaces.subscription.release()]);
    };
  } catch (error) {
    stopAgents();
    await agents.subscription.release();
    throw error;
  }
}

async function inspect(paseo: PaseoApi, agent: PluginHookAgent): Promise<RuntimeInspection> {
  const [workspace, agents] = await Promise.all([findWorkspace(paseo, agent.workspaceId), listAgents(paseo)]);
  return { workspace, agents };
}

export default function contribute(server: PluginServerContext) {
  const log = (message: string, details?: Record<string, unknown>) => {
    // Never include credentials or mail addresses in plugin logs.
    console.log(`[mail-notify] ${message}`, details ?? "");
  };
  const sender = createMailSender(server.secrets, { log });
  // `server.presence()` is newer than some hosts this plugin runs on.
  const presence = (server as PluginServerContext & PresenceReader).presence?.bind(server);
  if (!presence) log("宿主不支持在场检测，通知不会因正在使用 Paseo 而跳过");
  const engine = new NotificationEngine({
    sender,
    inspect: (agent) => inspect(server.paseo, agent),
    ...(presence ? { isUserPresent: async () => isWatching(await presence(), Date.now()) } : {}),
    log,
  });
  let stopWatching: (() => Promise<void>) | null = null;
  let disposed = false;
  void watchRuntime(server.paseo, () => engine.nudge())
    .then(async (stop) => {
      if (disposed) return stop();
      stopWatching = stop;
      engine.setRecheckInterval(LIVE_RECHECK_MS);
    })
    .catch((error: unknown) =>
      log("订阅 agent 和工作区更新失败，后台工作改为每分钟复查", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  void readCredentials(server.secrets)
    .then((credentials) => {
      if (credentials) return sendStartupNotice(sender, hostname(), log);
      log("未配置发件邮箱，在 设置 → 插件 → mail-notify 里填写");
      return false;
    })
    .catch((error: unknown) => log("读取发件邮箱配置失败", { error: error instanceof Error ? error.message : String(error) }));

  server.handle(readSmtpConfig, async () => ({
    config: await readConfig(server.secrets),
    hasPassword: await hasPassword(server.secrets),
  }));
  server.handle(saveSmtpConfig, async ({ password, ...config }) => ({
    status: await writeConfig(server.secrets, config, password),
  }));
  server.handle(sendTestMail, async () => {
    const config = await readConfig(server.secrets);
    if (!config) return { status: "unconfigured" as const };
    const result = await sender.sendDetailed(testMessage(config));
    return result.status === "sent" ? { status: "sent" as const } : result;
  });

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
    disposed = true;
    await (stopWatching as (() => Promise<void>) | null)?.();
    // flush() takes the queue before its first await, so a reload still sends what the merge
    // window was holding; dispose() then clears the timers.
    const pending = engine.flush();
    engine.dispose();
    await pending;
  };
}

export { findWorkspace, inspect, listAgents, toNotificationWorkspace, PARENT_LABEL };
export type { AgentPermissionRequest, PaseoAgent };
