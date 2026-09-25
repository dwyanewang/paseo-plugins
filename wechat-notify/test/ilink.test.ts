import { describe, expect, it } from "vitest";
import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { createIlinkSender } from "../server/ilink";

class Secrets implements PluginSecretStore {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async has(key: string) { return this.values.has(key); }
  async keys() { return [...this.values.keys()]; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

function response(payload: unknown, status = 200): Response {
  return { status, json: async () => payload } as Response;
}

describe("iLink sender", () => {
  it("直连 sendmessage 且不携带 context_token", async () => {
    const secrets = new Secrets();
    secrets.values.set("ilink.token", "test-token");
    secrets.values.set("ilink.base-url", "https://example.invalid");
    secrets.values.set("ilink.to-user", "recipient");
    let request: RequestInit | undefined;
    const sender = createIlinkSender(secrets, {
      fetch: async (_url, init) => {
        request = init;
        return response({ message_id: "message-id" });
      },
      randomUint32: () => 123,
    });
    await expect(sender.send("hello")).resolves.toBe("message-id");
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("context_token");
    expect((body.msg as Record<string, unknown>).to_user_id).toBe("recipient");
    expect(request?.headers).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "131584",
    });
  });

  it("ret=-2 最多退避重试两次", async () => {
    const secrets = new Secrets();
    secrets.values.set("ilink.token", "test-token");
    secrets.values.set("ilink.base-url", "https://example.invalid");
    secrets.values.set("ilink.to-user", "recipient");
    let calls = 0;
    const delays: number[] = [];
    const sender = createIlinkSender(secrets, {
      fetch: async () => {
        calls += 1;
        return response(calls < 3 ? { ret: -2 } : { message_id: "message-id" });
      },
      sleep: async (delay) => { delays.push(delay); },
    });
    await expect(sender.send("hello")).resolves.toBe("message-id");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });
});
