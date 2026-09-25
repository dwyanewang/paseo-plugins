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

function workspaceLabel(workspace: NotificationWorkspace | null): { project: string; branch: string } {
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
