import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describePermission, describeTurn, isLimitReply } from "../server/details";
import { formatBody } from "../server/format";
import type { NotificationRecord, NotificationWorkspace } from "../server/types";

const workspace: NotificationWorkspace = {
  id: "ws-1",
  projectDisplayName: "演示项目",
  projectKind: "git",
  name: "feature/demo",
  branch: "feature/demo",
  status: "done",
  diffStat: { additions: 42, deletions: 7 },
};

function tool(detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"], status: "completed" | "failed" = "completed") {
  return { type: "tool_call", callId: Math.random().toString(), name: "tool", detail, status, error: status === "failed" ? "boom" : null } as AgentTimelineItem;
}

const timeline: AgentTimelineItem[] = [
  { type: "user_message", text: "上一轮的指令" },
  { type: "assistant_message", text: "上一轮的回复" },
  { type: "user_message", text: "修复登录超时" },
  { type: "assistant_message", text: "先看看代码。" },
  tool({ type: "read", filePath: "/repo/src/auth.ts" }),
  tool({ type: "edit", filePath: "/repo/src/auth.ts" }),
  tool({ type: "write", filePath: "/repo/test/auth.test.ts" }),
  tool({ type: "edit", filePath: "/repo/src/auth.ts" }),
  tool({ type: "shell", command: "npm test" }),
  tool({ type: "shell", command: "npm run lint" }, "failed"),
  { type: "todo", items: [{ text: "定位原因", completed: true }, { text: "补测试", completed: false }] },
  { type: "reasoning", text: "思考" },
  { type: "assistant_message", text: "已修复：" },
  { type: "assistant_message", text: "超时改为 30 秒。" },
];

describe("describeTurn", () => {
  it("只看最后一条用户消息之后的内容", () => {
    expect(describeTurn(timeline)).toEqual({
      prompt: "修复登录超时",
      reply: "已修复：\n\n超时改为 30 秒。",
      files: ["/repo/src/auth.ts", "/repo/test/auth.test.ts"],
      commandCount: 2,
      failedToolCount: 1,
      todo: [
        { text: "定位原因", completed: true },
        { text: "补测试", completed: false },
      ],
    });
  });

  it("超长回复截断", () => {
    const detail = describeTurn([{ type: "user_message", text: "x" }, { type: "assistant_message", text: "字".repeat(5_000) }]);
    expect(detail.reply).toHaveLength(600);
    expect(detail.reply?.endsWith("…")).toBe(true);
  });
});

describe("isLimitReply", () => {
  it("识别各家限额提示，长回复不算", () => {
    expect(isLimitReply("You've hit your weekly limit · resets Sep 27, 5am (Asia/Shanghai)")).toBe(true);
    expect(isLimitReply("You've hit your usage limit.")).toBe(true);
    expect(isLimitReply("Usage limit has been reached for this model.")).toBe(true);
    expect(isLimitReply(`分享限额的文章：${"字".repeat(500)}`)).toBe(false);
    expect(isLimitReply("任务完成。")).toBe(false);
    expect(isLimitReply(null)).toBe(false);
  });

  it("限额回复的轮次标记 limitNotice", () => {
    const detail = describeTurn([
      { type: "user_message", text: "继续" },
      { type: "assistant_message", text: "You've hit your weekly limit · resets Sep 27, 5am" },
    ]);
    expect(detail.limitNotice).toBe(true);
  });
});

describe("describePermission", () => {
  it("shell 权限带命令和目录", () => {
    expect(
      describePermission({
        id: "p",
        provider: "claude",
        name: "Bash",
        kind: "tool",
        title: "Run command",
        detail: { type: "shell", command: "rm -rf dist", cwd: "/repo" },
      }),
    ).toEqual({ title: "Run command", body: "命令：rm -rf dist\n目录：/repo" });
  });

  it("没有结构化详情时退回到输入参数", () => {
    expect(
      describePermission({ id: "p", provider: "claude", name: "mcp", kind: "tool", input: { url: "https://x" } }).body,
    ).toBe('{\n  "url": "https://x"\n}');
  });
});

describe("formatBody", () => {
  it("完成通知包含指令、回复和本轮操作", () => {
    const record: NotificationRecord = {
      kind: "completed",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "claude",
      durationMs: 180_000,
      runningRootCount: 0,
      agentTitle: "登录修复",
      cwd: "/repo",
      turn: describeTurn(timeline),
    };
    expect(formatBody([record])).toBe(
      [
        "✅ 演示项目 · feature/demo · Claude 完成 · 3 分钟 · 本分支已全部结束",
        "Agent：登录修复",
        "工作区未提交改动：+42 −7",
        "",
        "【你的指令】",
        "修复登录超时",
        "",
        "【Agent 回复】",
        "已修复：",
        "",
        "超时改为 30 秒。",
        "",
        "【本轮操作】",
        "修改了 2 个文件：",
        "  src/auth.ts",
        "  test/auth.test.ts",
        "执行命令 2 条，失败的工具调用 1 次",
        "任务清单 1/2：",
        "  ✓ 定位原因",
        "  ○ 补测试",
      ].join("\n"),
    );
  });

  it("失败和权限通知分段，失败带完整错误", () => {
    const body = formatBody([
      {
        kind: "failed",
        agentId: "a",
        workspaceId: "ws-1",
        workspace,
        provider: "codex",
        durationMs: 120_000,
        errorFirstLine: "boom",
        error: "boom\n  at line 2",
      },
      {
        kind: "permission",
        agentId: "b",
        workspaceId: "ws-1",
        workspace: { ...workspace, diffStat: null },
        provider: "claude",
        toolName: "Bash",
        permission: { title: null, body: "命令：npm publish" },
      },
    ]);
    expect(body).toContain("❌ 演示项目 · feature/demo · Codex 失败 · 2 分钟\n工作区未提交改动：+42 −7\n\n【错误】\nboom\n  at line 2");
    expect(body).toContain("\n\n━━━━━━━━━━\n\n⏸ 演示项目 · feature/demo · 等待批准：Bash\n\n【待批准】\n命令：npm publish");
  });
});
