import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoReconciler } from "../server/reconcile";
import { registerTodoHandlers } from "../server/handlers";
import { buildTodoLabels } from "../shared/labels";
import { acquireLaunch, checkLaunch } from "../shared/contracts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createFakePaseo, fakeAgent, type FakePaseo } from "./helpers/fake-paseo";
import { createStore, launchInput, silentLogger } from "./helpers/setup";
import { createWorkItemMutation, acquireLaunchMutation } from "../server/mutations";
import { createInput } from "./helpers/setup";

interface Harness {
  paseo: FakePaseo;
  store: ReturnType<typeof createStore>["store"];
  document: ReturnType<typeof createStore>["document"];
  reconciler: TodoReconciler;
  stop: () => Promise<void>;
  log: ReturnType<typeof silentLogger>;
}

async function seedWorkItemAndClaim(store: Harness["store"], workItemId: string, attemptId: string) {
  await store.ensureIncarnation();
  await store.mutate({
    expectedIncarnationId: "inc-1",
    kind: "user",
    mutate: (doc, now) => createWorkItemMutation(doc, createInput(workItemId), now),
  });
  await store.mutate({
    expectedIncarnationId: "inc-1",
    kind: "user",
    mutate: (doc, now) => acquireLaunchMutation(doc, launchInput(workItemId, attemptId), now),
  });
}

function harness(options: { start?: boolean } = {}): Harness {
  const paseo = createFakePaseo();
  const { store, document } = createStore();
  const log = silentLogger();
  const reconciler = new TodoReconciler({
    paseo: paseo.api,
    store,
    on: paseo.on,
    log,
    intervals: { activeMs: 1000, idleMs: 5000, jitterMs: 0, refreshBackoffBaseMs: 10, refreshBackoffMaxMs: 20, refreshMaxAttempts: 3 },
    timelineBudget: { pageLimit: 2, maxPages: 2, maxMs: 1000, retryAfterMs: 0 },
  });
  const stop = options.start === false ? async () => undefined : reconciler.start();
  return { paseo, store, document, reconciler, stop, log };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const item of harnesses.splice(0)) await item.stop();
});

describe("bootstrap and subscription", () => {
  it("initializes the document, scans markers with exactly one subscribe, and links verified agents", async () => {
    const paseo = createFakePaseo();
    const { store, document } = createStore();
    await seedWorkItemAndClaim(store, "wi-1", "att-1");
    paseo.pageSize = 1;
    paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), workspaceId: "wks-1" }), projectId: "project-1", timeline: ["msg-att-1"] });
    paseo.agents.set("agent-x", { agent: fakeAgent({ id: "agent-x", labels: buildTodoLabels("wi-missing", "att-missing") }), projectId: "project-1" });
    const log = silentLogger();
    const reconciler = new TodoReconciler({ paseo: paseo.api, store, on: paseo.on, log, intervals: { jitterMs: 0, idleMs: 100000, activeMs: 100000 } });
    const stop = reconciler.start();
    harnesses.push({ paseo, store, document, reconciler, stop, log });
    await vi.waitFor(() => expect(document.current().agentLinks["agent-1"]).toBeDefined());
    expect(paseo.listCalls.filter((call) => call.subscribe)).toHaveLength(1);
    expect(paseo.listCalls[0]).toMatchObject({ subscribe: true, labels: { "paseo.plugin.todo": "v1" } });
    expect(paseo.listCalls[0]?.subscriptionId).toBeUndefined();
    expect(paseo.listCalls.slice(1).every((call) => !call.subscribe)).toBe(true);
    const current = document.current();
    expect(current.agentLinks["agent-1"]).toMatchObject({ attemptId: "att-1", workItemId: "wi-1", displayState: "running", promptDelivery: "observed", workspaceId: "wks-1" });
    expect(current.claims["wi-1"]).toMatchObject({ state: "resolved", resolvedAgentId: "agent-1" });
    expect(current.attempts["att-1"]).toMatchObject({ firstAgentObservedAt: expect.any(String), workspaceObservedAt: expect.any(String) });
    expect(current.agentLinks["agent-x"]).toBeUndefined();
    expect(reconciler.degraded).toBeNull();
  });

  it("registers hooks and the timer even when bootstrap fails, and recovers on the next periodic run", async () => {
    const paseo = createFakePaseo();
    const { store, document } = createStore();
    await seedWorkItemAndClaim(store, "wi-1", "att-1");
    const originalList = paseo.api.agents.list;
    let fail = true;
    const subscribeAttempts: boolean[] = [];
    paseo.api.agents.list = (async (options: unknown) => {
      subscribeAttempts.push(Boolean((options as { subscribe?: unknown } | undefined)?.subscribe));
      if (fail) throw Object.assign(new Error("offline"), { code: "transport" });
      return originalList(options as never);
    }) as never;
    const log = silentLogger();
    const reconciler = new TodoReconciler({ paseo: paseo.api, store, on: paseo.on, log, intervals: { jitterMs: 0, idleMs: 100000, activeMs: 100000 } });
    const stop = reconciler.start();
    harnesses.push({ paseo, store, document, reconciler, stop, log });
    await vi.waitFor(() => expect(reconciler.degraded?.reason).toBe("bootstrap_failed:transport"));
    expect(paseo.hooks.get("agent.created")).toHaveLength(1);
    fail = false;
    paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1") }), projectId: "project-1" });
    await reconciler.runPeriodic();
    await vi.waitFor(() => expect(document.current().agentLinks["agent-1"]).toBeDefined());
    expect(subscribeAttempts).toEqual([true, true]);
    expect(reconciler.degraded).toBeNull();
  });
});

