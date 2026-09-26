import type {
  AgentPermissionRequest,
  AgentTimelineItem,
  ToolCallDetail,
} from "@getpaseo/protocol/agent-types";

// ntfy turns a message over 4,096 bytes into an attachment, and Chinese text takes three bytes a
// character, so each part gets a small budget; the sender still caps the whole body.
const PROMPT_LIMIT = 200;
const REPLY_LIMIT = 600;
const ERROR_LIMIT = 500;
const PERMISSION_LIMIT = 500;
const FILE_LIMIT = 10;

// A limit notice is the whole reply, so a long reply quoting "limit" in prose is left alone.
const LIMIT_REPLY_LIMIT = 400;
const LIMIT_PATTERNS = [
  /you'?ve hit your (?:weekly|daily|monthly|usage|rate|message|conversation)[^.\n]*limit/i,
  /usage limit (?:has been )?reached/i,
];

export interface TurnDetail {
  prompt: string | null;
  reply: string | null;
  files: string[];
  commandCount: number;
  failedToolCount: number;
  todo: { text: string; completed: boolean }[] | null;
  /** True when the reply is a provider quota notice; the turn then counts as a failure. */
  limitNotice?: boolean;
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

// Claude Code ends a quota-exhausted turn as a normal completion whose whole reply is the notice,
// so the completion would read "✅ 完成". The reply is short and the notice is all there is;
// a long reply that merely quotes "limit" stays a completion.
export function isLimitReply(reply: string | null): boolean {
  if (!reply || reply.length > LIMIT_REPLY_LIMIT) return false;
  return LIMIT_PATTERNS.some((pattern) => pattern.test(reply));
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
  const reply = finalReply(turn);
  return {
    prompt: prompt ? truncate(prompt, PROMPT_LIMIT) : null,
    reply: reply ? truncate(reply, REPLY_LIMIT) : null,
    files: [...files],
    commandCount,
    failedToolCount,
    todo,
    ...(isLimitReply(reply) ? { limitNotice: true } : {}),
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
