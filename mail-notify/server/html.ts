import { Marked } from "marked";
import { formatFiles } from "./details";
import { durationLabel, providerName, workspaceLabel } from "./format";
import type { NotificationRecord } from "./types";

// Mail clients drop <style> blocks unpredictably, so every rule is inlined on the element.
const COLORS = {
  notice: "#2563eb",
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
const SANS = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
// WeChat's reader drops <body> styles and Android WebViews enlarge text without an explicit size,
// so every text block names its size and automatic enlargement is switched off.
const NO_BOOST = "-webkit-text-size-adjust:100%;text-size-adjust:100%;";
const TEXT = "font-size:14px;line-height:1.6;";
const PRE_STYLE = `margin:0;padding:10px 12px;background:${COLORS.subtle};border-radius:6px;font:12px/1.5 ${MONO};white-space:pre-wrap;overflow-wrap:anywhere;`;

// Styles for the tags marked emits; matched on the bare opening tag or one followed by attributes.
const MARKDOWN_STYLES: Record<string, string> = {
  p: `margin:0 0 8px;${TEXT}`,
  ul: `margin:0 0 8px;padding-left:20px;${TEXT}`,
  ol: `margin:0 0 8px;padding-left:20px;${TEXT}`,
  li: `margin:2px 0;${TEXT}`,
  h1: "margin:12px 0 6px;font-size:16px;",
  h2: "margin:12px 0 6px;font-size:15px;",
  h3: "margin:10px 0 6px;font-size:14px;",
  h4: "margin:10px 0 6px;font-size:14px;",
  pre: `${PRE_STYLE}margin:0 0 8px;`,
  code: `font:13px/1.5 ${MONO};background:${COLORS.subtle};border-radius:3px;padding:1px 4px;`,
  blockquote: `margin:0 0 8px;padding:4px 12px;border-left:3px solid ${COLORS.border};color:${COLORS.muted};${TEXT}`,
  table: "border-collapse:collapse;margin:0 0 8px;font-size:13px;",
  th: `border:1px solid ${COLORS.border};padding:4px 8px;background:${COLORS.subtle};text-align:left;font-size:13px;`,
  td: `border:1px solid ${COLORS.border};padding:4px 8px;font-size:13px;`,
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
      title ? `<div style="font-weight:600;margin-bottom:6px;${TEXT}">${escapeHtml(title)}</div>` : "",
      body ? pre(highlightDiff(body)) : "",
    ].join("");
    blocks.push(section("待批准", content || `<div style="${TEXT}">${escapeHtml(record.toolName ?? "未知工具")}</div>`));
  }
  if (record.error) blocks.push(section("错误", pre(escapeHtml(record.error), "#fef2f2")));
  const turn = record.turn;
  if (turn) {
    if (turn.prompt) {
      blocks.push(
        section(
          "你的指令",
          `<div style="padding:8px 12px;background:${COLORS.subtle};border-radius:6px;white-space:pre-wrap;${TEXT}">${escapeHtml(turn.prompt)}</div>`,
        ),
      );
    }
    if (turn.reply) blocks.push(section("Agent 回复", `<div style="${TEXT}">${renderMarkdown(turn.reply)}</div>`));
    const work: string[] = [];
    if (turn.files.length > 0) {
      work.push(
        `<div style="${TEXT}margin-bottom:4px;">修改了 ${turn.files.length} 个文件</div>${pre(escapeHtml(formatFiles(turn.files, record.cwd ?? null).replace(/^ {2}/gm, "")))}`,
      );
    }
    if (turn.commandCount > 0 || turn.failedToolCount > 0) {
      const failed =
        turn.failedToolCount > 0
          ? `，<span style="color:${COLORS.failed};">失败的工具调用 ${turn.failedToolCount} 次</span>`
          : "";
      work.push(`<div style="margin-top:6px;${TEXT}">执行命令 ${turn.commandCount} 条${failed}</div>`);
    }
    if (turn.todo && turn.todo.length > 0) {
      const done = turn.todo.filter((item) => item.completed).length;
      const items = turn.todo
        .map(
          (item) =>
            `<div style="color:${item.completed ? COLORS.muted : COLORS.text};${TEXT}">${item.completed ? "✓" : "○"} ${escapeHtml(item.text)}</div>`,
        )
        .join("");
      work.push(`<div style="margin-top:6px;${TEXT}">任务清单 ${done}/${turn.todo.length}</div><div style="margin-top:4px;padding-left:4px;">${items}</div>`);
    }
    if (work.length > 0) blocks.push(section("本轮操作", work.join("")));
  }
  return card(color, blocks);
}

function card(color: string, blocks: string[]): string {
  return `<div style="${NO_BOOST}background:#ffffff;border:1px solid ${COLORS.border};border-left:4px solid ${color};border-radius:8px;padding:16px;margin-bottom:12px;">${blocks.join("")}</div>`;
}

function page(cards: string[]): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;padding:12px;background:${COLORS.subtle};${NO_BOOST}">`,
    `<div style="max-width:640px;margin:0 auto;color:${COLORS.text};font-family:${SANS};${TEXT}${NO_BOOST}">`,
    cards.join(""),
    `<div style="font-size:12px;color:${COLORS.muted};text-align:center;padding:4px 0 8px;">Paseo · mail-notify</div>`,
    "</div></body></html>",
  ].join("");
}

export interface Notice {
  icon: string;
  title: string;
  /** One line under the title, in the muted meta style. */
  meta?: string;
  paragraphs: string[];
  /** Label/value rows, e.g. the settings a test mail was sent with. */
  facts?: [label: string, value: string][];
  /** A titled bullet list, e.g. when notifications go out. */
  list?: { title: string; items: string[] };
}

/** The plugin's own messages (startup, test mail) in the same card style as agent notifications. */
export function renderNotice(notice: Notice): string {
  const blocks = [
    `<div style="font-size:16px;font-weight:600;color:${COLORS.notice};">${notice.icon} ${escapeHtml(notice.title)}</div>`,
  ];
  if (notice.meta) {
    blocks.push(`<div style="margin-top:4px;font-size:13px;color:${COLORS.muted};">${escapeHtml(notice.meta)}</div>`);
  }
  for (const paragraph of notice.paragraphs) {
    blocks.push(`<div style="margin-top:10px;${TEXT}">${escapeHtml(paragraph)}</div>`);
  }
  if (notice.facts && notice.facts.length > 0) {
    const rows = notice.facts
      .map(
        ([label, value]) =>
          `<tr><td style="padding:3px 12px 3px 0;color:${COLORS.muted};font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:3px 0;font:13px/1.5 ${MONO};word-break:break-all;">${escapeHtml(value)}</td></tr>`,
      )
      .join("");
    blocks.push(`<table style="margin-top:10px;border-collapse:collapse;">${rows}</table>`);
  }
  if (notice.list) {
    const items = notice.list.items
      .map((item) => `<li style="margin:2px 0;${TEXT}">${escapeHtml(item)}</li>`)
      .join("");
    blocks.push(section(notice.list.title, `<ul style="margin:0;padding-left:20px;">${items}</ul>`));
  }
  return page([card(COLORS.notice, blocks)]);
}

export function renderHtml(records: NotificationRecord[]): string {
  return page(records.map(renderRecord));
}
