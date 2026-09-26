import type { CardBlock, CardDocument, CardTone } from "../shared/card";
import { CARD_VERSION } from "../shared/card";
import { formatFiles } from "./details";
import { durationLabel, providerName, workspaceLabel } from "./format";
import type { NotificationRecord } from "./types";

// The card carries the same facts as the plain-text body, grouped per record and shown as
// structured blocks. Headings and status chips make the outcome readable at a glance; the details
// that only matter when expanded live in markdown sections below.

/** Status blocks are short chips, so the text is kept to a few words per record. */
function recordStatus(record: NotificationRecord): { label: string; tone: CardTone } {
  const { project, branch } = workspaceLabel(record.workspace);
  const where = `${project} · ${branch}`;
  if (record.kind === "permission") return { label: `${where} · 等待批准`, tone: "warning" };
  const duration = record.durationMs === undefined ? "" : ` · ${durationLabel(record.durationMs)}`;
  if (record.kind === "failed") return { label: `${where}${duration} · 失败`, tone: "error" };
  const running = record.runningRootCount ?? 0;
  const branchStatus = running > 0 ? `本分支还有 ${running} 个在跑` : "本分支已全部结束";
  return { label: `${where}${duration} · ${branchStatus}`, tone: "success" };
}

function outcomeHeading(records: NotificationRecord[]): string {
  const counts = [
    ["完成", records.filter((record) => record.kind === "completed").length],
    ["失败", records.filter((record) => record.kind === "failed").length],
    ["待批准", records.filter((record) => record.kind === "permission").length],
  ] as const;
  const parts = counts.filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`);
  if (records.length === 1) {
    const record = records[0]!;
    const provider = providerName(record.provider);
    if (record.kind === "permission") return `⏸ ${provider} 待批准`;
    return record.kind === "failed" ? `❌ ${provider} 失败` : `✅ ${provider} 完成`;
  }
  return `📬 ${records.length} 条通知 · ${parts.join("、")}`;
}

function factsBlock(record: NotificationRecord): CardBlock[] {
  const items: { label: string; value: string }[] = [];
  const diffStat = record.workspace?.diffStat;
  if (diffStat && (diffStat.additions > 0 || diffStat.deletions > 0)) {
    items.push({ label: "未提交改动", value: `+${diffStat.additions} −${diffStat.deletions}` });
  }
  return items.length > 0 ? [{ type: "kv", items }] : [];
}

function detailBlocks(record: NotificationRecord): CardBlock[] {
  const blocks: CardBlock[] = [];
  if (record.permission) {
    const { title, body } = record.permission;
    const text = [title, body].filter(Boolean).join("\n") || record.toolName;
    // The pending request is the user's decision to make, so it gets the boxed callout look.
    if (text) blocks.push({ type: "section", label: "待批准", body: blockquote(text), markdown: true });
  }
  if (record.error) {
    blocks.push({ type: "section", label: "错误", body: record.error, markdown: true });
  }
  const turn = record.turn;
  if (turn) {
    // The prompt is a quote of what the user asked, so it reads as a boxed callout.
    if (turn.prompt) blocks.push({ type: "section", label: "你的指令", body: blockquote(turn.prompt), markdown: true });
    if (turn.reply) blocks.push({ type: "section", label: "Agent 回复", body: turn.reply, markdown: true });
    const work: string[] = [];
    if (turn.files.length > 0) {
      work.push(`修改了 ${turn.files.length} 个文件：\n${formatFiles(turn.files, record.cwd ?? null)}`);
    }
    if (turn.commandCount > 0 || turn.failedToolCount > 0) {
      work.push(
        `执行命令 ${turn.commandCount} 条${turn.failedToolCount > 0 ? `，失败的工具调用 ${turn.failedToolCount} 次` : ""}`,
      );
    }
    if (turn.todo && turn.todo.length > 0) {
      const done = turn.todo.filter((item) => item.completed).length;
      const items = turn.todo.map((item) => `${item.completed ? "✓" : "○"} ${item.text}`);
      work.push([`任务清单 ${done}/${turn.todo.length}：`, ...items].join("\n"));
    }
    if (work.length > 0) blocks.push({ type: "section", label: "本轮操作", body: work.join("\n\n"), markdown: true });
  }
  return blocks;
}

/** Wraps text as a markdown blockquote so the Android client renders it as a callout box. */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function recordBlocks(record: NotificationRecord): CardBlock[] {
  const blocks: CardBlock[] = [{ type: "status", ...recordStatus(record) }];
  blocks.push(...factsBlock(record));
  blocks.push(...detailBlocks(record));
  return blocks;
}

/** Build a versioned card for the whole batch; the caller serializes and may fall back to text. */
export function buildCard(records: NotificationRecord[]): CardDocument {
  if (records.length === 0) {
    return { version: CARD_VERSION, blocks: [{ type: "heading", text: "Paseo 通知" }] };
  }
  const blocks: CardBlock[] = [{ type: "heading", text: outcomeHeading(records) }];
  records.forEach((record, index) => {
    if (index > 0) blocks.push({ type: "divider" });
    blocks.push(...recordBlocks(record));
  });
  return { version: CARD_VERSION, blocks };
}
