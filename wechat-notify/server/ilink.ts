import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { SECRET_KEYS } from "./constants";
import type { NotificationSender } from "./types";

const APP_CLIENT_VERSION = String((2 << 16) | (2 << 8));

interface Credentials {
  token: string;
  baseUrl: string;
  toUser: string;
}

export interface IlinkSenderOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
  randomUint32?: () => number;
  homeDir?: string;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

interface HermesAccount {
  token?: unknown;
  base_url?: unknown;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function importFromHermes(
  secrets: PluginSecretStore,
  options: IlinkSenderOptions,
): Promise<Credentials | null> {
  const home = options.homeDir ?? homedir();
  const directory = `${home}/.hermes/weixin/accounts`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    options.log?.("未找到 Hermes 微信账号文件，暂不推送");
    return null;
  }
  const accountFiles = names.filter((name) => /@im\.bot\.json$/.test(name));
  for (const accountFile of accountFiles) {
    try {
      const account = JSON.parse(await readFile(`${directory}/${accountFile}`, "utf8")) as HermesAccount;
      const token = safeString(account.token);
      const baseUrl = safeString(account.base_url);
      const contextFile = accountFile.replace(/\.json$/, ".context-tokens.json");
      const context = JSON.parse(await readFile(`${directory}/${contextFile}`, "utf8")) as unknown;
      const toUser =
        context && typeof context === "object"
          ? Object.keys(context as Record<string, unknown>).find((key) => key.trim().length > 0) ?? null
          : null;
      if (!token || !baseUrl || !toUser) continue;
      const current = {
        token: (await secrets.get(SECRET_KEYS.token)) ?? token,
        baseUrl: (await secrets.get(SECRET_KEYS.baseUrl)) ?? baseUrl,
        toUser: (await secrets.get(SECRET_KEYS.toUser)) ?? toUser,
      };
      if (!(await secrets.has(SECRET_KEYS.token))) await secrets.set(SECRET_KEYS.token, current.token);
      if (!(await secrets.has(SECRET_KEYS.baseUrl))) await secrets.set(SECRET_KEYS.baseUrl, current.baseUrl);
      if (!(await secrets.has(SECRET_KEYS.toUser))) await secrets.set(SECRET_KEYS.toUser, current.toUser);
      options.log?.("已从 Hermes 账号导入 iLink 凭据");
      return current;
    } catch {
      // A stale or partially written account is ignored; try the next account.
    }
  }
  options.log?.("未找到可用的 Hermes 微信账号凭据，暂不推送");
  return null;
}

async function loadCredentials(
  secrets: PluginSecretStore,
  options: IlinkSenderOptions,
): Promise<Credentials | null> {
  const existing = {
    token: await secrets.get(SECRET_KEYS.token),
    baseUrl: await secrets.get(SECRET_KEYS.baseUrl),
    toUser: await secrets.get(SECRET_KEYS.toUser),
  };
  if (existing.token && existing.baseUrl && existing.toUser) {
    return { token: existing.token, baseUrl: existing.baseUrl, toUser: existing.toUser };
  }
  return importFromHermes(secrets, options);
}

export function createIlinkSender(secrets: PluginSecretStore, options: IlinkSenderOptions = {}): NotificationSender {
  const request = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const random = options.randomUint32 ?? (() => randomBytes(4).readUInt32BE(0));
  let credentialsPromise: Promise<Credentials | null> | undefined;
  return {
    async send(text: string): Promise<string | null> {
      credentialsPromise ??= loadCredentials(secrets, options);
      const credentials = await credentialsPromise;
      if (!credentials) return null;
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: credentials.toUser,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: "2.2.0" },
      };
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        try {
          const response = await request(`${credentials.baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`, {
            method: "POST",
            body: JSON.stringify(body),
            headers: {
              "Content-Type": "application/json",
              AuthorizationType: "ilink_bot_token",
              "X-WECHAT-UIN": Buffer.from(String(random())).toString("base64"),
              "iLink-App-Id": "bot",
              "iLink-App-ClientVersion": APP_CLIENT_VERSION,
              Authorization: `Bearer ${credentials.token}`,
            },
          });
          if (response.status !== 200) {
            options.log?.("iLink HTTP 请求失败", { status: response.status });
            return null;
          }
          const payload = (await response.json()) as { message_id?: unknown; ret?: unknown; errcode?: unknown };
          const code = typeof payload.ret === "number" ? payload.ret : payload.errcode;
          if (typeof code === "number" && code !== 0) {
            if (code === -2 && attempt < 2) {
              await sleep(250 * 2 ** attempt);
              continue;
            }
            options.log?.("iLink 返回失败", { code });
            return null;
          }
          // The live API returns message_id as a number (e.g. 7509059992810059656);
          // the earlier string-only check treated every real success as a failure.
          const messageId =
            typeof payload.message_id === "string" && payload.message_id
              ? payload.message_id
              : typeof payload.message_id === "number"
                ? String(payload.message_id)
                : null;
          if (!messageId) {
            options.log?.("iLink 返回缺少 message_id");
            return null;
          }
          options.log?.("微信通知发送成功", { message_id: messageId });
          return messageId;
        } catch (error) {
          options.log?.("iLink 请求异常", { error: error instanceof Error ? error.message : String(error) });
          return null;
        }
      }
      return null;
    },
  };
}

export { loadCredentials, importFromHermes };
