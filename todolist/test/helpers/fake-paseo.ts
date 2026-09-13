import type { PluginServerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginServerContext["paseo"];

type AgentUpdate = Parameters<Parameters<PaseoApi["agents"]["subscribe"]>[0]>[0];
type ListResult = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
type ListEntry = ListResult["entries"][number];
export type FakeAgent = ListEntry["agent"];
type Placement = ListEntry["project"];
type TimelinePage = Awaited<
  ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>
>;

export interface FakeAgentRecord {
  agent: FakeAgent;
  projectId: string | null;
  workspaceProjectId?: string;
  timeline?: string[];
  refreshError?: Error;
}

export function fakeAgent(input: {
  id: string;
  labels?: Record<string, string>;
  status?: FakeAgent["status"];
  updatedAt?: string;
  workspaceId?: string;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissions?: number;
  providerUnavailable?: boolean;
  archivedAt?: string | null;
  model?: string | null;
}): FakeAgent {
  const permissions = Array.from({ length: input.pendingPermissions ?? 0 }, (_, index) => ({
    id: `perm-${index}`,
    name: "tool",
    kind: "tool" as const,
    input: {},
  }));
  return {
    id: input.id,
    provider: "codex",
    cwd: "/repo",
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    model: input.model ?? "gpt",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-09-11T00:00:01.000Z",
    lastUserMessageAt: null,
    status: input.status ?? "running",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: permissions as never,
    persistence: null,
    title: null,
    labels: input.labels ?? {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    archivedAt: input.archivedAt ?? null,
    providerUnavailable: input.providerUnavailable ?? false,
  } as FakeAgent;
}

function placement(projectId: string): Placement {
  return {
    projectKey: projectId,
    projectName: "Project",
    workspaceName: null,
    checkout: { kind: "directory" } as never,
  } as Placement;
}

export interface FakePaseo {
  api: PaseoApi;
  agents: Map<string, FakeAgentRecord>;
  projects: Set<string>;
  listCalls: Array<{
    subscribe: boolean;
    subscriptionId: string | undefined;
    labels: Record<string, string> | undefined;
    cursor?: string;
  }>;
  refreshCalls: string[];
  timelineCalls: string[];
  pageSize: number;
  emit(update: AgentUpdate): void;
  hooks: Map<string, Array<(event: unknown, context: { signal: AbortSignal }) => unknown>>;
  on: PluginServerContext["on"];
  fireHook(name: string, event: unknown): Promise<void>;
  listGate: { resolve: () => void; promise: Promise<void> } | null;
}

export function createFakePaseo(): FakePaseo {
  const agents = new Map<string, FakeAgentRecord>();
  const projects = new Set<string>(["project-1"]);
  const listeners = new Set<(update: AgentUpdate) => void>();
  const hooks = new Map<string, Array<(event: unknown, context: { signal: AbortSignal }) => unknown>>();
  const state: FakePaseo = {
    api: null as never,
    agents,
    projects,
    listCalls: [],
    refreshCalls: [],
    timelineCalls: [],
    pageSize: 200,
    emit(update) {
      for (const listener of listeners) listener(update);
    },
    hooks,
    on: ((name: string, handler: (event: never, context: never) => unknown) => {
      const list = hooks.get(name) ?? [];
      list.push(handler as never);
      hooks.set(name, list);
      return () => {
        const current = hooks.get(name) ?? [];
        hooks.set(
          name,
          current.filter((entry) => entry !== handler),
        );
      };
    }) as PluginServerContext["on"],
    async fireHook(name, event) {
      const controller = new AbortController();
      for (const handler of hooks.get(name) ?? []) await handler(event, { signal: controller.signal });
    },
    listGate: null,
  };

  const matches = (record: FakeAgentRecord, labels?: Record<string, string>) =>
    !labels || Object.entries(labels).every(([key, value]) => record.agent.labels?.[key] === value);

  const timelinePage = (record: FakeAgentRecord | undefined, from: number, limit: number): TimelinePage => {
    const messages = record?.timeline ?? [];
    const end = from;
    const start = Math.max(0, end - limit);
    const slice = messages.slice(start, end);
    return {
      requestId: "r",
      agentId: record?.agent.id ?? "",
      agent: null,
      direction: "tail",
      projection: "canonical",
      epoch: "e",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 0, maxSeq: messages.length, nextSeq: messages.length },
      startCursor: start > 0 ? { epoch: "e", seq: start } : null,
      endCursor: null,
      hasOlder: start > 0,
      hasNewer: false,
      entries: slice.map((clientMessageId, index) => ({
        provider: "codex",
        item: { type: "user_message", text: "prompt", clientMessageId } as never,
        timestamp: "t",
        seqStart: start + index,
        seqEnd: start + index,
        sourceSeqRanges: [],
        collapsed: [],
      })),
      error: null,
    } as unknown as TimelinePage;
  };

  const api = {
    agents: {
      async list(options?: { filter?: { labels?: Record<string, string> }; page?: { cursor?: string; limit: number }; subscribe?: unknown }) {
        const subscribe = options?.subscribe as { subscriptionId?: string } | undefined;
        state.listCalls.push({
          subscribe: Boolean(subscribe),
          subscriptionId: subscribe?.subscriptionId,
          labels: options?.filter?.labels,
          ...(options?.page?.cursor ? { cursor: options.page.cursor } : {}),
        });
        // Snapshot at call time, then (optionally) delay delivery, like a page in transit.
        const all = [...agents.values()]
          .filter((record) => matches(record, options?.filter?.labels))
          .map((record) => ({ ...record, agent: { ...record.agent } }));
        if (state.listGate) await state.listGate.promise;
        const offset = options?.page?.cursor ? Number(options.page.cursor) : 0;
        const limit = Math.min(options?.page?.limit ?? 200, state.pageSize);
        const page = all.slice(offset, offset + limit);
        const next = offset + limit < all.length ? String(offset + limit) : null;
        return {
          requestId: "r",
          entries: page.map((record) => ({
            agent: record.agent,
            project: placement(record.projectId ?? "unknown"),
          })),
          pageInfo: { nextCursor: next, prevCursor: null, hasMore: next !== null },
        } as unknown as ListResult;
      },
      ref(id: string) {
        return {
          id,
          async refresh() {
            state.refreshCalls.push(id);
            const record = agents.get(id);
            if (!record) throw Object.assign(new Error("not found"), { code: "agent_not_found" });
            if (record.refreshError) throw record.refreshError;
            return {
              agent: record.agent,
              project: record.projectId ? placement(record.projectId) : null,
            };
          },
          timeline: {
            async refetch(options?: { direction?: string; cursor?: { seq: number }; limit?: number }) {
              state.timelineCalls.push(id);
              const record = agents.get(id);
              const total = record?.timeline?.length ?? 0;
              const from = options?.direction === "before" && options.cursor ? options.cursor.seq : total;
              return timelinePage(record, from, options?.limit ?? 200);
            },
          },
        } as unknown as ReturnType<PaseoApi["agents"]["ref"]>;
      },
      subscribe(handler: (update: AgentUpdate) => void) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
    workspaces: {
      ref(workspaceId: string) {
        return {
          async refresh() {
            const record = [...agents.values()].find((entry) => entry.agent.workspaceId === workspaceId);
            const projectId = record?.workspaceProjectId;
            return projectId ? { id: workspaceId, projectId } : null;
          },
        };
      },
    },
    projects: {
      async list() {
        return { requestId: "r", projects: [...projects].map((projectId) => ({ projectId })) };
      },
    },
  } as unknown as PaseoApi;
  state.api = api;
  return state;
}
