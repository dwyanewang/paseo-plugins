import { describe, expect, it } from "vitest";
import { formatSubject } from "../server/format";
import type { NotificationRecord, NotificationWorkspace } from "../server/types";

const workspace: NotificationWorkspace = {
  id: "ws-1",
  projectDisplayName: "paseo-plugins",
  projectKind: "git",
  name: "main",
  branch: "main",
  status: "done",
};

const base = { agentId: "a", workspaceId: "ws-1", workspace, provider: "claude" } as const;
const completed = (extra: Partial<NotificationRecord> = {}): NotificationRecord => ({
  ...base,
  kind: "completed",
  durationMs: 38_000,
  runningRootCount: 0,
  ...extra,
});

describe("formatSubject", () => {
  it("结果在前，用 agent 标题标识任务", () => {
    expect(formatSubject([completed({ agentTitle: "邮件通知样式优化" })])).toBe("✅ 完成 · 邮件通知样式优化 · 38 秒");
  });

  it("没有标题时用项目名，失败和待批准各有前缀", () => {
    expect(formatSubject([completed()])).toBe("✅ 完成 · paseo-plugins · 38 秒");
    expect(formatSubject([{ ...base, kind: "failed", durationMs: 120_000, agentTitle: "升级依赖" }])).toBe("❌ 失败 · 升级依赖 · 2 分钟");
    expect(formatSubject([{ ...base, kind: "permission", toolName: "Bash", agentTitle: "登录修复" }])).toBe("⏸ 待批准 · 登录修复");
  });

  it("长标题截断，常见标题控制在微信能完整显示的 68 字节内", () => {
    const subject = formatSubject([completed({ agentTitle: "把邮件通知的正文字号统一并缩短标题长度", durationMs: 3_720_000 })]);
    expect(subject).toBe("✅ 完成 · 把邮件通知的正文字… · 1 小时 2 分钟");
    expect(Buffer.byteLength(subject)).toBeLessThanOrEqual(68);
  });

  it("英文标题按宽度截断", () => {
    expect(formatSubject([completed({ agentTitle: "Refactor the notification engine" })])).toBe(
      "✅ 完成 · Refactor the notifi… · 38 秒",
    );
  });

  it("多条合并时给出条数和分类", () => {
    expect(
      formatSubject([completed(), completed({ agentId: "b" }), { ...base, kind: "permission", agentId: "c", toolName: "Bash" }]),
    ).toBe("📬 3 条通知 · 2 完成、1 待批准");
  });
});
