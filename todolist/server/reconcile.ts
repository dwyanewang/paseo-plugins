import type { PluginServerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginServerContext["paseo"];
import { TODO_LABEL_WORK_ITEM_ID, TODO_MARKER_FILTER, parseTodoLabels } from "../shared/labels";
import type { TodoDocument } from "../shared/schema";
import { isActiveDisplayState } from "../shared/state";
import {
  applyAgentSnapshotMutation,
  canonicalizeAgentSnapshot,
  markAgentLinkStaleMutation,
  projectionFingerprint,
  type CanonicalAgentProjection,
} from "./apply";
import type { TodoLogger } from "./log";
import type { TodoStore } from "./store";

type ListResult = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
type ListEntry = ListResult["entries"][number];
type AgentUpdate = Parameters<Parameters<PaseoApi["agents"]["subscribe"]>[0]>[0];
type RefreshResult = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>;
type TimelinePage = Awaited<
  ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>
>;

export type SnapshotSource = "bootstrap_page" | "live" | "targeted" | "periodic" | "check";

export interface ReconcilerIntervals {
  activeMs: number;
  idleMs: number;
  jitterMs: number;
  refreshBackoffBaseMs: number;
  refreshBackoffMaxMs: number;
  refreshMaxAttempts: number;
}

export const DEFAULT_INTERVALS: ReconcilerIntervals = {
  // Candidate defaults from the plan; the recovery timer is the fallback, not the primary path.
  activeMs: 60_000,
  idleMs: 10 * 60_000,
  jitterMs: 5_000,
  refreshBackoffBaseMs: 5_000,
  refreshBackoffMaxMs: 5 * 60_000,
  refreshMaxAttempts: 5,
};

export interface TimelineSearchBudget {
  pageLimit: number;
  maxPages: number;
  maxMs: number;
  /** Minimum spacing between two bounded searches for the same agent. */
  retryAfterMs: number;
}

export const DEFAULT_TIMELINE_BUDGET: TimelineSearchBudget = {
  pageLimit: 200,
  maxPages: 3,
  maxMs: 5_000,
  retryAfterMs: 60_000,
};

export interface DegradedState {
  reason: string;
  since: string;
}

export interface ReconcilerOptions {
  paseo: PaseoApi;
  store: TodoStore;
  on: PluginServerContext["on"];
  log: TodoLogger;
  intervals?: Partial<ReconcilerIntervals>;
  timelineBudget?: Partial<TimelineSearchBudget>;
  now?: () => number;
}

interface Watermark {
  updatedAt: string;
  fingerprint: string;
}

interface PendingRefresh {
  reason: string;
  attempts: number;
  ticket: number;
}

interface RefreshWaiter {
  ticket: number;
  resolve: () => void;
}

/**
 * Daemon-side reconciliation. All ordering state (live epoch, per-agent live generation, accepted
 * watermarks, scan epoch) is in-process only. Every source funnels into `applySnapshot`.
 */
export class TodoReconciler {
  private readonly paseo: PaseoApi;
  private readonly store: TodoStore;
  private readonly on: PluginServerContext["on"];
  private readonly log: TodoLogger;
  private readonly intervals: ReconcilerIntervals;
  private readonly timelineBudget: TimelineSearchBudget;
  private readonly now: () => number;

  private stopped = false;
  private runGeneration = 0;
  private abort = new AbortController();
  private liveEpoch = 0;
  private readonly lastLiveEpochByAgentId = new Map<string, number>();
  private readonly watermarks = new Map<string, Watermark>();
  private readonly candidates = new Set<string>();
  private readonly candidateAttempts = new Map<string, number>();
  private readonly rerunCounts = new Map<string, number>();
  private readonly knownLinkIds = new Set<string>();
  private readonly workspaceProjects = new Map<string, string>();
  private readonly pending = new Map<string, PendingRefresh>();
  private readonly waiters = new Map<string, Set<RefreshWaiter>>();
  private ticketSeq = 0;
  private readonly backoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timelineSearchedAt = new Map<string, number>();
  private pumping: Promise<void> | null = null;
  private periodicTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicRunning = false;
  private subscriptionCarried = false;
  private cleanups: Array<() => void> = [];
  private degradedState: DegradedState | null = null;
  private lastReconcileAt: string | null = null;
  private documentReady = false;
  private incarnationId = "";

  constructor(options: ReconcilerOptions) {
    this.paseo = options.paseo;
    this.store = options.store;
    this.on = options.on;
    this.log = options.log;
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.timelineBudget = { ...DEFAULT_TIMELINE_BUDGET, ...options.timelineBudget };
    this.now = options.now ?? (() => Date.now());
  }

  get degraded(): DegradedState | null {
    return this.degradedState;
  }

  get lastReconcile(): string | null {
    return this.lastReconcileAt;
  }

  get pendingRefreshCount(): number {
    return this.pending.size;
  }

  get currentIncarnationId(): string {
    return this.incarnationId;
  }

  /** Synchronous registration; bootstrap runs asynchronously. Returns async cleanup. */
  start(): () => Promise<void> {
    const generation = ++this.runGeneration;
    this.cleanups.push(this.paseo.agents.subscribe((update) => this.onLiveUpdate(update)));
    const enqueueKnown = (agentId: string, reason: string) => {
      if (this.knownLinkIds.has(agentId) || this.candidates.has(agentId)) {
        this.enqueueRefresh(agentId, reason);
      }
    };
    this.cleanups.push(
      this.on("agent.created", (event, context) => {
        if (context.signal.aborted) return;
        // Creation is rare and lifecycle payloads carry no labels: refresh to discover correlation.
        this.enqueueRefresh(event.agent.id, "hook:agent.created");
      }),
      this.on("agent.turn_started", (event, context) => {
        if (!context.signal.aborted) enqueueKnown(event.agent.id, "hook:turn_started");
      }),
      this.on("agent.turn_ended", (event, context) => {
        if (!context.signal.aborted) enqueueKnown(event.agent.id, "hook:turn_ended");
      }),
      this.on("agent.permission_requested", (event, context) => {
        if (!context.signal.aborted) enqueueKnown(event.agent.id, "hook:permission_requested");
      }),
      this.on("agent.permission_resolved", (event, context) => {
        if (!context.signal.aborted) enqueueKnown(event.agent.id, "hook:permission_resolved");
      }),
      this.on("agent.archived", (event, context) => {
        if (!context.signal.aborted) enqueueKnown(event.agent.id, "hook:archived");
      }),
    );
    void this.bootstrap(generation);
    this.schedulePeriodic();
    return async () => {
      this.stopped = true;
      this.runGeneration += 1;
      this.abort.abort();
      if (this.periodicTimer) clearTimeout(this.periodicTimer);
      this.periodicTimer = null;
      for (const timer of this.backoffTimers.values()) clearTimeout(timer);
      this.backoffTimers.clear();
      for (const cleanup of this.cleanups.splice(0)) cleanup();
      for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.resolve();
      this.waiters.clear();
      this.pending.clear();
      // Bounded wait for the in-flight worker; late results cannot commit (generation check).
      await Promise.race([this.pumping ?? Promise.resolve(), delay(2_000)]);
    };
  }

  private async bootstrap(generation: number): Promise<void> {
    const started = this.now();
    try {
      const ensured = await this.store.ensureIncarnation();
      if (ensured.status !== "ok") {
        this.setDegraded(`document_${ensured.details?.code ?? ensured.status}`);
        return;
      }
      if (this.isStale(generation)) return;
      this.documentReady = true;
      this.incarnationId = ensured.document.incarnationId;
      this.indexDocument(ensured.document);
      if (ensured.initialized) this.log.info("document_initialized", { incarnationId: this.incarnationId });
      const scanned = await this.markerScan(generation, "bootstrap_page", {
        subscribe: !this.subscriptionCarried,
      });
      if (this.isStale(generation)) return;
      for (const agentId of this.knownLinkIds) this.enqueueRefresh(agentId, "bootstrap_known");
      this.clearDegraded();
      this.lastReconcileAt = new Date(this.now()).toISOString();
      this.log.info("bootstrap_complete", {
        source: "bootstrap",
        scanned,
        knownRefreshed: this.knownLinkIds.size,
        durationMs: this.now() - started,
      });
    } catch (error) {
      if (this.isStale(generation)) return;
      this.setDegraded(`bootstrap_failed:${errorCode(error)}`);
      this.log.error("bootstrap_failed", { code: errorCode(error) });
    }
  }

  private indexDocument(document: TodoDocument): void {
    this.knownLinkIds.clear();
    for (const agentId of Object.keys(document.agentLinks)) this.knownLinkIds.add(agentId);
  }

  private isStale(generation: number): boolean {
    return this.stopped || generation !== this.runGeneration;
  }

  private setDegraded(reason: string): void {
    if (this.degradedState?.reason === reason) return;
    this.degradedState = { reason, since: new Date(this.now()).toISOString() };
    this.log.once(`degraded:${reason}`, "warn", "degraded", { reason });
  }

  private clearDegraded(): void {
    if (!this.degradedState) return;
    this.log.clear(`degraded:${this.degradedState.reason}`);
    this.degradedState = null;
    this.log.info("degraded_cleared");
  }

  /**
   * Marker scan: the first successful scan establishes the host-owned subscription. Every later
   * page and periodic/manual scan omits it; a failed establishment may be retried by recovery.
   */
  private async markerScan(
    generation: number,
    source: SnapshotSource,
    options: { subscribe: boolean; labels?: Record<string, string>; maxPages?: number },
  ): Promise<number> {
    let cursor: string | undefined;
    let scanned = 0;
    let pages = 0;
    const labels = options.labels ?? { ...TODO_MARKER_FILTER };
    do {
      const capturedEpoch = this.liveEpoch;
      const carrySubscribe = options.subscribe && pages === 0;
      const result = await this.paseo.agents.list({
        filter: { labels, includeArchived: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
        ...(carrySubscribe ? { subscribe: {} } : {}),
      });
      if (carrySubscribe) this.subscriptionCarried = true;
      if (this.isStale(generation)) return scanned;
      pages += 1;
      for (const entry of result.entries) {
        scanned += 1;
        await this.applyEntry(generation, entry, source, capturedEpoch);
        if (this.isStale(generation)) return scanned;
      }
      cursor = result.pageInfo.nextCursor ?? undefined;
    } while (cursor && (options.maxPages === undefined || pages < options.maxPages));
    return scanned;
  }

  private async applyEntry(
    generation: number,
    entry: ListEntry,
    source: SnapshotSource,
    capturedEpoch: number,
  ): Promise<void> {
    const projectId = await this.resolvePlacement(entry.agent, entry.project ?? null);
    if (this.isStale(generation)) return;
    await this.applySnapshot(generation, {
      source,
      capturedEpoch,
      projection: canonicalizeAgentSnapshot({ agent: entry.agent, projectId }),
    });
  }

  private onLiveUpdate(update: AgentUpdate): void {
    const generation = this.runGeneration;
    this.liveEpoch += 1;
    const agentId = update.kind === "upsert" ? update.agent.id : update.agentId;
    this.lastLiveEpochByAgentId.set(agentId, this.liveEpoch);
    if (update.kind === "remove") {
      // Leaving the filter is not a deletion proof. Known or candidate IDs get a targeted check.
      if (this.knownLinkIds.has(agentId) || this.candidates.has(agentId)) {
        this.log.info("directory_remove", { agentId, action: "targeted_refresh" });
        this.enqueueRefresh(agentId, "directory_remove");
      }
      return;
    }
    void (async () => {
      const projectId = await this.resolvePlacement(update.agent, update.project ?? null);
      if (this.isStale(generation)) return;
      await this.applySnapshot(generation, {
        source: "live",
        capturedEpoch: this.liveEpoch,
        projection: canonicalizeAgentSnapshot({ agent: update.agent, projectId }),
      });
    })().catch((error) => this.log.warn("live_apply_failed", { agentId, code: errorCode(error) }));
  }

  /** Placement verification: the placement key is the project ID; otherwise resolve the workspace. */
  private async resolvePlacement(
    agent: { workspaceId?: string | null },
    project: { projectKey: string } | null,
  ): Promise<string | undefined> {
    if (project?.projectKey) return project.projectKey;
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return undefined;
    const cached = this.workspaceProjects.get(workspaceId);
    if (cached) return cached;
    try {
      const workspace = await this.paseo.workspaces.ref(workspaceId).refresh();
      const projectId = workspace?.projectId;
      if (projectId) this.workspaceProjects.set(workspaceId, projectId);
      return projectId ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The single per-agent apply path. Correlation discovery precedes and survives the dirty and
   * watermark gates; only the mutable projection is gated.
   */
  private async applySnapshot(
    generation: number,
    input: {
      source: SnapshotSource;
      capturedEpoch: number;
      projection: CanonicalAgentProjection;
      capturedLiveGeneration?: number;
    },
  ): Promise<void> {
    if (!this.documentReady || this.isStale(generation)) return;
    const { projection, source } = input;
    const agentId = projection.agentId;
    const known = this.knownLinkIds.has(agentId);
    const correlation = parseTodoLabels(projection.labels);

    if (!known && !correlation) {
      this.log.once(`orphan:${agentId}`, "info", "orphan_agent", { agentId, source });
      return;
    }

    const liveAfter = this.lastLiveEpochByAgentId.get(agentId) ?? 0;
    const dirty =
      source === "live"
        ? false
        : source === "targeted"
          ? liveAfter !== (input.capturedLiveGeneration ?? 0)
          : liveAfter > input.capturedEpoch;

    const fingerprint = projectionFingerprint(projection);
    const watermark = this.watermarks.get(agentId);
    let allowProjection = !dirty;
    let coalesceRefresh = dirty;
    if (allowProjection && watermark) {
      if (projection.updatedAt < watermark.updatedAt) {
        allowProjection = false;
      } else if (projection.updatedAt === watermark.updatedAt && fingerprint !== watermark.fingerprint) {
        if (source === "bootstrap_page" || source === "periodic" || source === "check") {
          allowProjection = false;
          coalesceRefresh = true;
        }
      }
    }

    if (!known && !projection.projectId) {
      // Cannot verify placement yet: keep an in-memory candidate and re-verify with backoff; never guess.
      this.scheduleCandidateRetry(agentId, "unverified_placement");
      return;
    }

    let promptObserved = false;
    if (allowProjection) {
      const document = await this.store.read();
      if (document.status !== "ok" || this.isStale(generation)) return;
      const link = document.document.agentLinks[agentId];
      const attempt = link
        ? document.document.attempts[link.attemptId]
        : correlation
          ? document.document.attempts[correlation.attemptId]
          : undefined;
      if (attempt && link?.promptDelivery !== "observed") {
        promptObserved = await this.searchPromptDelivery(generation, agentId, attempt.clientMessageId);
        if (this.isStale(generation)) return;
      }
    }

    const outcome = await this.store.mutate({
      expectedIncarnationId: null,
      kind: "recovery",
      mutate: (document, now) =>
        applyAgentSnapshotMutation(document, { projection, allowProjection, promptObserved }, now),
    });
    if (this.isStale(generation)) return;
    if (outcome.status !== "ok") {
      if (outcome.status === "document_invalid") this.setDegraded("document_invalid");
      this.log.once(`apply_failed:${agentId}:${outcome.status}`, "warn", "apply_failed", {
        agentId,
        source,
        code: outcome.status,
        tier: outcome.details?.tier,
      });
      return;
    }
    this.log.clear(`apply_failed:${agentId}:capacity_exceeded`);
    const result = outcome.result;
    if (result.linked) {
      this.knownLinkIds.add(agentId);
      this.candidates.delete(agentId);
      this.candidateAttempts.delete(agentId);
      this.log.info("agent_linked", {
        agentId,
        attemptId: result.link?.attemptId,
        workItemId: result.link?.workItemId,
        source,
        stale: Boolean(result.link?.staleSince),
        claimResolved: result.claimResolved,
      });
    } else if (result.rejection && result.rejection !== "projection_deferred") {
      const key = `rejection:${agentId}:${result.rejection}`;
      this.log.once(key, "info", "correlation_rejected", { agentId, source, reason: result.rejection });
      if (result.rejection === "unverified_placement") {
        this.scheduleCandidateRetry(agentId, "unverified_placement");
        coalesceRefresh = false;
      }
    }
    if (allowProjection) {
      this.watermarks.set(agentId, { updatedAt: projection.updatedAt, fingerprint });
      if (source === "targeted") this.rerunCounts.delete(agentId);
      if (result.projectionChanged) {
        this.log.info("projection_changed", {
          agentId,
          source,
          displayState: result.link?.displayState,
          seq: outcome.seq,
        });
      }
    } else {
      this.log.info(dirty ? "dirty_snapshot_deferred" : "old_snapshot_dropped", { agentId, source });
    }
    if (coalesceRefresh && (this.knownLinkIds.has(agentId) || this.candidates.has(agentId))) {
      this.scheduleRerun(agentId, dirty ? "dirty_rerun" : "same_updated_at_conflict");
    }
  }

  /** One immediate rerun per burst; further reruns back off so a refresh never schedules itself forever. */
  private scheduleRerun(agentId: string, reason: string): void {
    const count = (this.rerunCounts.get(agentId) ?? 0) + 1;
    this.rerunCounts.set(agentId, count);
    if (count <= 1) {
      this.enqueueRefresh(agentId, reason);
      return;
    }
    this.scheduleRetry(agentId, { reason, attempts: count - 1 }, "rerun");
  }

  private scheduleCandidateRetry(agentId: string, reason: string): void {
    const attempts = (this.candidateAttempts.get(agentId) ?? 0) + 1;
    this.candidateAttempts.set(agentId, attempts);
    this.candidates.add(agentId);
    this.scheduleRetry(agentId, { reason, attempts }, "unverified_placement");
  }

  enqueueRefresh(agentId: string, reason: string, attempts = 0): number {
    if (this.stopped) return -1;
    const existing = this.pending.get(agentId);
    if (existing) return existing.ticket;
    const ticket = ++this.ticketSeq;
    this.pending.set(agentId, { reason, attempts, ticket });
    this.pump();
    return ticket;
  }

  /**
   * Awaits a refresh of each agent that starts after this call (bounded by the caller's timeout).
   * A refresh already in flight cannot satisfy the wait: its snapshot predates the caller.
   */
  awaitRefresh(agentIds: readonly string[], timeoutMs: number): Promise<void> {
    const waits = agentIds.map(
      (agentId) =>
        new Promise<void>((resolve) => {
          const ticket = this.enqueueRefresh(agentId, "await_refresh");
          if (ticket < 0) {
            resolve();
            return;
          }
          const set = this.waiters.get(agentId) ?? new Set<RefreshWaiter>();
          set.add({ ticket, resolve });
          this.waiters.set(agentId, set);
        }),
    );
    return Promise.race([Promise.all(waits).then(() => undefined), delay(timeoutMs)]);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = this.drain().finally(() => {
      this.pumping = null;
      if (this.pending.size > 0 && !this.stopped) this.pump();
    });
  }

  private async drain(): Promise<void> {
    const generation = this.runGeneration;
    while (!this.stopped && this.pending.size > 0) {
      const [agentId, entry] = this.pending.entries().next().value as [string, PendingRefresh];
      this.pending.delete(agentId);
      const timer = this.backoffTimers.get(agentId);
      if (timer) {
        clearTimeout(timer);
        this.backoffTimers.delete(agentId);
      }
      await this.refreshOne(generation, agentId, entry);
      const waiters = this.waiters.get(agentId);
      if (waiters) {
        for (const waiter of [...waiters]) {
          if (waiter.ticket > entry.ticket) continue;
          waiters.delete(waiter);
          waiter.resolve();
        }
        if (waiters.size === 0) this.waiters.delete(agentId);
      }
    }
  }

  private async refreshOne(generation: number, agentId: string, entry: PendingRefresh): Promise<void> {
    const capturedLiveGeneration = this.lastLiveEpochByAgentId.get(agentId) ?? 0;
    let result: RefreshResult | null;
    try {
      result = await this.paseo.agents.ref(agentId).refresh();
    } catch (error) {
      if (this.isStale(generation)) return;
      // Reject is the only failure class: not-found, invisible, and transport all look alike.
      await this.markStale(generation, agentId, `refresh_rejected:${errorCode(error)}`);
      this.scheduleRetry(agentId, entry, errorCode(error));
      return;
    }
    if (this.isStale(generation)) return;
    if (!result) {
      // Unreachable on the current daemon (main returns error instead); treat as stale.
      await this.markStale(generation, agentId, "refresh_null");
      this.scheduleRetry(agentId, entry, "null");
      return;
    }
    const projectId = await this.resolvePlacement(result.agent, result.project ?? null);
    if (this.isStale(generation)) return;
    await this.applySnapshot(generation, {
      source: "targeted",
      capturedEpoch: this.liveEpoch,
      capturedLiveGeneration,
      projection: canonicalizeAgentSnapshot({ agent: result.agent, projectId }),
    });
  }

  private async markStale(generation: number, agentId: string, errorCode: string): Promise<void> {
    if (!this.knownLinkIds.has(agentId)) return;
    const outcome = await this.store.mutate({
      expectedIncarnationId: null,
      kind: "recovery",
      mutate: (document, now) => markAgentLinkStaleMutation(document, { agentId, errorCode }, now),
    });
    if (this.isStale(generation)) return;
    if (outcome.status === "ok" && outcome.changed) {
      this.log.once(`stale:${agentId}`, "warn", "agent_stale", { agentId, code: errorCode });
    }
  }

  private scheduleRetry(
    agentId: string,
    entry: Pick<PendingRefresh, "reason" | "attempts">,
    code: string,
  ): void {
    if (this.stopped) return;
    const attempts = entry.attempts + 1;
    if (attempts >= this.intervals.refreshMaxAttempts) {
      this.log.once(`refresh_gave_up:${agentId}`, "warn", "refresh_backoff_exhausted", {
        agentId,
        code,
        attempts,
      });
      return;
    }
    const wait = Math.min(
      this.intervals.refreshBackoffBaseMs * 2 ** (attempts - 1),
      this.intervals.refreshBackoffMaxMs,
    );
    const timer = setTimeout(() => {
      this.backoffTimers.delete(agentId);
      if (this.stopped || this.pending.has(agentId)) return;
      this.enqueueRefresh(agentId, `retry:${entry.reason}`, attempts);
    }, wait);
    this.backoffTimers.set(agentId, timer);
  }

  /** Bounded canonical timeline search for the launch message. Never sends anything. */
  private async searchPromptDelivery(
    generation: number,
    agentId: string,
    clientMessageId: string,
  ): Promise<boolean> {
    const last = this.timelineSearchedAt.get(agentId);
    if (last !== undefined && this.now() - last < this.timelineBudget.retryAfterMs) return false;
    this.timelineSearchedAt.set(agentId, this.now());
    const started = this.now();
    const handle = this.paseo.agents.ref(agentId);
    let page: TimelinePage;
    try {
      page = await handle.timeline.refetch({
        direction: "tail",
        limit: this.timelineBudget.pageLimit,
        projection: "canonical",
      });
    } catch {
      return false;
    }
    for (let pages = 1; ; pages += 1) {
      if (this.isStale(generation)) return false;
      if (matchesMessage(page, clientMessageId)) return true;
      if (
        !page.hasOlder ||
        !page.startCursor ||
        pages >= this.timelineBudget.maxPages ||
        this.now() - started > this.timelineBudget.maxMs
      ) {
        return false;
      }
      try {
        page = await handle.timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit: this.timelineBudget.pageLimit,
          projection: "canonical",
        });
      } catch {
        return false;
      }
    }
  }

  private schedulePeriodic(): void {
    if (this.stopped) return;
    if (this.periodicTimer) clearTimeout(this.periodicTimer);
    void this.computeInterval().then((interval) => {
      if (this.stopped) return;
      const jitter = Math.floor(Math.random() * this.intervals.jitterMs);
      this.periodicTimer = setTimeout(() => {
        this.periodicTimer = null;
        void this.runPeriodic().finally(() => this.schedulePeriodic());
      }, interval + jitter);
    });
  }

  private async computeInterval(): Promise<number> {
    const read = await this.store.read();
    if (read.status !== "ok") return this.intervals.activeMs;
    const document = read.document;
    const hasPending = Object.values(document.claims).some((claim) => claim.state === "pending");
    const hasActive = Object.values(document.agentLinks).some((link) =>
      isActiveDisplayState(link.displayState),
    );
    return hasPending || hasActive || this.degradedState ? this.intervals.activeMs : this.intervals.idleMs;
  }

  /** Periodic recovery is always marker scan ∪ targeted refresh of every known link ID. */
  async runPeriodic(): Promise<void> {
    if (this.stopped || this.periodicRunning) return;
    this.periodicRunning = true;
    const generation = this.runGeneration;
    const started = this.now();
    try {
      if (!this.documentReady) {
        await this.bootstrap(generation);
        return;
      }
      const read = await this.store.read();
      if (read.status !== "ok") {
        this.setDegraded("document_invalid");
        return;
      }
      this.indexDocument(read.document);
      const scanned = await this.markerScan(generation, "periodic", {
        subscribe: !this.subscriptionCarried,
      });
      if (this.isStale(generation)) return;
      for (const agentId of this.knownLinkIds) this.enqueueRefresh(agentId, "periodic_known");
      this.clearDegraded();
      this.lastReconcileAt = new Date(this.now()).toISOString();
      this.log.info("periodic_complete", {
        source: "periodic",
        scanned,
        knownRefreshed: this.knownLinkIds.size,
        pending: this.pending.size,
        durationMs: this.now() - started,
      });
    } catch (error) {
      if (this.isStale(generation)) return;
      this.setDegraded(`periodic_failed:${errorCode(error)}`);
    } finally {
      this.periodicRunning = false;
    }
  }

  /** Manual check: bounded scan for one work item plus targeted refresh of its known links. */
  async checkWorkItem(workItemId: string): Promise<string[]> {
    const generation = this.runGeneration;
    const read = await this.store.read();
    if (read.status !== "ok") return [];
    const enqueued: string[] = [];
    for (const link of Object.values(read.document.agentLinks)) {
      if (link.workItemId !== workItemId) continue;
      this.enqueueRefresh(link.agentId, "manual_check");
      enqueued.push(link.agentId);
    }
    void this.markerScan(generation, "check", {
      subscribe: false,
      labels: { ...TODO_MARKER_FILTER, [TODO_LABEL_WORK_ITEM_ID]: workItemId },
      maxPages: 1,
    }).catch((error) => this.log.warn("check_scan_failed", { workItemId, code: errorCode(error) }));
    return enqueued;
  }

  /** Called by RPC handlers after their own commits so the in-memory index stays current. */
  noteDocument(document: TodoDocument): void {
    this.incarnationId = document.incarnationId;
    this.indexDocument(document);
  }
}

function matchesMessage(page: TimelinePage, clientMessageId: string): boolean {
  return page.entries.some((entry) => {
    const item = entry.item as { type?: string; clientMessageId?: string; messageId?: string };
    return (
      item.type === "user_message" &&
      (item.clientMessageId === clientMessageId || item.messageId === clientMessageId)
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "error";
}
