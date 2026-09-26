import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { serializeCard } from "../shared/card";
import { readCredentials, type NtfyCredentials } from "./config";
import type { NotificationSender, OutgoingMessage } from "./types";

// Stock ntfy stores the card as the plain message body, so the JSON string must stay under the
// server's 16 KiB message-size-limit; serializeCard keeps a margin for the publish envelope.
const PLAIN_BYTE_LIMIT = 15_500;
const TRUNCATED = "\n…（内容过长，已截断）";

export type Publish = (credentials: NtfyCredentials, payload: NtfyPayload) => Promise<string>;

export interface NtfyPayload {
  topic: string;
  title: string;
  message: string;
  priority: number;
}

export interface NtfySenderOptions {
  publish?: Publish;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export function capBytes(text: string, limit = PLAIN_BYTE_LIMIT): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const room = limit - Buffer.byteLength(TRUNCATED);
  let kept = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > room) break;
    bytes += size;
    kept += char;
  }
  return `${kept}${TRUNCATED}`;
}

/**
 * Prefer the structured card; fall back to the plain-text body when the card cannot be serialized
 * under the size limit. Either way the value is a valid message body for stock ntfy.
 */
export function messageBody(message: OutgoingMessage, cardLimit?: number): { text: string; card: boolean } {
  if (message.card) {
    const serialized = cardLimit === undefined ? serializeCard(message.card) : serializeCard(message.card, cardLimit);
    if (serialized !== null) return { text: serialized, card: true };
  }
  return { text: capBytes(message.body), card: false };
}


// JSON publishing keeps UTF-8 titles intact; header-based publishing would need RFC 2047 encoding.
const httpPublish: Publish = async (credentials, payload) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  let response: Response;
  let text: string;
  try {
    response = await fetch(credentials.server, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    text = await response.text();
  } catch (error) {
    if (abort.signal.aborted) throw new Error("连接 ntfy 服务器超时（15 秒）");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let reason = text.trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") reason = parsed.error;
    } catch {
      // Not JSON; keep the raw text.
    }
    throw new Error(`HTTP ${response.status}${reason ? `：${reason}` : ""}`);
  }
  const id = (JSON.parse(text) as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
};

export type SendResult = { status: "sent"; id: string } | { status: "unconfigured" } | { status: "failed"; error: string };

export interface NtfySender extends NotificationSender {
  sendDetailed(message: OutgoingMessage): Promise<SendResult>;
}

export function createNtfySender(secrets: PluginSecretStore, options: NtfySenderOptions = {}): NtfySender {
  const publish = options.publish ?? httpPublish;
  async function sendDetailed(message: OutgoingMessage): Promise<SendResult> {
    // Read on every send so a save from the settings screen takes effect without a reload.
    const credentials = await readCredentials(secrets);
    if (!credentials) {
      options.log?.("未配置 ntfy 服务器，在 设置 → 插件 → ntfy-notify 里填写");
      return { status: "unconfigured" };
    }
    try {
      const body = messageBody(message);
      const id = await publish(credentials, {
        topic: credentials.topic,
        title: message.title,
        message: body.text,
        priority: message.priority,
      });
      options.log?.("ntfy 通知发送成功", { title: message.title, card: body.card });
      return { status: "sent", id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.log?.("ntfy 通知发送失败", { error: reason });
      return { status: "failed", error: reason };
    }
  }
  return {
    sendDetailed,
    async send(message) {
      const result = await sendDetailed(message);
      return result.status === "sent" ? result.id || "sent" : null;
    },
  };
}
