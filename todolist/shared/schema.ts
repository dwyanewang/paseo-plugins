import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { migrateTodoDocument } from "./migrate";

/**
 * Persistent Todo document. The Settings definition version is the only schema version; the
 * document does not carry a second one. All maps are canonical; derived indexes are rebuilt in
 * memory by the server.
 */
export const TODO_SETTINGS_ID = "todo-data";
export const TODO_SETTINGS_VERSION = 3;

/** Board columns, in display order. */
export const WORK_ITEM_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
export const WorkItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

/** Why the status last changed; automatic moves name the event that caused them. */
export const StatusReasonSchema = z.enum([
  "created",
  "manual",
  "launch_started",
  "agent_active",
  "agent_finished",
  "migration",
]);
export type StatusReason = z.infer<typeof StatusReasonSchema>;

/** Highest first; cards sort by priority, then by number. */
export const WORK_ITEM_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export const WorkItemPrioritySchema = z.enum(WORK_ITEM_PRIORITIES);
export type WorkItemPriority = z.infer<typeof WorkItemPrioritySchema>;

/**
 * A reference to an image attached to a work item for description. Only metadata lives in this
 * document; the base64 bytes live in the separate `todo-images` document (see `shared/images.ts`),
 * so image data never bloats this frequently-written, migrated document.
 */
export const TodoImageRefSchema = z.object({
  id: z.string().min(1),
  /** For example `image/png`, `image/jpeg`. */
  mimeType: z.string().min(1),
  /** Original file name when one was available. */
  name: z.string().optional(),
  /** Decoded byte length, kept for display and capacity messaging. */
  byteLength: z.number().int().nonnegative(),
});
export type TodoImageRef = z.infer<typeof TodoImageRefSchema>;

/**
 * A reference to a file attached to a work item, such as a document. The bytes are a file on the
 * daemon host (see `server/card-files.ts`), which a launch hands to the agent by path.
 */
export const TodoFileRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Empty when neither the platform nor the name told what it is. */
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
});
export type TodoFileRef = z.infer<typeof TodoFileRefSchema>;

