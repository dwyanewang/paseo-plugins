import { describe, expect, it } from "vitest";
import { sendStartupNotice, STARTUP_TEXT } from "../server/startup";

describe("启动测试通知", () => {
  it("发送一条连接通知且不记失败日志", async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const ok = await sendStartupNotice(
      { send: async (text) => (sent.push(text), "message-id") },
      (message) => logs.push(message),
    );
    expect(ok).toBe(true);
    expect(sent).toEqual([STARTUP_TEXT]);
    expect(logs).toEqual([]);
  });

  it("未送达时记日志", async () => {
    const logs: string[] = [];
    const ok = await sendStartupNotice({ send: async () => null }, (message) => logs.push(message));
    expect(ok).toBe(false);
    expect(logs).toEqual(["启动测试通知未送达，微信推送当前不可用"]);
  });

  it("发送抛错时不向外抛出", async () => {
    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const ok = await sendStartupNotice(
      {
        send: async () => {
          throw new Error("secrets unavailable");
        },
      },
      (message, details) => logs.push({ message, details }),
    );
    expect(ok).toBe(false);
    expect(logs).toEqual([{ message: "启动测试通知发送异常", details: { error: "secrets unavailable" } }]);
  });
});
