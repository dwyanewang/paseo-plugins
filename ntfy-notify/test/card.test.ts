import { describe, expect, it } from "vitest";
import { CARD_CONTENT_TYPE, CARD_VERSION, cardByteLength, serializeCard, truncateUtf8 } from "../shared/card";
import type { CardDocument } from "../shared/card";
import { buildCard } from "../server/card";
import type { NotificationRecord, NotificationWorkspace } from "../server/types";

const workspace: NotificationWorkspace = {
  id: "ws-1",
  projectDisplayName: "演示项目",
  projectKind: "git",
  name: "feature/demo",
  branch: "feature/demo",
  status: "done",
  diffStat: { additions: 3, deletions: 1 },
};

function parse(text: string): CardDocument {
  return JSON.parse(text) as CardDocument;
}

describe("卡片序列化", () => {
  it("默认文档是合法 JSON，version 为 1，blocks 是数组", () => {
    const text = serializeCard({ version: CARD_VERSION, blocks: [{ type: "heading", text: "标题" }] });
    expect(text).not.toBeNull();
    const doc = parse(text!);
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.blocks)).toBe(true);
    expect(doc.blocks[0]).toEqual({ type: "heading", text: "标题" });
  });

  it("content type 常量与 Android 端一致", () => {
    expect(CARD_CONTENT_TYPE).toBe("application/vnd.ntfy.card+json;v=1");
    expect(CARD_CONTENT_TYPE.split(";")[0]).toBe("application/vnd.ntfy.card+json");
  });

  it("超长文档截断后仍是合法 JSON 且不超字节上限", () => {
    const limit = 2_000;
    const blocks = Array.from({ length: 40 }, (_, index) => ({
      type: "markdown" as const,
      text: `第 ${index} 段：${"内容".repeat(200)}`,
    }));
    const text = serializeCard({ version: CARD_VERSION, blocks }, limit);
    expect(text).not.toBeNull();
    const doc = parse(text!);
    expect(doc.version).toBe(1);
    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(cardByteLength(doc)).toBeLessThanOrEqual(limit);
  });

  it("单个超长 block 也能压进上限，或明确返回 null", () => {
    const text = serializeCard({ version: CARD_VERSION, blocks: [{ type: "markdown", text: "很长".repeat(10_000) }] }, 1_000);
    if (text !== null) {
      expect(cardByteLength(parse(text))).toBeLessThanOrEqual(1_000);
    }
  });

  it("上限小到放不下最小卡片时返回 null，交给纯文本回退", () => {
    expect(serializeCard({ version: CARD_VERSION, blocks: [{ type: "heading", text: "标题" }] }, 5)).toBeNull();
  });

  it("truncateUtf8 不切开多字节字符", () => {
    const cut = truncateUtf8("汉字测试", 4);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(4);
    expect(cut).not.toContain("\uFFFD");
  });
});

describe("卡片构建", () => {
  it("完成记录带 status 成功、kv 与标题", () => {
    const record: NotificationRecord = {
      kind: "completed",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "claude",
      durationMs: 38_000,
      runningRootCount: 0,
      agentTitle: "登录修复",
      turn: { prompt: "修复登录", reply: "已修复", files: ["a.ts"], commandCount: 2, failedToolCount: 0, todo: null },
    };
    const card = buildCard([record]);
    expect(card.version).toBe(1);
    const heading = card.blocks[0]!;
    expect(heading.type).toBe("heading");
    expect(heading.type === "heading" && heading.text).toContain("完成");
    const status = card.blocks.find((block) => block.type === "status");
    expect(status).toMatchObject({ type: "status", tone: "success" });
    expect(card.blocks.some((block) => block.type === "kv")).toBe(true);
    expect(JSON.stringify(card)).toContain("修复登录");
  });

  it("指令与回复是 section，指令用引用块渲染成 callout", () => {
    const record: NotificationRecord = {
      kind: "completed",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "claude",
      runningRootCount: 0,
      turn: { prompt: "修复登录\n补充测试", reply: "已修复", files: [], commandCount: 1, failedToolCount: 0, todo: null },
    };
    const card = buildCard([record]);
    const prompt = card.blocks.find((block) => block.type === "section" && block.label === "你的指令");
    expect(prompt).toBeDefined();
    // Every non-blank line of the prompt is quoted, so the Android client boxes it as a callout.
    expect(prompt?.type === "section" && prompt.body).toBe("> 修复登录\n> 补充测试");
    expect(prompt?.type === "section" && prompt.markdown).toBe(true);
    const reply = card.blocks.find((block) => block.type === "section" && block.label === "Agent 回复");
    // A reply is shown as-is, without the callout box.
    expect(reply?.type === "section" && reply.body).toBe("已修复");
  });

  it("失败记录带 status 失败与错误 section", () => {
    const record: NotificationRecord = {
      kind: "failed",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "codex",
      errorFirstLine: "boom",
      error: "boom\n详细堆栈",
    };
    const card = buildCard([record]);
    const status = card.blocks.find((block) => block.type === "status");
    expect(status).toMatchObject({ tone: "error" });
    expect(card.blocks.some((block) => block.type === "section" && block.label === "错误" && block.body.includes("boom"))).toBe(
      true,
    );
    expect(card.blocks[0]!.type === "heading" && card.blocks[0]!.text).toContain("失败");
  });

  it("待批准记录带 status warning 与权限详情", () => {
    const record: NotificationRecord = {
      kind: "permission",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "claude",
      toolName: "Bash",
      permission: { title: "要执行命令", body: "rm -rf build" },
    };
    const card = buildCard([record]);
    const status = card.blocks.find((block) => block.type === "status");
    expect(status).toMatchObject({ tone: "warning" });
    expect(JSON.stringify(card)).toContain("rm -rf build");
  });

  it("多条记录之间用 divider 分隔", () => {
    const base: NotificationRecord = {
      kind: "completed",
      agentId: "a",
      workspaceId: "ws-1",
      workspace,
      provider: "claude",
      runningRootCount: 0,
    };
    const card = buildCard([base, { ...base, agentId: "b", workspaceId: "ws-2" }]);
    expect(card.blocks.filter((block) => block.type === "divider")).toHaveLength(1);
  });
});
