import { Marked } from "marked";
import { formatFiles } from "./details";
import { durationLabel, providerName, workspaceLabel } from "./format";
import type { NotificationRecord } from "./types";

// Mail clients drop <style> blocks unpredictably, so every rule is inlined on the element.
const COLORS = {
  completed: "#16a34a",
  failed: "#dc2626",
  permission: "#d97706",
  text: "#1c1917",
  muted: "#78716c",
  border: "#e7e5e4",
  subtle: "#f5f5f4",
  added: "#15803d",
  removed: "#b91c1c",
} as const;

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const PRE_STYLE = `margin:0;padding:10px 12px;background:${COLORS.subtle};border-radius:6px;font:12px/1.5 ${MONO};white-space:pre-wrap;overflow-wrap:anywhere;`;

// Styles for the tags marked emits; matched on the bare opening tag or one followed by attributes.
const MARKDOWN_STYLES: Record<string, string> = {
  p: "margin:0 0 8px;",
  ul: "margin:0 0 8px;padding-left:20px;",
  ol: "margin:0 0 8px;padding-left:20px;",
  li: "margin:2px 0;",
  h1: "margin:12px 0 6px;font-size:16px;",
  h2: "margin:12px 0 6px;font-size:15px;",
  h3: "margin:10px 0 6px;font-size:14px;",
  h4: "margin:10px 0 6px;font-size:14px;",
  pre: PRE_STYLE,
  code: `font:12px/1.5 ${MONO};background:${COLORS.subtle};border-radius:3px;padding:1px 4px;`,
  blockquote: `margin:0 0 8px;padding:4px 12px;border-left:3px solid ${COLORS.border};color:${COLORS.muted};`,
  table: "border-collapse:collapse;margin:0 0 8px;font-size:13px;",
  th: `border:1px solid ${COLORS.border};padding:4px 8px;background:${COLORS.subtle};text-align:left;`,
  td: `border:1px solid ${COLORS.border};padding:4px 8px;`,
  hr: `border:0;border-top:1px solid ${COLORS.border};margin:12px 0;`,
  a: `color:#2563eb;`,
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Agent replies are untrusted text: raw HTML is shown, never interpreted.
    html: ({ text }) => escapeHtml(text),
    // Remote images would load on open; show them as links instead.
    image: ({ href, text }) => `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`,
  },
});

export function renderMarkdown(source: string): string {
  const html = markdown.parse(source, { async: false });
  return html.replace(/<(p|ul|ol|li|h[1-4]|pre|code|blockquote|table|th|td|hr|a)(?=[\s>/])/g, (match, tag: string) => {
    // Code inside <pre> already sits on the block's background.
    return `${match} style="${MARKDOWN_STYLES[tag]}"`;
  }).replace(/<pre style="([^"]*)"><code style="[^"]*"/g, '<pre style="$1"><code style="font:inherit;"');
}

function pre(text: string, background: string = COLORS.subtle): string {
  return `<pre style="${PRE_STYLE}background:${background};">${text}</pre>`;
}

// Colors unified-diff lines; other text passes through escaped.
function highlightDiff(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      if (/^\+(?!\+\+)/.test(line)) return `<span style="color:${COLORS.added};">${escaped}</span>`;
      if (/^-(?!--)/.test(line)) return `<span style="color:${COLORS.removed};">${escaped}</span>`;
      return escaped;
    })
    .join("\n");
}

function section(title: string, content: string): string {
  return `<div style="margin-top:14px;"><div style="font-size:12px;font-weight:600;color:${COLORS.muted};margin-bottom:6px;">${escapeHtml(title)}</div>${content}</div>`;
}

function headline(record: NotificationRecord): { icon: string; status: string } {
  if (record.kind === "permission") return { icon: "⏸", status: `等待批准：${record.toolName ?? "未知工具"}` };
  const provider = providerName(record.provider);
  if (record.kind === "failed") return { icon: "❌", status: `${provider} 失败` };
  return { icon: "✅", status: `${provider} 完成` };
}

