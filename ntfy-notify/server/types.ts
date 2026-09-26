import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { PaseoAgent } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { CardDocument } from "../shared/card";
import type { PermissionDetail, TurnDetail } from "./details";

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
  /** Uncommitted changes in the workspace; null when the host does not report them. */
  diffStat?: { additions: number; deletions: number } | null;
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

export interface OutgoingMessage {
  /** Notification title. */
  title: string;
  /** One line per notification. */
  summary: string;
  /** Notification text: the summary followed by per-agent details. Used when the card cannot be sent. */
  body: string;
  /**
   * Structured card sent as the ntfy message body. Stock ntfy drops an unknown Content-Type, so the
   * card travels inside `message` and the Android client recognizes it by schema.
   */
  card?: CardDocument;
  /** Optional media type for a structured message body. */
  contentType?: string;
  /** ntfy priority, 1 (min) to 5 (max). */
  priority: number;
}

export interface NotificationSender {
  send(message: OutgoingMessage): Promise<string | null>;
}

export interface NotificationEngineDeps {
  sender: NotificationSender;
  inspect(agent: PluginHookAgent): Promise<RuntimeInspection>;
  /** Absent on hosts without `server.presence()`; every notification is then sent. */
  isUserPresent?: () => Promise<boolean>;
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
  /** The agent's whole timeline as the host passes it; absent in tests that only check timing. */
  timeline?: readonly AgentTimelineItem[];
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
  agentTitle?: string | null;
  cwd?: string;
  turn?: TurnDetail;
  error?: string;
  permission?: PermissionDetail;
}

export type AgentSnapshotLike = Pick<PaseoAgent, "id" | "workspaceId" | "status" | "labels">;
