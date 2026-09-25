import type { SmtpConfig } from "../shared/smtp";
import { renderNotice, type Notice } from "./html";
import type { OutgoingMessage } from "./types";

export const STARTUP_TEXT = "🔔 Paseo 邮件通知已连接";
export const TEST_TEXT = "🔔 Paseo 邮件通知测试";

const WHEN_NOTIFIED = [
  "主 agent 完成一轮；它派出的后台工作还在跑时，等全部结束再发",
  "主 agent 这一轮失败",
  "权限请求 20 秒内没人处理",
];

function toMessage(subject: string, notice: Notice): OutgoingMessage {
  const text = [
    `${notice.icon} ${notice.title}`,
    ...(notice.meta ? [notice.meta] : []),
    ...notice.paragraphs.map((paragraph) => `\n${paragraph}`),
    ...(notice.facts ? ["", ...notice.facts.map(([label, value]) => `${label}：${value}`)] : []),
    ...(notice.list ? ["", `【${notice.list.title}】`, ...notice.list.items.map((item) => `- ${item}`)] : []),
  ].join("\n");
  return { subject, summary: subject, body: text, html: renderNotice(notice) };
}

export function startupMessage(host: string): OutgoingMessage {
  return toMessage(STARTUP_TEXT, {
    icon: "🔔",
    title: "Paseo 邮件通知已连接",
    meta: `来自 ${host}`,
    paragraphs: ["插件已启动，之后会用这个邮箱给你发 agent 通知。每次插件启动（安装、重新加载、daemon 重启）都会收到这封邮件。"],
    list: { title: "什么时候通知", items: [...WHEN_NOTIFIED, "你正在前台使用 Paseo 时不发"] },
  });
}

export function testMessage(config: SmtpConfig): OutgoingMessage {
  return toMessage(TEST_TEXT, {
    icon: "🔔",
    title: "测试邮件",
    paragraphs: ["收到这封邮件，说明 SMTP 配置正确，agent 通知会按下面的设置发出。"],
    facts: [
      ["SMTP 服务器", `${config.host}:${config.port}（${config.port === 465 ? "SSL" : "STARTTLS"}）`],
      ["发件地址", config.user],
      ["收件地址", config.to],
    ],
  });
}
