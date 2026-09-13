import { describe, expect, it } from "vitest";
import { createWorkItemMutation } from "../server/mutations";
import { measureDocumentBytes } from "../shared/limits";
import { TODO_SETTINGS_VERSION } from "../shared/schema";
import { createInput, createStore } from "./helpers/setup";

describe("TodoStore", () => {
  it("initializes the incarnation once and fences every later write on it", async () => {
    const { store, document } = createStore();
    const first = await store.ensureIncarnation();
    expect(first).toMatchObject({ status: "ok", initialized: true });
    const second = await store.ensureIncarnation();
    expect(second).toMatchObject({ status: "ok", initialized: false });
    expect(document.changes).toBe(1);
    const incarnationId = second.status === "ok" ? second.document.incarnationId : "";
    expect(incarnationId).toBe("inc-1");

    const stale = await store.mutate({
      expectedIncarnationId: "inc-old",
      kind: "user",
      mutate: (doc, now) => createWorkItemMutation(doc, { ...createInput("wi-1"), expectedIncarnationId: "inc-old" }, now),
    });
    expect(stale).toMatchObject({ status: "stale_document" });
    expect(document.changes).toBe(1);

    const ok = await store.mutate({
      expectedIncarnationId: incarnationId,
      kind: "user",
      mutate: (doc, now) => createWorkItemMutation(doc, createInput("wi-1"), now),
    });
    expect(ok).toMatchObject({ status: "ok", changed: true, seq: 2 });
    const unchanged = await store.mutate({
      expectedIncarnationId: incarnationId,
      kind: "user",
      mutate: (doc, now) => createWorkItemMutation(doc, createInput("wi-1"), now),
    });
    expect(unchanged).toMatchObject({ status: "ok", changed: false, seq: 2 });
    expect(document.changes).toBe(2);
  });

  it("serializes concurrent mutations so the second observes the first", async () => {
    const { store } = createStore();
    await store.ensureIncarnation();
    const seen: number[] = [];
    const [a, b] = await Promise.all([
      store.mutate({
        expectedIncarnationId: "inc-1",
        kind: "user",
        mutate: (doc, now) => {
          seen.push(Object.keys(doc.workItems).length);
          return createWorkItemMutation(doc, createInput("wi-1"), now);
        },
      }),
      store.mutate({
        expectedIncarnationId: "inc-1",
        kind: "user",
        mutate: (doc, now) => {
          seen.push(Object.keys(doc.workItems).length);
          return createWorkItemMutation(doc, createInput("wi-2"), now);
        },
      }),
    ]);
    expect(seen).toEqual([0, 1]);
    expect(a).toMatchObject({ seq: 2 });
    expect(b).toMatchObject({ seq: 3 });
  });

  it("rejects a mutation that writes the frozen input in place", async () => {
    const { store, document } = createStore();
    await store.ensureIncarnation();
    const result = await store.mutate({
      expectedIncarnationId: "inc-1",
      kind: "user",
      mutate: (doc) => {
        (doc as { seq: number }).seq = 99;
        return { status: "unchanged", result: null };
      },
    });
    expect(result).toMatchObject({ status: "document_invalid", details: { code: "mutator_threw" } });
    expect(document.current().seq).toBe(1);
  });

  it("a reset before a queued write makes that write stale instead of writing the new incarnation", async () => {
    const { store, document } = createStore();
    await store.ensureIncarnation();
    // Simulate a client reset: the document goes back to defaults (empty incarnation).
    document.raw = null;
    const late = await store.mutate({
      expectedIncarnationId: "inc-1",
      kind: "user",
      mutate: (doc, now) => createWorkItemMutation(doc, createInput("wi-1"), now),
    });
    expect(late).toMatchObject({ status: "stale_document" });
    const reinitialized = await store.ensureIncarnation();
    expect(reinitialized).toMatchObject({ status: "ok", initialized: true });
    expect(reinitialized.status === "ok" ? reinitialized.document.incarnationId : "").toBe("inc-2");
    const stillStale = await store.mutate({
      expectedIncarnationId: "inc-1",
      kind: "user",
      mutate: (doc, now) => createWorkItemMutation(doc, createInput("wi-1"), now),
    });
    expect(stillStale).toMatchObject({ status: "stale_document" });
    expect(Object.keys(document.current().workItems)).toEqual([]);
  });

  it("applies soft, reserve, and absolute capacity tiers with a strict-shrink exit", async () => {
    const filler = "x".repeat(400);
    const input = (id: string, details: string) => ({ ...createInput(id), details });
    // Derive limits from measured sizes so the tiers are exact rather than guessed.
    const measure = (doc: Parameters<typeof measureDocumentBytes>[0]) => measureDocumentBytes(doc, TODO_SETTINGS_VERSION);
    const commit = (outcome: ReturnType<typeof createWorkItemMutation>) => {
      if (outcome.status !== "commit") throw new Error(outcome.status);
      return outcome.values;
    };
    const { document: probe } = createStore();
    const base = { ...probe.current(), incarnationId: "inc-1", seq: 1 };
    const withOne = commit(createWorkItemMutation(base, input("wi-1", filler), "2026-09-11T10:00:00.000Z"));
    const withTwoShort = commit(createWorkItemMutation(withOne, input("wi-2", "short"), "2026-09-11T10:00:00.000Z"));
    const capacity = {
      softLimitBytes: measure(withOne) + 10,
      recoveryReserveBytes: measure(withTwoShort) - measure(withOne) + 10,
      absoluteLimitBytes: measure(withTwoShort) + 2000,
    };
    const { store, document } = createStore({ capacity });
    await store.ensureIncarnation();
    const create = (id: string, details: string, kind: "user" | "recovery" = "user") =>
      store.mutate({
        expectedIncarnationId: "inc-1",
        kind,
        mutate: (doc, now) => createWorkItemMutation(doc, input(id, details), now),
      });
    expect((await create("wi-1", filler)).status).toBe("ok");
    const overSoft = await create("wi-2", filler);
    expect(overSoft).toMatchObject({ status: "capacity_exceeded", details: { tier: "soft" } });
    // Recovery writes may use the reserve above the soft limit.
    expect((await create("wi-2", "short", "recovery")).status).toBe("ok");
    const overReserve = await create("wi-3", filler, "recovery");
    expect(overReserve).toMatchObject({ status: "capacity_exceeded", details: { tier: "reserve" } });
    // Push the stored document above the absolute limit out of band; only shrinking writes pass.
    const current = document.current();
    document.raw = JSON.stringify({
      ...current,
      workItems: {
        ...current.workItems,
        "wi-big": { ...current.workItems["wi-1"]!, id: "wi-big", details: "y".repeat(3000) },
      },
    });
    expect(measureDocumentBytes(document.current(), TODO_SETTINGS_VERSION)).toBeGreaterThan(capacity.absoluteLimitBytes);
    const grow = await create("wi-4", "short", "recovery");
    expect(grow).toMatchObject({ status: "capacity_exceeded", details: { tier: "absolute" } });
    const shrink = await store.mutate({
      expectedIncarnationId: "inc-1",
      kind: "recovery",
      mutate: (doc) => {
        const workItems = { ...doc.workItems };
        delete workItems["wi-big"];
        return { status: "commit", values: { ...doc, workItems }, result: null };
      },
    });
    expect(shrink).toMatchObject({ status: "ok", changed: true });
  });
});
