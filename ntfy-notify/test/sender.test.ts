import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { CARD_VERSION } from "../shared/card";
import type { CardDocument } from "../shared/card";
import { readConfig, writeConfig } from "../server/config";
import { capBytes, createNtfySender, messageBody } from "../server/sender";
import type { OutgoingMessage } from "../server/types";

class Secrets implements PluginSecretStore {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async has(key: string) { return this.values.has(key); }
  async keys() { return [...this.values.keys()]; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

const message: OutgoingMessage = { title: "✅ 完成 · 登录修复 · 38 秒", summary: "s", body: "正文", priority: 3 };

const card = (): CardDocument => ({
  version: CARD_VERSION,
  blocks: [
    { type: "heading", text: "✅ 任务完成" },
    { type: "status", label: "演示项目 · feature/demo · 完成", tone: "success" },
  ],
});

let close: (() => void) | undefined;
afterEach(() => close?.());

async function fakeNtfy(status: number, reply: object) {
  const requests: { headers: IncomingMessage["headers"]; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
      requests.push({ headers: request.headers, body: JSON.parse(data) });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => server.close();
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe("capBytes", () => {
  it("不超过上限的正文原样保留", () => {
    expect(capBytes("短正文")).toBe("短正文");
  });

  it("超长正文按字节截断，不切开多字节字符", () => {
    const capped = capBytes("字".repeat(20_000));
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(15_500);
    expect(capped.endsWith("…（内容过长，已截断）")).toBe(true);
    expect(capped).not.toContain("�");
  });
});

describe("messageBody", () => {
  it("有卡片时发送卡片 JSON 字符串", () => {
    const body = messageBody({ ...message, card: card() });
    expect(body.card).toBe(true);
    const parsed = JSON.parse(body.text) as CardDocument;
    expect(parsed.version).toBe(1);
    expect(parsed.blocks.length).toBeGreaterThan(0);
  });

  it("没有卡片时回退到纯文本正文", () => {
    expect(messageBody(message)).toEqual({ text: "正文", card: false });
  });

  it("卡片放不下时回退到纯文本正文", () => {
    // 把上限压到连最小卡片都放不下，确定性地走回退分支。
    expect(messageBody({ ...message, card: card() }, 5)).toEqual({ text: "正文", card: false });
  });

  it("卡片能放下但超过默认 15.5 KiB 上限时也是合法 JSON 或回退", () => {
    const oversized: CardDocument = {
      version: CARD_VERSION,
      blocks: [{ type: "markdown", text: "超长内容".repeat(30_000) }],
    };
    const body = messageBody({ ...message, card: oversized });
    if (body.card) {
      const parsed = JSON.parse(body.text) as CardDocument;
      expect(Buffer.byteLength(body.text)).toBeLessThanOrEqual(15_500);
      expect(parsed.version).toBe(1);
    } else {
      expect(body).toEqual({ text: "正文", card: false });
    }
  });
});

describe("ntfy 配置", () => {
  it("保存时去掉末尾斜杠；令牌留空保留，清除时删除", async () => {
    const secrets = new Secrets();
    await writeConfig(secrets, { server: "http://127.0.0.1:2586", topic: "paseo" }, "tk_1", false);
    await writeConfig(secrets, { server: "http://127.0.0.1:2586", topic: "paseo" }, "", false);
    expect(secrets.values.get("ntfy.token")).toBe("tk_1");
    await writeConfig(secrets, { server: "http://127.0.0.1:2586", topic: "paseo" }, "", true);
    expect(secrets.values.has("ntfy.token")).toBe(false);
    secrets.values.set("ntfy.server", "http://x:1/");
    expect(await readConfig(secrets)).toEqual({ server: "http://x:1", topic: "paseo" });
  });
});

describe("ntfy sender", () => {
  it("未配置时不发送", async () => {
    const logs: string[] = [];
    const sender = createNtfySender(new Secrets(), { log: (text) => logs.push(text) });
    expect(await sender.send(message)).toBeNull();
    expect(logs).toEqual(["未配置 ntfy 服务器，在 设置 → 插件 → ntfy-notify 里填写"]);
  });

  it("以 JSON 发布到服务器根路径并带上令牌", async () => {
    const ntfy = await fakeNtfy(200, { id: "msg-1" });
    const secrets = new Secrets();
    await writeConfig(secrets, { server: ntfy.url, topic: "paseo" }, "tk_secret", false);
    const sender = createNtfySender(secrets);
    expect(await sender.send(message)).toBe("msg-1");
    expect(ntfy.requests[0]?.headers.authorization).toBe("Bearer tk_secret");
    expect(ntfy.requests[0]?.body).toEqual({ topic: "paseo", title: message.title, message: "正文", priority: 3 });
  });

  it("有卡片时请求体里的 message 是卡片 JSON 字符串", async () => {
    const ntfy = await fakeNtfy(200, { id: "msg-card" });
    const secrets = new Secrets();
    await writeConfig(secrets, { server: ntfy.url, topic: "paseo" }, "", false);
    await createNtfySender(secrets).send({ ...message, card: card() });
    const sent = ntfy.requests[0]!.body as { message: string };
    expect(typeof sent.message).toBe("string");
    const parsed = JSON.parse(sent.message) as CardDocument;
    expect(parsed.version).toBe(1);
    expect(parsed.blocks[0]?.type).toBe("heading");
  });

  it("没有令牌时不带认证头", async () => {
    const ntfy = await fakeNtfy(200, { id: "msg-2" });
    const secrets = new Secrets();
    await writeConfig(secrets, { server: ntfy.url, topic: "paseo" }, "", false);
    await createNtfySender(secrets).send(message);
    expect(ntfy.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("服务器拒绝时返回它给出的原因", async () => {
    const ntfy = await fakeNtfy(403, { code: 40301, error: "forbidden" });
    const secrets = new Secrets();
    await writeConfig(secrets, { server: ntfy.url, topic: "paseo" }, "tk_bad", false);
    expect(await createNtfySender(secrets).sendDetailed(message)).toEqual({ status: "failed", error: "HTTP 403：forbidden" });
  });

  it("连不上服务器时返回失败而不抛出", async () => {
    const secrets = new Secrets();
    await writeConfig(secrets, { server: "http://127.0.0.1:1", topic: "paseo" }, "", false);
    const result = await createNtfySender(secrets).sendDetailed(message);
    expect(result.status).toBe("failed");
  });
});
