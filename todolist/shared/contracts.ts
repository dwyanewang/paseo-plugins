import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { IMAGE_MAX_COUNT } from "./limits";
import {
  AgentLinkSchema,
  AttemptFactSchema,
  AttemptSchema,
  LaunchClaimSchema,
  SeedPromptSourceSchema,
  WorkItemPrioritySchema,
  WorkItemSchema,
  WorkItemStatusSchema,
} from "./schema";

/**
 * An image reference as the client submits it. The bytes themselves are written to the
 * `todo-images` document first (client-owned); the main document only ever stores this metadata.
 */
export const WorkItemImageInputSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string().min(1),
  name: z.string().optional(),
  byteLength: z.number().int().nonnegative(),
});
export type WorkItemImageInput = z.infer<typeof WorkItemImageInputSchema>;

/**
 * Stable business error codes. Transport errors are never mapped onto these; a rejected RPC
 * promise means the request may or may not have been applied and the client must reload.
 */
export const TODO_ERROR_CODES = [
  "not_found",
  "conflict",
  "id_conflict",
  "retired_id",
  "claim_held",
  "active_agent",
  "stale_agent",
  "project_unavailable",
  "stale_launch",
  "stale_document",
  "launch_key_conflict",
  "wrong_device",
  "invalid_transition",
  "capacity_exceeded",
  "invalid_input",
  "document_invalid",
  "host_incompatible",
] as const;
export const TodoErrorCodeSchema = z.enum(TODO_ERROR_CODES);
export type TodoErrorCode = z.infer<typeof TodoErrorCodeSchema>;

