import type {
  AgentPermissionRequest,
  AgentTimelineItem,
  ToolCallDetail,
} from "@getpaseo/protocol/agent-types";

// Mail has no length limit, but WeChat's reader gets unwieldy past a few screens.
const PROMPT_LIMIT = 500;
const REPLY_LIMIT = 3_000;
const ERROR_LIMIT = 2_000;
const PERMISSION_LIMIT = 1_500;
const FILE_LIMIT = 20;

export interface TurnDetail {
  prompt: string | null;
  reply: string | null;
  files: string[];
  commandCount: number;
  failedToolCount: number;
  todo: { text: string; completed: boolean }[] | null;
}

export interface PermissionDetail {
  title: string | null;
  body: string | null;
}

export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function isToolCall(item: AgentTimelineItem): item is ToolCallItem {
  return item.type === "tool_call";
}

// The hook passes the agent's whole timeline; the current turn starts at the last user message.
export function currentTurn(timeline: readonly AgentTimelineItem[]): readonly AgentTimelineItem[] {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.type === "user_message") return timeline.slice(index);
  }
  return timeline;
}

function finalReply(turn: readonly AgentTimelineItem[]): string | null {
  // The answer is the run of assistant messages after the last tool call; earlier ones narrate work.
  // The host's projection already joins streamed chunks, so separate items are separate messages.
  const parts: string[] = [];
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const item = turn[index]!;
    if (item.type === "assistant_message") parts.unshift(item.text);
    else if (item.type === "reasoning" || item.type === "notification") continue;
    else if (parts.length > 0) break;
  }
  const text = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return text ? text : null;
}

export function describeTurn(timeline: readonly AgentTimelineItem[]): TurnDetail {
  const turn = currentTurn(timeline);
  const first = turn[0];
  const prompt = first?.type === "user_message" && first.text.trim() ? first.text : null;
  const files = new Set<string>();
  let commandCount = 0;
  let failedToolCount = 0;
  let todo: TurnDetail["todo"] = null;
  for (const item of turn) {
    if (item.type === "todo") todo = item.items.map(({ text, completed }) => ({ text, completed }));
    if (!isToolCall(item)) continue;
    if (item.status === "failed") failedToolCount += 1;
    if (item.detail.type === "shell") commandCount += 1;
    if ((item.detail.type === "edit" || item.detail.type === "write") && item.status === "completed") {
      files.add(item.detail.filePath);
    }
  }
  return {
    prompt: prompt ? truncate(prompt, PROMPT_LIMIT) : null,
    reply: (() => {
      const reply = finalReply(turn);
      return reply ? truncate(reply, REPLY_LIMIT) : null;
    })(),
    files: [...files],
    commandCount,
    failedToolCount,
    todo,
  };
}

function describeTool(detail: ToolCallDetail | undefined): string | null {
  if (!detail) return null;
  switch (detail.type) {
    case "shell":
      return `命令：${detail.command}${detail.cwd ? `\n目录：${detail.cwd}` : ""}`;
    case "edit":
      return `编辑：${detail.filePath}${detail.unifiedDiff ? `\n${detail.unifiedDiff}` : ""}`;
    case "write":
      return `写入：${detail.filePath}`;
    case "read":
      return `读取：${detail.filePath}`;
    case "search":
      return `搜索：${detail.query}`;
    default:
      return null;
  }
}

export function describePermission(request: AgentPermissionRequest): PermissionDetail {
  const parts = [request.description, describeTool(request.detail)].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  if (parts.length === 0 && request.input && Object.keys(request.input).length > 0) {
    parts.push(JSON.stringify(request.input, null, 2));
  }
  return {
    title: request.title?.trim() || null,
    body: parts.length > 0 ? truncate(parts.join("\n"), PERMISSION_LIMIT) : null,
  };
}

export function describeError(message: string): string {
  return truncate(message, ERROR_LIMIT);
}

export function formatFiles(files: readonly string[], cwd: string | null): string {
  const shown = files.slice(0, FILE_LIMIT).map((file) =>
    cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file,
  );
  const rest = files.length - shown.length;
  return [...shown.map((file) => `  ${file}`), ...(rest > 0 ? [`  …另外 ${rest} 个`] : [])].join("\n");
}
