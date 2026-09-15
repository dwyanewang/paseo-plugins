/**
 * Capacity benchmark (Phase E). Measures the persisted envelope size of realistic Todo documents,
 * the per-record cost of each entity, and write amplification
 * (`business writes × connected clients × document bytes`) on the IPC/WebSocket path where every
 * connected client re-reads the whole document after each commit.
 *
 * Run: `npm run benchmark` (writes test/benchmark/RESULTS.md).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPACITY, measureDocumentBytes } from "../../shared/limits";
import type { AgentLink, Attempt, LaunchClaim, TodoDocument, WorkItem } from "../../shared/schema";
import { TODO_SETTINGS_VERSION, emptyTodoDocument } from "../../shared/schema";

const NOW = "2026-09-11T10:00:00.000Z";
const LOREM = "Implement the feature, add tests, and update the documentation for the new behavior. ";

function text(bytes: number): string {
  let out = "";
  while (out.length < bytes) out += LOREM;
  return out.slice(0, bytes);
}

function item(index: number, detailsBytes: number, promptBytes: number): WorkItem {
  return {
    id: `wi_${index.toString(36).padStart(20, "0")}`,
    creationFingerprint: "f".repeat(32),
    version: 3,
    number: index + 1,
    projectId: `project-${index % 5}`,
    projectNameSnapshot: "Example project",
    projectRootSnapshot: "/home/user/projects/example",
    title: `Work item ${index}: ${text(48)}`,
    details: text(detailsBytes),
    defaultPrompt: text(promptBytes),
    status: index % 4 === 0 ? "done" : "in_review",
    statusChangedAt: NOW,
    statusReason: "agent_finished",
    priority: index % 3 === 0 ? "high" : "none",
    createdAt: NOW,
    updatedAt: NOW,
    ...(index % 4 === 0 ? { completedAt: NOW } : {}),
  };
}

function attempt(itemId: string, index: number, promptBytes: number): Attempt {
  return {
    id: `att_${index.toString(36).padStart(20, "0")}`,
    workItemId: itemId,
    claimGeneration: index + 1,
    requestFingerprint: "f".repeat(32),
    projectIdSnapshot: "project-1",
    projectNameSnapshot: "Example project",
    titleSnapshot: `Work item title ${text(40)}`,
    seedPromptSnapshot: text(promptBytes),
    seedPromptSource: "work-item-default",
    clientMessageId: `msg_${index.toString(36).padStart(20, "0")}`,
    initiatorClientInstanceId: "cid_0123456789abcdef0123456789abcdef",
    initiatorLabel: "Desktop/Web · Work laptop",
    factVersions: { journal: 1, "workspace-request": 1, "workspace-observation": 1, "agent-request": 1 },
    journalPreparedAt: NOW,
    workspaceRequestStartedAt: NOW,
    workspaceIdHint: "wks_0123456789abcdef",
    workspaceObservedAt: NOW,
    agentRequestStartedAt: NOW,
    firstAgentObservedAt: NOW,
    userDisposition: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function link(attemptId: string, itemId: string, index: number): AgentLink {
  return {
    agentId: `0123456789ab-cdef-4000-8000-${index.toString(16).padStart(12, "0")}`,
    attemptId,
    workItemId: itemId,
    workspaceId: "wks_0123456789abcdef",
    observedProjectId: "project-1",
    provider: "codex",
    model: "gpt-5.5",
    modeId: "default",
    thinkingOptionId: "medium",
    displayState: "waiting_confirmation",
    rawStatus: "idle",
    promptDelivery: "observed",
    firstObservedAt: NOW,
    stateChangedAt: NOW,
  };
}

function claim(itemId: string, attemptId: string): LaunchClaim {
  return {
    workItemId: itemId,
    attemptId,
    generation: 3,
    state: "resolved",
    initiatorClientInstanceId: "cid_0123456789abcdef0123456789abcdef",
    initiatorLabel: "Desktop/Web · Work laptop",
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAgentId: "0123456789ab-cdef-4000-8000-000000000001",
  };
}

interface Scenario {
  name: string;
  items: number;
  attemptsPerItem: number;
  detailsBytes: number;
  promptBytes: number;
}

function build(scenario: Scenario): TodoDocument {
  const doc = emptyTodoDocument();
  doc.incarnationId = "inc_0123456789abcdefghij";
  doc.seq = 12_345;
  let attemptIndex = 0;
  for (let index = 0; index < scenario.items; index += 1) {
    const workItem = item(index, scenario.detailsBytes, scenario.promptBytes);
    doc.workItems[workItem.id] = workItem;
    let last: Attempt | null = null;
    for (let count = 0; count < scenario.attemptsPerItem; count += 1) {
      const entry = attempt(workItem.id, attemptIndex, scenario.promptBytes);
      doc.attempts[entry.id] = entry;
      const agentLink = link(entry.id, workItem.id, attemptIndex);
      doc.agentLinks[agentLink.agentId] = agentLink;
      last = entry;
      attemptIndex += 1;
    }
    if (last) doc.claims[workItem.id] = claim(workItem.id, last.id);
  }
  for (let index = 0; index < 64; index += 1) {
    doc.retiredWorkItemIds.push({ id: `wi_retired_${index}`, creationFingerprint: "f".repeat(32), retiredAt: NOW });
  }
  return doc;
}

const scenarios: Scenario[] = [
  { name: "personal (50 items, 1 attempt)", items: 50, attemptsPerItem: 1, detailsBytes: 400, promptBytes: 600 },
  { name: "team (200 items, 2 attempts)", items: 200, attemptsPerItem: 2, detailsBytes: 600, promptBytes: 800 },
  { name: "heavy (500 items, 3 attempts)", items: 500, attemptsPerItem: 3, detailsBytes: 800, promptBytes: 1200 },
  { name: "history-heavy (300 items, 6 attempts)", items: 300, attemptsPerItem: 6, detailsBytes: 600, promptBytes: 1000 },
  { name: "max fields (20 items, 1 attempt, 32 KiB details, 64 KiB prompts)", items: 20, attemptsPerItem: 1, detailsBytes: 32 * 1024, promptBytes: 64 * 1024 },
];

const measure = (doc: unknown) => measureDocumentBytes(doc, TODO_SETTINGS_VERSION);
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const lines: string[] = [];
lines.push("# Todo capacity benchmark", "");
lines.push(`Generated ${new Date().toISOString()} by test/benchmark/capacity.ts.`, "");
lines.push("Measurement: UTF-8 bytes of `JSON.stringify({ version, values })`, identical to the server admission check.", "");
lines.push("## Per-record cost", "");
const single = build({ name: "one", items: 1, attemptsPerItem: 1, detailsBytes: 400, promptBytes: 600 });
const empty = emptyTodoDocument();
const oneItemOnly = { ...empty, workItems: single.workItems };
const oneAttempt = { ...oneItemOnly, attempts: single.attempts, claims: single.claims };
const oneLink = { ...oneAttempt, agentLinks: single.agentLinks };
lines.push("| Record | Bytes |", "| --- | --- |");
lines.push(`| Empty document | ${measure(empty)} |`);
lines.push(`| Work item (400 B details, 600 B prompt) | ${measure(oneItemOnly) - measure(empty)} |`);
lines.push(`| Attempt + claim (600 B seed prompt) | ${measure(oneAttempt) - measure(oneItemOnly)} |`);
lines.push(`| AgentLink | ${measure(oneLink) - measure(oneAttempt)} |`);
lines.push(`| Retired ID entry | ${Math.round((measure(single) - measure(oneLink)) / 64)} |`);
lines.push("", "## Scenarios", "");
lines.push("| Scenario | Document | Soft (512 KiB) | Reserve (+64 KiB) | Absolute (1 MiB) |", "| --- | --- | --- | --- | --- |");
const results = scenarios.map((scenario) => ({ scenario, bytes: measure(build(scenario)) }));
for (const { scenario, bytes } of results) {
  const soft = bytes <= CAPACITY.softLimitBytes ? "ok" : "exceeds";
  const reserve = bytes <= CAPACITY.softLimitBytes + CAPACITY.recoveryReserveBytes ? "ok" : "exceeds";
  const absolute = bytes <= CAPACITY.absoluteLimitBytes ? "ok" : "exceeds";
  lines.push(`| ${scenario.name} | ${kib(bytes)} | ${soft} | ${reserve} | ${absolute} |`);
}
lines.push("", "## Write amplification", "");
lines.push("Every commit re-sends `plugin_settings_changed`; each connected client re-reads the full document over IPC/WebSocket.", "");
lines.push("| Scenario | Writes/hour (busy) | Clients | Bytes/hour |", "| --- | --- | --- | --- |");
for (const { scenario, bytes } of results) {
  for (const clients of [1, 3, 5]) {
    const writes = 120; // one launch (~6 facet commits) every 3 minutes plus reconciliation commits
    lines.push(`| ${scenario.name} | ${writes} | ${clients} | ${kib(writes * clients * bytes)} |`);
  }
}
lines.push("", "## Frozen decisions", "");
lines.push(`- user-growth soft limit: ${kib(CAPACITY.softLimitBytes)} — ordinary create/edit/acquire growth stops here.`);
lines.push(`- best-effort recovery reserve: ${kib(CAPACITY.recoveryReserveBytes)} above the soft limit for AgentLink/abandon/retired-ID writes; it is a budget, not a guarantee for unbounded pending attempts.`);
lines.push(`- absolute serialization limit: ${kib(CAPACITY.absoluteLimitBytes)} — only strictly shrinking mutations run above it.`);
lines.push("- field limits: title 200 code points; details 32 KiB; defaultPrompt and each seedPromptSnapshot 64 KiB.");
lines.push("- retired ring: 256 entries / 30 days. Launch journal: 128 entries, terminal retention 30 days.");
const personal = results[0]!.bytes;
const perItem = Math.round((personal - measure(empty)) / 50);
lines.push(
  "",
  `At typical sizes one work item with one full attempt and one agent link costs about ${kib(perItem)}, so the ${kib(CAPACITY.softLimitBytes)} soft limit admits roughly ${Math.floor(CAPACITY.softLimitBytes / perItem)} such items before ordinary growth stops. The personal scenario fits; the team, heavy, history-heavy, and max-field scenarios exceed the soft limit and must archive and purge, which is the intended v1 answer rather than a database migration. Replication cost is the reason the limits stay this low: a ${kib(CAPACITY.absoluteLimitBytes)} document replicated to 3 busy clients costs ${kib(120 * 3 * CAPACITY.absoluteLimitBytes)} per hour on the whole-document Settings path. The per-field maxima are caps for single records, not a sustainable steady state at hundreds of items.`,
);
const output = lines.join("\n") + "\n";
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "RESULTS.md");
writeFileSync(target, output);
console.log(output);