function meta(record: NotificationRecord): string[] {
  const { project, branch } = workspaceLabel(record.workspace);
  const parts = [project, branch];
  if (record.kind !== "permission" && record.durationMs !== undefined) parts.push(durationLabel(record.durationMs));
  if (record.kind === "completed") {
    const running = record.runningRootCount ?? 0;
    parts.push(running > 0 ? `本分支还有 ${running} 个在跑` : "本分支已全部结束");
  }
  return parts;
}

function renderRecord(record: NotificationRecord): string {
  const color = COLORS[record.kind];
  const { icon, status } = headline(record);
  const blocks: string[] = [];
  blocks.push(
    `<div style="font-size:16px;font-weight:600;color:${color};">${icon} ${escapeHtml(status)}</div>`,
    `<div style="margin-top:4px;font-size:13px;color:${COLORS.muted};">${meta(record).map(escapeHtml).join(" · ")}</div>`,
  );
  if (record.agentTitle) {
    blocks.push(`<div style="margin-top:6px;font-size:14px;">${escapeHtml(record.agentTitle)}</div>`);
  }
  const diffStat = record.workspace?.diffStat;
  if (diffStat && (diffStat.additions > 0 || diffStat.deletions > 0)) {
    blocks.push(
      `<div style="margin-top:4px;font-size:13px;color:${COLORS.muted};">工作区未提交改动 <span style="color:${COLORS.added};font-family:${MONO};">+${diffStat.additions}</span> <span style="color:${COLORS.removed};font-family:${MONO};">−${diffStat.deletions}</span></div>`,
    );
  }
  if (record.permission) {
    const { title, body } = record.permission;
    const content = [
      title ? `<div style="font-weight:600;margin-bottom:6px;">${escapeHtml(title)}</div>` : "",
      body ? pre(highlightDiff(body)) : "",
    ].join("");
    blocks.push(section("待批准", content || escapeHtml(record.toolName ?? "未知工具")));
  }
  if (record.error) blocks.push(section("错误", pre(escapeHtml(record.error), "#fef2f2")));
  const turn = record.turn;
  if (turn) {
    if (turn.prompt) {
      blocks.push(
        section(
          "你的指令",
          `<div style="padding:8px 12px;background:${COLORS.subtle};border-radius:6px;white-space:pre-wrap;">${escapeHtml(turn.prompt)}</div>`,
        ),
      );
    }
    if (turn.reply) blocks.push(section("Agent 回复", `<div>${renderMarkdown(turn.reply)}</div>`));
    const work: string[] = [];
    if (turn.files.length > 0) {
      work.push(
        `<div>修改了 ${turn.files.length} 个文件</div>${pre(escapeHtml(formatFiles(turn.files, record.cwd ?? null).replace(/^ {2}/gm, "")))}`,
      );
    }
    if (turn.commandCount > 0 || turn.failedToolCount > 0) {
      const failed =
        turn.failedToolCount > 0
          ? `，<span style="color:${COLORS.failed};">失败的工具调用 ${turn.failedToolCount} 次</span>`
          : "";
      work.push(`<div style="margin-top:6px;">执行命令 ${turn.commandCount} 条${failed}</div>`);
    }
    if (turn.todo && turn.todo.length > 0) {
      const done = turn.todo.filter((item) => item.completed).length;
      const items = turn.todo
        .map(
          (item) =>
            `<div style="color:${item.completed ? COLORS.muted : COLORS.text};">${item.completed ? "✓" : "○"} ${escapeHtml(item.text)}</div>`,
        )
        .join("");
      work.push(`<div style="margin-top:6px;">任务清单 ${done}/${turn.todo.length}</div><div style="margin-top:4px;padding-left:4px;">${items}</div>`);
    }
    if (work.length > 0) blocks.push(section("本轮操作", work.join("")));
  }
  return `<div style="background:#ffffff;border:1px solid ${COLORS.border};border-left:4px solid ${color};border-radius:8px;padding:16px;margin-bottom:12px;">${blocks.join("")}</div>`;
}

export function renderHtml(records: NotificationRecord[]): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;padding:12px;background:${COLORS.subtle};color:${COLORS.text};font:14px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">`,
    `<div style="max-width:640px;margin:0 auto;">`,
    records.map(renderRecord).join(""),
    `<div style="font-size:12px;color:${COLORS.muted};text-align:center;padding:4px 0 8px;">Paseo · mail-notify</div>`,
    "</div></body></html>",
  ].join("");
}
