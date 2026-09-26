import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// The daemon publishes to the ntfy server directly, so a server on the same machine is reached
// over loopback even when phones subscribe through a public mapping.
export const DEFAULT_SERVER = "http://127.0.0.1:2586";
export const DEFAULT_TOPIC = "paseo";

export const ntfyConfigSchema = z.object({
  server: z
    .string()
    .trim()
    .url("服务器地址格式不对")
    .refine((value) => /^https?:\/\//.test(value), "服务器地址要以 http:// 或 https:// 开头")
    .transform((value) => value.replace(/\/+$/, "")),
  topic: z
    .string()
    .trim()
    .regex(/^[-_A-Za-z0-9]{1,64}$/, "主题只能用字母、数字、- 和 _，最多 64 个字符"),
});

export type NtfyConfig = z.infer<typeof ntfyConfigSchema>;

export const readNtfyConfig = defineRpc({
  name: "ntfy.read",
  input: z.object({}),
  // The access token never leaves the daemon; the client only learns whether one is stored.
  output: z.object({
    config: ntfyConfigSchema.nullable(),
    hasToken: z.boolean(),
  }),
});

export const saveNtfyConfig = defineRpc({
  name: "ntfy.save",
  input: ntfyConfigSchema.extend({
    // Empty keeps the stored token; a server without authentication needs none.
    token: z.string(),
    clearToken: z.boolean().default(false),
  }),
  output: z.object({ status: z.literal("saved") }),
});

export const sendTestNotification = defineRpc({
  name: "ntfy.test",
  input: z.object({}),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("sent") }),
    z.object({ status: z.literal("unconfigured") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});
