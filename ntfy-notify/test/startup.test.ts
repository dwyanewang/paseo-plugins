import { describe, expect, it } from "vitest";
import { STARTUP_TITLE, startupMessage, testMessage } from "../server/notices";
import { sendStartupNotice } from "../server/startup";

describe("启动通知", () => {
  it("发送一条低优先级的连接通知且不记失败日志", async () => {
    const sent: { title: string; priority: number }[] = [];
    const logs: string[] = [];
    const ok = await sendStartupNotice(
      { send: async (message) => (sent.push(message), "id") },
      "host-1",
      (text) => logs.push(text),
    );
    expect(ok).toBe(true);
    expect(sent[0]?.title).toBe(STARTUP_TITLE);
    expect(sent[0]?.priority).toBe(2);
    expect(logs).toEqual([]);
  });

  it("未送达时记日志，发送抛错时不向外抛出", async () => {
    const logs: string[] = [];
    expect(await sendStartupNotice({ send: async () => null }, "host-1", (text) => logs.push(text))).toBe(false);
    expect(
      await sendStartupNotice({ send: async () => { throw new Error("boom"); } }, "host-1", (text) => logs.push(text)),
    ).toBe(false);
    expect(logs).toEqual(["启动通知未送达，ntfy 通知当前不可用", "启动通知发送异常"]);
  });

  it("启动和测试通知的正文", () => {
    expect(startupMessage("work-pc").body).toContain("来自 work-pc");
    expect(testMessage({ server: "http://127.0.0.1:2586", topic: "paseo" }).body).toContain("主题：paseo");
  });
});