export const WorkItemSchema = z.object({
  id: z.string().min(1),
  creationFingerprint: z.string().min(1),
  /** Content version for edits. Status moves deliberately do not bump it. */
  version: z.number().int().positive(),
  /** Host-wide display number (`#12`); never reused and kept across project rebinds. */
  number: z.number().int().positive(),
  projectId: z.string().min(1),
  projectNameSnapshot: z.string(),
  projectRootSnapshot: z.string().optional(),
  title: z.string(),
  details: z.string(),
  defaultPrompt: z.string(),
  /** References to images that describe the work; bytes live in the `todo-images` document. */
  images: z.array(TodoImageRefSchema).default([]),
  /** References to attached files; bytes live on the daemon host's disk. */
  files: z.array(TodoFileRefSchema).default([]),
  status: WorkItemStatusSchema,
  statusChangedAt: z.string(),
  statusReason: StatusReasonSchema,
  priority: WorkItemPrioritySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  archivedAt: z.string().optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const ClaimStateSchema = z.enum(["pending", "resolved", "abandoned"]);
export type ClaimState = z.infer<typeof ClaimStateSchema>;

export const LaunchClaimSchema = z.object({
  workItemId: z.string().min(1),
  attemptId: z.string().min(1),
  generation: z.number().int().positive(),
  state: ClaimStateSchema,
  initiatorClientInstanceId: z.string().optional(),
  initiatorLabel: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAgentId: z.string().optional(),
  lastErrorCode: z.string().optional(),
  lastErrorMessage: z.string().optional(),
});
export type LaunchClaim = z.infer<typeof LaunchClaimSchema>;

export const SeedPromptSourceSchema = z.enum(["work-item-default", "launch-edited"]);
export type SeedPromptSource = z.infer<typeof SeedPromptSourceSchema>;
export const UserDispositionSchema = z.enum(["active", "abandoned"]);
export type UserDisposition = z.infer<typeof UserDispositionSchema>;
export const AttemptFactSchema = z.enum([
  "journal",
  "workspace-request",
  "workspace-observation",
  "agent-request",
  "agent-observation",
  "user-disposition",
]);
export type AttemptFact = z.infer<typeof AttemptFactSchema>;

export const AttemptSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  claimGeneration: z.number().int().positive(),
  requestFingerprint: z.string().min(1),
  projectIdSnapshot: z.string().min(1),
  projectNameSnapshot: z.string(),
  titleSnapshot: z.string(),
  seedPromptSnapshot: z.string(),
  seedPromptSource: SeedPromptSourceSchema,
  clientMessageId: z.string().min(1),
  initiatorClientInstanceId: z.string().optional(),
  initiatorLabel: z.string(),
  factVersions: z.partialRecord(AttemptFactSchema, z.number().int().nonnegative()).default({}),
  journalPreparedAt: z.string().optional(),
  workspaceRequestStartedAt: z.string().optional(),
  workspaceOutcomeUnknownObservedAt: z.string().optional(),
  workspaceIdHint: z.string().optional(),
  workspaceObservedAt: z.string().optional(),
  agentRequestStartedAt: z.string().optional(),
  agentOutcomeUnknownObservedAt: z.string().optional(),
  firstAgentObservedAt: z.string().optional(),
  userDisposition: UserDispositionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  abandonedAt: z.string().optional(),
  lastLaunchErrorCode: z.string().optional(),
  lastLaunchErrorMessage: z.string().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const PromptDeliverySchema = z.enum(["not_submitted", "unknown", "observed"]);
export type PromptDelivery = z.infer<typeof PromptDeliverySchema>;

export const TodoAgentDisplayStateSchema = z.enum([
  "initializing",
  "running",
  "permission",
  "error",
  "waiting_confirmation",
  "closed",
  "unavailable",
]);
export type TodoAgentDisplayState = z.infer<typeof TodoAgentDisplayStateSchema>;

export const AgentLinkSchema = z.object({
  agentId: z.string().min(1),
  attemptId: z.string().min(1),
  workItemId: z.string().min(1),
  workspaceId: z.string().optional(),
  observedProjectId: z.string().optional(),
  provider: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  displayState: TodoAgentDisplayStateSchema,
  rawStatus: z.string().optional(),
  rawAttentionReason: z.string().optional(),
  providerUnavailable: z.boolean().optional(),
  promptDelivery: PromptDeliverySchema,
  staleSince: z.string().optional(),
  lastRefreshErrorCode: z.string().optional(),
  firstObservedAt: z.string(),
  stateChangedAt: z.string(),
  archivedAt: z.string().optional(),
});
export type AgentLink = z.infer<typeof AgentLinkSchema>;

export const RetiredWorkItemIdSchema = z.object({
  id: z.string().min(1),
  creationFingerprint: z.string().min(1),
  retiredAt: z.string(),
});
export type RetiredWorkItemId = z.infer<typeof RetiredWorkItemIdSchema>;

export const TodoDocumentSchema = z.object({
  /** Empty until the server initializes the document; regenerated on explicit reset. */
  incarnationId: z.string().default(""),
  seq: z.number().int().nonnegative().default(0),
  nextWorkItemNumber: z.number().int().positive().default(1),
  workItems: z.record(z.string(), WorkItemSchema).default({}),
  claims: z.record(z.string(), LaunchClaimSchema).default({}),
  attempts: z.record(z.string(), AttemptSchema).default({}),
  agentLinks: z.record(z.string(), AgentLinkSchema).default({}),
  retiredWorkItemIds: z.array(RetiredWorkItemIdSchema).default([]),
});
export type TodoDocument = z.output<typeof TodoDocumentSchema>;
export type TodoDocumentInput = z.input<typeof TodoDocumentSchema>;

export const todoData = defineSettings({
  id: TODO_SETTINGS_ID,
  scope: "host",
  version: TODO_SETTINGS_VERSION,
  schema: TodoDocumentSchema,
  migrate: migrateTodoDocument,
});

export function emptyTodoDocument(): TodoDocument {
  return TodoDocumentSchema.parse({});
}
