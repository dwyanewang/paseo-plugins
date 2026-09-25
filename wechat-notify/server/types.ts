import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { PaseoAgent } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NotificationWorkspace {
  id: string;
  projectDisplayName: string;
  projectKind: string;
  name: string;
  branch: string | null;
  status: string;
}

export interface AgentEntry {
  id: string;
  workspaceId?: string;
  status: string;
  labels?: Record<string, string>;
}

export interface RuntimeInspection {
  workspace: NotificationWorkspace | null;
  agents: AgentEntry[];
}

export interface NotificationSender {
  send(text: string): Promise<string | null>;
}

export interface NotificationEngineDeps {
  sender: NotificationSender;
  inspect(agent: PluginHookAgent): Promise<RuntimeInspection>;
  clock?: Clock;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface PermissionEvent {
  agent: PluginHookAgent;
  request: AgentPermissionRequest;
}

export interface TurnEndedEvent {
  agent: PluginHookAgent;
  turnId: string | null;
  outcome:
    | { kind: "completed" }
    | { kind: "failed"; error: { message: string; code?: string } }
    | { kind: "canceled"; reason: string };
}

export interface NotificationRecord {
  kind: "completed" | "failed" | "permission";
  agentId: string;
  workspaceId: string | null;
  workspace: NotificationWorkspace | null;
  provider: string;
  durationMs?: number;
  runningRootCount?: number;
  errorFirstLine?: string;
  toolName?: string;
}

export type AgentSnapshotLike = Pick<PaseoAgent, "id" | "workspaceId" | "status" | "labels">;
