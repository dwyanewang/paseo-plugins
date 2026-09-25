import type { PluginSecretStore } from "@getpaseo/plugin/server";
import nodemailer from "nodemailer";
import { readCredentials, type SmtpCredentials } from "./credentials";
import type { NotificationSender, OutgoingMessage } from "./types";

export type MailTransport = (
  credentials: SmtpCredentials,
  mail: { subject: string; text: string; html?: string },
) => Promise<string>;

export interface MailSenderOptions {
  transport?: MailTransport;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

const SENDER_NAME = "Paseo";

const smtpTransport: MailTransport = async (credentials, mail) => {
  const transporter = nodemailer.createTransport({
    host: credentials.host,
    port: credentials.port,
    // 465 is implicit TLS; other ports upgrade with STARTTLS when the server offers it.
    secure: credentials.port === 465,
    auth: { user: credentials.user, pass: credentials.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    const info = await transporter.sendMail({
      from: { name: SENDER_NAME, address: credentials.user },
      to: credentials.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    });
    return info.messageId;
  } finally {
    transporter.close();
  }
};

// WeChat's "QQ 邮箱提醒" shows the subject first, so it carries the whole message when there is one
// line and a count otherwise.
export function mailSubject(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() && !line.startsWith(" "));
  const first = lines[0]?.trim() ?? text.trim();
  return lines.length > 1 ? `${first} 等 ${lines.length} 条` : first;
}

export type SendResult = { status: "sent"; messageId: string } | { status: "unconfigured" } | { status: "failed"; error: string };

export interface MailSender extends NotificationSender {
  sendDetailed(message: OutgoingMessage): Promise<SendResult>;
}

export function createMailSender(secrets: PluginSecretStore, options: MailSenderOptions = {}): MailSender {
  const transport = options.transport ?? smtpTransport;
  async function sendDetailed(message: OutgoingMessage): Promise<SendResult> {
    // Read on every send so a save from the settings screen takes effect without a reload.
    const credentials = await readCredentials(secrets);
    if (!credentials) {
      options.log?.("未配置发件邮箱，在 设置 → 插件 → mail-notify 里填写");
      return { status: "unconfigured" };
    }
    try {
      const messageId = await transport(credentials, {
        subject: mailSubject(message.summary),
        text: message.body,
        ...(message.html ? { html: message.html } : {}),
      });
      options.log?.("邮件通知发送成功");
      return { status: "sent", messageId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.log?.("邮件发送失败", { error: reason });
      return { status: "failed", error: reason };
    }
  }
  return {
    sendDetailed,
    async send(message) {
      const result = await sendDetailed(message);
      return result.status === "sent" ? result.messageId : null;
    },
  };
}
