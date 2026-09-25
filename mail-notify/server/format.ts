import { formatFiles } from "./details";
import type { NotificationRecord, NotificationWorkspace } from "./types";

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}

export function durationLabel(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function firstErrorLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0]?.trim() || "未知错误";
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

export function workspaceLabel(workspace: NotificationWorkspace | null): { project: string; branch: string } {
  if (!workspace) return { project: "未知项目", branch: "未知分支" };
  return {
    project: workspace.projectDisplayName,
    branch: workspace.projectKind === "git" ? workspace.branch ?? workspace.name : workspace.name,
  };
}

export function formatRecord(record: NotificationRecord): string {
  const { project, branch } = workspaceLabel(record.workspace);
  const provider = providerName(record.provider);
  if (record.kind === "permission") {
    return `⏸ ${project} · ${branch} · 等待批准：${record.toolName ?? "未知工具"}`;
  }
  if (record.kind === "failed") {
    const suffix = record.errorFirstLine ? `\n   ${record.errorFirstLine}` : "";
    return `❌ ${project} · ${branch} · ${provider} 失败 · ${durationLabel(record.durationMs ?? 0)}${suffix}`;
  }
  const running = record.runningRootCount ?? 0;
  const status = running > 0 ? `本分支还有 ${running} 个在跑` : "本分支已全部结束";
  return `✅ ${project} · ${branch} · ${provider} 完成 · ${durationLabel(record.durationMs ?? 0)} · ${status}`;
}

export function formatMerged(records: NotificationRecord[]): string {
  if (records.length === 0) return "";
  const lines: string[] = [];
  const grouped = new Map<string, NotificationRecord[]>();
  for (const record of records) {
    if (record.kind !== "completed") {
      lines.push(formatRecord(record));
      continue;
    }
    const key = record.workspaceId ?? record.workspace?.id ?? record.agentId;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  for (const completed of grouped.values()) {
    if (completed.length === 1) {
      lines.push(formatRecord(completed[0]!));
    } else {
      const { project, branch } = workspaceLabel(completed[0]?.workspace ?? null);
      lines.push(`✅ ${project} · ${branch} · ${completed.length} 个完成`);
    }
  }
  return lines.join("\n");
}

function section(title: string, body: string | null | undefined): string[] {
  return body ? ["", `【${title}】`, body] : [];
}

function formatDetail(record: NotificationRecord): string {
  const lines = [formatRecord(record).split("\n", 1)[0]!];
  if (record.agentTitle) lines.push(`Agent：${record.agentTitle}`);
  const diffStat = record.workspace?.diffStat;
  if (diffStat && (diffStat.additions > 0 || diffStat.deletions > 0)) {
    lines.push(`工作区未提交改动：+${diffStat.additions} −${diffStat.deletions}`);
  }
  if (record.permission) {
    const { title, body } = record.permission;
    lines.push(...section("待批准", [title, body].filter(Boolean).join("\n") || record.toolName));
  }
  lines.push(...section("错误", record.error));
  const turn = record.turn;
  if (turn) {
    lines.push(...section("你的指令", turn.prompt));
    lines.push(...section("Agent 回复", turn.reply));
    const work: string[] = [];
    if (turn.files.length > 0) work.push(`修改了 ${turn.files.length} 个文件：\n${formatFiles(turn.files, record.cwd ?? null)}`);
    if (turn.commandCount > 0 || turn.failedToolCount > 0) {
      work.push(
        `执行命令 ${turn.commandCount} 条${turn.failedToolCount > 0 ? `，失败的工具调用 ${turn.failedToolCount} 次` : ""}`,
      );
    }
    if (turn.todo && turn.todo.length > 0) {
      const done = turn.todo.filter((item) => item.completed).length;
      work.push(
        [`任务清单 ${done}/${turn.todo.length}：`, ...turn.todo.map((item) => `  ${item.completed ? "✓" : "○"} ${item.text}`)].join(
          "\n",
        ),
      );
    }
    lines.push(...section("本轮操作", work.join("\n") || null));
  }
  return lines.join("\n");
}

// The body repeats each record's summary line so a single notification reads well on its own.
export function formatBody(records: NotificationRecord[]): string {
  return records.map(formatDetail).join("\n\n━━━━━━━━━━\n\n");
}