export const TodoErrorSchema = z.object({
  status: TodoErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type TodoError = z.infer<typeof TodoErrorSchema>;

function result<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.union([z.object({ status: z.literal("ok"), ...shape }), TodoErrorSchema]);
}

const fenced = { expectedIncarnationId: z.string().min(1) };

export const ensureDocument = defineRpc({
  name: "todo.document.ensure",
  input: z.object({}),
  output: result({ incarnationId: z.string(), seq: z.number().int() }),
});

export const DegradedStateSchema = z
  .object({ reason: z.string(), since: z.string() })
  .nullable();

export const documentStatus = defineRpc({
  name: "todo.document.status",
  input: z.object({}),
  output: result({
    incarnationId: z.string(),
    degraded: DegradedStateSchema,
    lastReconcileAt: z.string().nullable(),
    pendingRefreshCount: z.number().int().nonnegative(),
  }),
});

export const createWorkItem = defineRpc({
  name: "todo.work-items.create",
  input: z.object({
    ...fenced,
    id: z.string().min(1),
    creationFingerprint: z.string().min(1),
    projectId: z.string().min(1),
    projectNameSnapshot: z.string(),
    projectRootSnapshot: z.string().optional(),
    title: z.string(),
    details: z.string(),
    defaultPrompt: z.string(),
    images: z.array(WorkItemImageInputSchema).optional(),
    /** Initial column: work starts in Backlog or To do, the later columns are reached by moving. */
    status: z.enum(["backlog", "todo"]).optional(),
    priority: WorkItemPrioritySchema.optional(),
  }),
  output: result({ workItem: WorkItemSchema, seq: z.number().int(), created: z.boolean() }),
});

export const updateWorkItem = defineRpc({
  name: "todo.work-items.update",
  input: z.object({
    ...fenced,
    id: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    patch: z.object({
      title: z.string().optional(),
      details: z.string().optional(),
      defaultPrompt: z.string().optional(),
      priority: WorkItemPrioritySchema.optional(),
      /** Replaces the whole image set when present; an empty array clears it. */
      images: z.array(WorkItemImageInputSchema).optional(),
    }),
  }),
  output: result({ workItem: WorkItemSchema, seq: z.number().int() }),
});

export const rebindWorkItemProject = defineRpc({
  name: "todo.work-items.rebind-project",
  input: z.object({
    ...fenced,
    id: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    projectId: z.string().min(1),
    projectNameSnapshot: z.string(),
    projectRootSnapshot: z.string().optional(),
  }),
  output: result({ workItem: WorkItemSchema, seq: z.number().int() }),
});

/**
 * Moves a card to a column. Last writer wins: there is no version check, and `previousStatus`
 * tells the client where the card really was.
 */
export const moveWorkItem = defineRpc({
  name: "todo.work-items.move",
  input: z.object({
    ...fenced,
    id: z.string().min(1),
    status: WorkItemStatusSchema,
  }),
  output: result({ workItem: WorkItemSchema, previousStatus: WorkItemStatusSchema, seq: z.number().int() }),
});

export const setWorkItemArchived = defineRpc({
  name: "todo.work-items.set-archived",
  input: z.object({
    ...fenced,
    id: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    archived: z.boolean(),
  }),
  output: result({ workItem: WorkItemSchema, seq: z.number().int() }),
});

export const purgeWorkItem = defineRpc({
  name: "todo.work-items.purge",
  input: z.object({
    ...fenced,
    id: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    confirm: z.literal(true),
    /** Force after an explicit abandon; late entities will no longer correlate. */
    force: z.boolean().default(false),
  }),
  output: result({ seq: z.number().int() }),
});

export const acquireLaunch = defineRpc({
  name: "todo.launch.acquire",
  input: z.object({
    ...fenced,
    workItemId: z.string().min(1),
    attemptId: z.string().min(1),
    requestFingerprint: z.string().min(1),
    clientMessageId: z.string().min(1),
    seedPrompt: z.string(),
    seedPromptSource: SeedPromptSourceSchema,
    initiatorLabel: z.string(),
    /**
     * Content version the caller launched from. A screen that has been open across an edit holds
     * the old title and details, so the daemon refuses rather than start an agent on them. Replays
     * of an attempt that already exists skip the check: their content is already snapshotted.
     */
    expectedItemVersion: z.number().int().positive().optional(),
  }),
  output: result({
    attempt: AttemptSchema,
    claim: LaunchClaimSchema,
    created: z.boolean(),
    seq: z.number().int(),
  }),
});

export const LaunchProgressFactsSchema = z.object({
  clientInstanceId: z.string().optional(),
  journalPreparedAt: z.string().optional(),
  workspaceRequestStartedAt: z.string().optional(),
  workspaceOutcomeUnknownObservedAt: z.string().optional(),
  workspaceIdHint: z.string().optional(),
  workspaceObservedAt: z.string().optional(),
  agentRequestStartedAt: z.string().optional(),
  agentOutcomeUnknownObservedAt: z.string().optional(),
  firstAgentObservedAt: z.string().optional(),
  lastLaunchErrorCode: z.string().optional(),
  lastLaunchErrorMessage: z.string().optional(),
});

export const reportLaunchProgress = defineRpc({
  name: "todo.launch.progress",
  input: z.object({
    ...fenced,
    attemptId: z.string().min(1),
    generation: z.number().int().positive(),
    facet: AttemptFactSchema,
    factVersion: z.number().int().positive(),
    facts: LaunchProgressFactsSchema,
    /** Fast-path hint from `agent_created`; the server verifies it before linking. */
    agentId: z.string().optional(),
  }),
  output: result({
    attempt: AttemptSchema,
    claim: LaunchClaimSchema.optional(),
    seq: z.number().int(),
  }),
});

export const abandonLaunch = defineRpc({
  name: "todo.launch.abandon",
  input: z.object({
    ...fenced,
    workItemId: z.string().min(1),
    attemptId: z.string().min(1),
    generation: z.number().int().positive(),
    certainty: z.enum(["not_submitted", "outcome_unknown_confirmed"]),
  }),
  output: result({
    attempt: AttemptSchema,
    claim: LaunchClaimSchema.optional(),
    seq: z.number().int(),
  }),
});

/**
 * Drops one finished attempt and its agent links from the Todo history. Agents and workspaces are
 * untouched; a dropped attempt simply stops correlating, so a late agent for it is ignored.
 */
export const forgetAttempt = defineRpc({
  name: "todo.launch.forget",
  input: z.object({
    ...fenced,
    workItemId: z.string().min(1),
    attemptId: z.string().min(1),
  }),
  output: result({ removedAgentIds: z.array(z.string()), seq: z.number().int() }),
});

export const checkLaunch = defineRpc({
  name: "todo.launch.check",
  input: z.object({
    ...fenced,
    workItemId: z.string().min(1),
    attemptId: z.string().optional(),
  }),
  output: result({
    attempt: AttemptSchema.optional(),
    claim: LaunchClaimSchema.optional(),
    links: z.array(AgentLinkSchema),
    enqueuedAgentIds: z.array(z.string()),
  }),
});

/** A card image written to a file on the daemon host, shaped like a host `uploaded_file`. */
export const StagedImageFileSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});
export type StagedImageFile = z.infer<typeof StagedImageFileSchema>;

/**
 * Writes card images from the `todo-images` document to files, so a launch can hand the agent
 * paths it can open at any point in the conversation, not only the inline copy in its first turn.
 */
export const stageImages = defineRpc({
  name: "todo.images.stage",
  input: z.object({ ids: z.array(z.string().min(1)).max(IMAGE_MAX_COUNT) }),
  output: result({ files: z.array(StagedImageFileSchema), missing: z.array(z.string()) }),
});

export const todoRpcs = {
  ensureDocument,
  documentStatus,
  createWorkItem,
  updateWorkItem,
  rebindWorkItemProject,
  moveWorkItem,
  setWorkItemArchived,
  purgeWorkItem,
  acquireLaunch,
  reportLaunchProgress,
  abandonLaunch,
  forgetAttempt,
  checkLaunch,
  stageImages,
} as const;
