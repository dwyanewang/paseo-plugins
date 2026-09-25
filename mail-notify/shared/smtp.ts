import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Presets cover the mailboxes that work with WeChat's "QQ 邮箱提醒"; every other server is "custom".
// An array keeps the menu order: object keys like "163" would sort before "qq".
export const SMTP_PRESETS = [
  { id: "163", label: "163 邮箱", host: "smtp.163.com", port: 465 },
  { id: "126", label: "126 邮箱", host: "smtp.126.com", port: 465 },
  { id: "qq", label: "QQ 邮箱", host: "smtp.qq.com", port: 465 },
] as const;

export type SmtpPreset = (typeof SMTP_PRESETS)[number];

export const smtpConfigSchema = z.object({
  host: z.string().trim().min(1, "请填写 SMTP 服务器"),
  port: z.number().int().min(1).max(65_535),
  user: z.string().trim().email("发件地址格式不对"),
  to: z.string().trim().email("收件地址格式不对"),
});

export type SmtpConfig = z.infer<typeof smtpConfigSchema>;

export const readSmtpConfig = defineRpc({
  name: "smtp.read",
  input: z.object({}),
  // The authorization code never leaves the daemon; the client only learns whether one is stored.
  output: z.object({
    config: smtpConfigSchema.nullable(),
    hasPassword: z.boolean(),
  }),
});

export const saveSmtpConfig = defineRpc({
  name: "smtp.save",
  input: smtpConfigSchema.extend({
    // Empty keeps the stored code, so the form can be saved without retyping it.
    password: z.string(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved") }),
    z.object({ status: z.literal("missing-password") }),
  ]),
});

export const sendTestMail = defineRpc({
  name: "smtp.test",
  input: z.object({}),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("sent") }),
    z.object({ status: z.literal("unconfigured") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});
