import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Persistent Todo document. The Settings definition version is the only schema version; the
 * document does not carry a second one. All maps are canonical; derived indexes are rebuilt in
 * memory by the server.
 */
export const TODO_SETTINGS_ID = "todo-data";
export const TODO_SETTINGS_VERSION = 1;

export const WorkItemStatusSchema = z.enum(["open", "done"]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkItemSchema = z.object({
  id: z.string().min(1),
  creationFingerprint: z.string().min(1),
  version: z.number().int().positive(),
  projectId: z.string().min(1),
  projectNameSnapshot: z.string(),
  projectRootSnapshot: z.string().optional(),
  title: z.string(),
  details: z.string(),
  defaultPrompt: z.string(),
  status: WorkItemStatusSchema,
  rank: z.string().min(1),
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
  projectOrderVersions: z.record(z.string(), z.number().int().nonnegative()).default({}),
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
});

export function emptyTodoDocument(): TodoDocument {
  return TodoDocumentSchema.parse({});
}
