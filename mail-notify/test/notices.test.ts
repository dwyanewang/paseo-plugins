import { describe, expect, it } from "vitest";
import { startupMessage, testMessage } from "../server/notices";

describe("插件自己的邮件", () => {
  it("启动邮件带样式、来源机器和通知时机", () => {
    const message = startupMessage("work-pc");
    expect(message.subject).toBe("🔔 Paseo 邮件通知已连接");
    expect(message.html).toContain("border-left:4px solid #2563eb");
    expect(message.html).toContain("来自 work-pc");
    expect(message.html).toContain("权限请求 20 秒内没人处理");
    expect(message.body).toContain("【什么时候通知】\n- 主 agent 完成一轮");
  });

  it("测试邮件列出生效的配置，不含授权码", () => {
    const message = testMessage({ host: "smtp.163.com", port: 465, user: "bot@163.com", to: "me@qq.com" });
    expect(message.subject).toBe("🔔 Paseo 邮件通知测试");
    expect(message.html).toContain("smtp.163.com:465（SSL）");
    expect(message.body).toContain("收件地址：me@qq.com");
    expect(testMessage({ host: "smtp.x.com", port: 587, user: "a@x.com", to: "b@qq.com" }).body).toContain("587（STARTTLS）");
  });

  it("标题等内容里的特殊字符会被转义", () => {
    expect(startupMessage("<pc>").html).toContain("来自 &lt;pc&gt;");
  });
});