describe("live updates, ordering, and dirty rerun", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("applies live upserts, ignores unknown removes, and refreshes known links on remove", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    await h.reconciler.runPeriodic();
    h.paseo.emit({ kind: "remove", agentId: "ghost" });
    expect(h.paseo.refreshCalls).toEqual([]);
    h.paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running" }), projectId: "project-1" });
    h.paseo.emit({ kind: "upsert", agent: h.paseo.agents.get("agent-1")!.agent, project: { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never } });
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]?.displayState).toBe("running"));
    h.paseo.agents.get("agent-1")!.agent = fakeAgent({ id: "agent-1", labels: {}, status: "idle", updatedAt: "2026-09-11T00:00:02.000Z" });
    h.paseo.emit({ kind: "remove", agentId: "agent-1" });
    await vi.waitFor(() => expect(h.paseo.refreshCalls).toContain("agent-1"));
    // Labels removed, but the known ID still updates by stable ID.
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]?.displayState).toBe("waiting_confirmation"));
    expect(h.document.current().agentLinks["agent-1"]?.attemptId).toBe("att-1");
  });

  it("moves the card with the agent: running → In progress, idle → In review, and logs both moves", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    await h.reconciler.runPeriodic();
    const project = { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never };
    h.paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running" }), projectId: "project-1" });
    h.paseo.emit({ kind: "upsert", agent: h.paseo.agents.get("agent-1")!.agent, project });
    await vi.waitFor(() => expect(h.document.current().workItems["wi-1"]?.status).toBe("in_progress"));
    h.paseo.agents.get("agent-1")!.agent = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "idle", updatedAt: "2026-09-11T00:00:02.000Z" });
    h.paseo.emit({ kind: "upsert", agent: h.paseo.agents.get("agent-1")!.agent, project });
    await vi.waitFor(() => expect(h.document.current().workItems["wi-1"]).toMatchObject({ status: "in_review", statusReason: "agent_finished" }));
    const moves = h.log.lines.filter((line) => line.includes("auto_move"));
    expect(moves).toHaveLength(2);
    expect(moves.join("\n")).not.toContain("Item wi-1");
  });

  it("drops an older paginated snapshot after a newer live upsert without a document write", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const older = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running", updatedAt: "2026-09-11T00:00:01.000Z" });
    const newer = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "idle", updatedAt: "2026-09-11T00:00:05.000Z" });
    h.paseo.agents.set("agent-1", { agent: newer, projectId: "project-1" });
    h.paseo.emit({ kind: "upsert", agent: newer, project: { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never } });
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]?.displayState).toBe("waiting_confirmation"));
    const changesBefore = h.document.changes;
    const seqBefore = h.document.current().seq;
    h.paseo.agents.set("agent-1", { agent: older, projectId: "project-1" });
    await h.reconciler.runPeriodic();
    await settle();
    expect(h.document.current().agentLinks["agent-1"]?.displayState).toBe("waiting_confirmation");
    expect(h.document.current().seq).toBe(seqBefore);
    expect(h.document.changes).toBe(changesBefore);
    expect(h.log.lines.some((line) => line.includes("old_snapshot_dropped"))).toBe(true);
  });

  it("heartbeat-only upserts advance the watermark without a write", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const first = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running", updatedAt: "2026-09-11T00:00:01.000Z" });
    h.paseo.agents.set("agent-1", { agent: first, projectId: "project-1" });
    h.paseo.emit({ kind: "upsert", agent: first, project: { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never } });
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]).toBeDefined());
    const changes = h.document.changes;
    for (let index = 2; index < 6; index += 1) {
      const heartbeat = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running", updatedAt: `2026-09-11T00:00:0${index}.000Z` });
      h.paseo.emit({ kind: "upsert", agent: heartbeat, project: { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never } });
    }
    await settle();
    expect(h.document.changes).toBe(changes);
  });

  it("keeps correlation discovered by a dirty page and coalesces one targeted refresh", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const labelled = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running" });
    h.paseo.agents.set("agent-1", { agent: labelled, projectId: "project-1" });
    let release!: () => void;
    h.paseo.listGate = { promise: new Promise<void>((resolve) => (release = resolve)), resolve: () => release() };
    const periodic = h.reconciler.runPeriodic();
    await settle();
    // While the page is in flight, the directory removes the agent (labels stripped by the user).
    h.paseo.agents.get("agent-1")!.agent = fakeAgent({ id: "agent-1", labels: {}, status: "running", updatedAt: "2026-09-11T00:00:09.000Z" });
    h.paseo.emit({ kind: "remove", agentId: "agent-1" });
    h.paseo.listGate.resolve();
    h.paseo.listGate = null;
    await periodic;
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]).toBeDefined());
    expect(h.document.current().agentLinks["agent-1"]?.attemptId).toBe("att-1");
    await vi.waitFor(() => expect(h.paseo.refreshCalls.filter((id) => id === "agent-1").length).toBeGreaterThanOrEqual(1));
    await settle();
    expect(h.document.current().agentLinks["agent-1"]?.staleSince).toBeUndefined();
  });

  it("marks a rejected refresh stale, keeps the last state and the active gate, and backs off", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const running = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running" });
    h.paseo.agents.set("agent-1", { agent: running, projectId: "project-1" });
    h.paseo.emit({ kind: "upsert", agent: running, project: { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never } });
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]).toBeDefined());
    h.paseo.agents.get("agent-1")!.refreshError = Object.assign(new Error("Agent not found"), { code: "not_found" });
    h.reconciler.enqueueRefresh("agent-1", "test");
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]?.staleSince).toBeDefined());
    expect(h.document.current().agentLinks["agent-1"]).toMatchObject({ displayState: "running", lastRefreshErrorCode: "refresh_rejected:not_found" });
    await vi.waitFor(() => expect(h.paseo.refreshCalls.filter((id) => id === "agent-1").length).toBeGreaterThanOrEqual(2));
    const acquire = acquireLaunchMutation(h.document.current(), launchInput("wi-1", "att-2"), "2026-09-11T11:00:00.000Z");
    expect(acquire).toMatchObject({ status: "stale_agent" });
    // A successful refresh clears the overlay.
    delete h.paseo.agents.get("agent-1")!.refreshError;
    h.reconciler.enqueueRefresh("agent-1", "test-recover");
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]?.staleSince).toBeUndefined());
  });

  it("maps providerUnavailable to unavailable and does not link agents whose placement cannot be verified", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const unplaced = fakeAgent({ id: "agent-2", labels: buildTodoLabels("wi-1", "att-1"), status: "idle", providerUnavailable: true });
    h.paseo.agents.set("agent-2", { agent: unplaced, projectId: null });
    h.paseo.emit({ kind: "upsert", agent: unplaced, project: null });
    await settle();
    expect(h.document.current().agentLinks["agent-2"]).toBeUndefined();
    // Placement becomes resolvable through the workspace on the next refresh.
    h.paseo.agents.get("agent-2")!.agent = fakeAgent({ id: "agent-2", labels: buildTodoLabels("wi-1", "att-1"), status: "idle", providerUnavailable: true, workspaceId: "wks-9", updatedAt: "2026-09-11T00:00:03.000Z" });
    h.paseo.agents.get("agent-2")!.workspaceProjectId = "project-1";
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-2"]?.displayState).toBe("unavailable"));
    // A mismatched project never links.
    const foreign = fakeAgent({ id: "agent-3", labels: buildTodoLabels("wi-1", "att-1"), status: "idle" });
    h.paseo.agents.set("agent-3", { agent: foreign, projectId: "project-other" });
    h.paseo.emit({ kind: "upsert", agent: foreign, project: { projectKey: "project-other", projectName: "O", workspaceName: null, checkout: {} as never } });
    await settle();
    expect(h.document.current().agentLinks["agent-3"]).toBeUndefined();
  });

  it("bounded timeline search sets delivery observed and stops at its budget", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const agent = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "idle" });
    h.paseo.agents.set("agent-1", { agent, projectId: "project-1", timeline: ["msg-att-1", "m2", "m3", "m4", "m5", "m6"] });
    h.paseo.emit({ kind: "upsert", agent, project: { projectKey: "project-1", projectName: "P", workspaceName: null, checkout: {} as never } });
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]).toBeDefined());
    // Two pages of two entries do not reach the first message: stays unknown, no resend.
    expect(h.document.current().agentLinks["agent-1"]?.promptDelivery).toBe("unknown");
    expect(h.paseo.timelineCalls.filter((id) => id === "agent-1")).toHaveLength(2);
    h.paseo.agents.get("agent-1")!.timeline = ["m5", "msg-att-1", "m6"];
    h.paseo.agents.get("agent-1")!.agent = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "idle", updatedAt: "2026-09-11T00:00:07.000Z" });
    h.reconciler.enqueueRefresh("agent-1", "test");
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]?.promptDelivery).toBe("observed"));
  });

  it("hooks refresh created agents and known links only", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    await h.paseo.fireHook("agent.turn_ended", { agent: { id: "unknown-agent" } });
    await settle();
    expect(h.paseo.refreshCalls).not.toContain("unknown-agent");
    h.paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1") }), projectId: "project-1" });
    await h.paseo.fireHook("agent.created", { agent: { id: "agent-1" } });
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]).toBeDefined());
  });
});

