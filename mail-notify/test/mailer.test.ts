import { describe, expect, it } from "vitest";
import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { readConfig, writeConfig } from "../server/credentials";
import { createMailSender, mailSubject, type MailTransport } from "../server/mailer";

class Secrets implements PluginSecretStore {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async has(key: string) { return this.values.has(key); }
  async keys() { return [...this.values.keys()]; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

const CONFIG = { host: "smtp.163.com", port: 465, user: "bot@163.com", to: "me@qq.com" };

describe("邮件标题", () => {
  it("单条通知用整行做标题", () => {
    expect(mailSubject("✅ app · main · Claude 完成 · 3 分钟 · 本分支已全部结束")).toBe(
      "✅ app · main · Claude 完成 · 3 分钟 · 本分支已全部结束",
    );
  });

  it("失败详情的缩进行不计数", () => {
    expect(mailSubject("❌ app · main · Codex 失败 · 2 分钟\n   boom")).toBe("❌ app · main · Codex 失败 · 2 分钟");
  });

  it("多条合并时标注条数", () => {
    expect(mailSubject("✅ a · main · 2 个完成\n⏸ b · dev · 等待批准：Bash")).toBe("✅ a · main · 2 个完成 等 2 条");
  });
});

describe("SMTP 配置", () => {
  it("首次保存必须带授权码，之后留空保留原值", async () => {
    const secrets = new Secrets();
    expect(await writeConfig(secrets, CONFIG, "")).toBe("missing-password");
    expect(await readConfig(secrets)).toBeNull();
    expect(await writeConfig(secrets, CONFIG, "code-1")).toBe("saved");
    expect(await writeConfig(secrets, { ...CONFIG, to: "other@qq.com" }, "")).toBe("saved");
    expect(secrets.values.get("smtp.password")).toBe("code-1");
    expect(await readConfig(secrets)).toEqual({ ...CONFIG, to: "other@qq.com" });
  });
});

describe("mail sender", () => {
  it("未配置时不发送", async () => {
    const logs: string[] = [];
    let calls = 0;
    const sender = createMailSender(new Secrets(), {
      transport: async () => (calls++, "id"),
      log: (message) => logs.push(message),
    });
    expect(await sender.send({ summary: "hello", body: "hello" })).toBeNull();
    expect(calls).toBe(0);
    expect(logs).toEqual(["未配置发件邮箱，在 设置 → 插件 → mail-notify 里填写"]);
  });

  it("用保存的凭据发送，标题取自正文", async () => {
    const secrets = new Secrets();
    await writeConfig(secrets, CONFIG, "code-1");
    const sent: Parameters<MailTransport>[] = [];
    const sender = createMailSender(secrets, {
      transport: async (...args) => (sent.push(args), "<id@163.com>"),
    });
    expect(await sender.send({ summary: "✅ one\n⏸ two", body: "details" })).toBe("<id@163.com>");
    expect(sent).toEqual([[{ ...CONFIG, password: "code-1" }, { subject: "✅ one 等 2 条", text: "details" }]]);
  });

  it("有 HTML 版本时一并交给 SMTP", async () => {
    const secrets = new Secrets();
    await writeConfig(secrets, CONFIG, "code-1");
    const mails: Parameters<MailTransport>[1][] = [];
    const sender = createMailSender(secrets, { transport: async (_credentials, mail) => (mails.push(mail), "id") });
    await sender.send({ summary: "✅ one", body: "text", html: "<p>html</p>" });
    expect(mails).toEqual([{ subject: "✅ one", text: "text", html: "<p>html</p>" }]);
  });

  it("SMTP 报错时返回失败原因且不抛出", async () => {
    const secrets = new Secrets();
    await writeConfig(secrets, CONFIG, "code-1");
    const sender = createMailSender(secrets, {
      transport: async () => {
        throw new Error("535 Error: authentication failed");
      },
    });
    expect(await sender.sendDetailed({ summary: "hi", body: "hi" })).toEqual({ status: "failed", error: "535 Error: authentication failed" });
    expect(await sender.send({ summary: "hi", body: "hi" })).toBeNull();
  });
});
