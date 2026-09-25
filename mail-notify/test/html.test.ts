import { describe, expect, it } from "vitest";
import { renderHtml, renderMarkdown } from "../server/html";
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

describe("renderMarkdown", () => {
  it("渲染列表和代码块并内联样式", () => {
    const html = renderMarkdown("- 一\n- 二\n\n```ts\nconst a = 1;\n```");
    expect(html).toMatch(/<ul style="[^"]+">/);
    expect(html).toMatch(/<pre style="[^"]+"><code style="font:inherit;" class="language-ts">const a = 1;/);
  });

  it("回复里的原始 HTML 只显示不执行", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="x" onerror="y">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("图片改成链接，避免打开邮件时加载远程资源", () => {
    expect(renderMarkdown("![图](https://example.com/a.png)")).toContain('<a style="color:#2563eb;" href="https://example.com/a.png">图</a>');
  });
});

describe("renderHtml", () => {
  it("完成卡片带状态色、改动行数和各区块", () => {
    const record: NotificationRecord = {
      kind: "completed",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "claude",
      durationMs: 180_000,
      runningRootCount: 0,
      agentTitle: "登录 <修复>",
      cwd: "/repo",
      turn: {
        prompt: "修复登录超时",
        reply: "**已修复**",
        files: ["/repo/src/auth.ts"],
        commandCount: 2,
        failedToolCount: 1,
        todo: [{ text: "补测试", completed: false }],
      },
    };
    const html = renderHtml([record]);
    expect(html).toContain("border-left:4px solid #16a34a");
    expect(html).toContain("✅ Claude 完成");
    expect(html).toContain("演示项目 · feature/demo · 3 分钟 · 本分支已全部结束");
    expect(html).toContain("登录 &lt;修复&gt;");
    expect(html).toContain(">+42</span>");
    expect(html).toContain("<strong>已修复</strong>");
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("失败的工具调用 1 次");
    expect(html).toContain("○ 补测试");
  });

  it("权限卡片给 diff 行上色，失败卡片展示错误", () => {
    const html = renderHtml([
      {
        kind: "permission",
        agentId: "b",
        workspaceId: "ws-1",
        workspace,
        provider: "claude",
        toolName: "Edit",
        permission: { title: null, body: "编辑：src/a.ts\n--- a\n+++ b\n-old\n+new" },
      },
      {
        kind: "failed",
        agentId: "c",
        workspaceId: "ws-1",
        workspace,
        provider: "codex",
        durationMs: 60_000,
        error: "boom <x>",
      },
    ]);
    expect(html).toContain('<span style="color:#b91c1c;">-old</span>');
    expect(html).toContain('<span style="color:#15803d;">+new</span>');
    expect(html).toContain("--- a\n+++ b");
    expect(html).toContain("border-left:4px solid #d97706");
    expect(html).toContain("❌ Codex 失败");
    expect(html).toContain("boom &lt;x&gt;");
  });
});