describe("handlers", () => {
  it("acquire refreshes known links first and check enqueues a bounded scan", async () => {
    const h = harness();
    harnesses.push(h);
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const server = {
      handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => {
        handlers.set(contract.name, async (input) => handler(input, { paseo: h.paseo.api }));
      },
    } as unknown as Pick<PluginServerContext, "handle">;
    registerTodoHandlers({ server, paseo: h.paseo.api, store: h.store, reconciler: h.reconciler, log: h.log });
    h.paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "running" }), projectId: "project-1" });
    await h.reconciler.runPeriodic();
    await vi.waitFor(() => expect(h.document.current().agentLinks["agent-1"]).toBeDefined());
    // Agent finished on the daemon; acquire must observe it through a fresh refresh.
    h.paseo.agents.get("agent-1")!.agent = fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1"), status: "closed", updatedAt: "2026-09-11T00:00:09.000Z" });
    const { projectAvailable: _ignored, ...input } = launchInput("wi-1", "att-2");
    const acquired = (await handlers.get(acquireLaunch.name)!(input)) as { status: string };
    expect(acquired.status).toBe("ok");
    expect(h.paseo.refreshCalls).toContain("agent-1");
    const checked = (await handlers.get(checkLaunch.name)!({ expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-2" })) as { status: string; enqueuedAgentIds: string[] };
    expect(checked).toMatchObject({ status: "ok", enqueuedAgentIds: ["agent-1"] });
    await vi.waitFor(() => expect(h.paseo.listCalls.some((call) => call.labels?.["paseo.plugin.todo.work-item-id"] === "wi-1")).toBe(true));
    const stale = (await handlers.get(acquireLaunch.name)!({ ...input, expectedIncarnationId: "inc-old" })) as { status: string };
    expect(stale.status).toBe("stale_document");
  });

  it("stop cancels late commits", async () => {
    const h = harness();
    await seedWorkItemAndClaim(h.store, "wi-1", "att-1");
    let release!: () => void;
    h.paseo.listGate = { promise: new Promise<void>((resolve) => (release = resolve)), resolve: () => release() };
    h.paseo.agents.set("agent-1", { agent: fakeAgent({ id: "agent-1", labels: buildTodoLabels("wi-1", "att-1") }), projectId: "project-1" });
    const periodic = h.reconciler.runPeriodic();
    await settle();
    await h.stop();
    release();
    await periodic;
    await settle();
    expect(h.document.current().agentLinks["agent-1"]).toBeUndefined();
  });
});
