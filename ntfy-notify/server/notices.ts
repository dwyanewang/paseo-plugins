import type { CardDocument } from "../shared/card";
import { CARD_VERSION } from "../shared/card";
import type { NtfyConfig } from "../shared/ntfy";
import type { OutgoingMessage } from "./types";

export const STARTUP_TITLE = "🔔 Paseo 通知已连接";
export const TEST_TITLE = "🔔 Paseo 通知测试";

export function startupMessage(host: string): OutgoingMessage {
  const steps = [
    "主 agent 完成一轮；它派出的后台工作还在跑时，等全部结束再发",
    "主 agent 这一轮失败",
    "权限请求 20 秒内没人处理",
    "你正在前台使用 Paseo 时不发",
  ];
  const body = [
    `来自 ${host}。每次插件启动（安装、重新加载、daemon 重启）都会收到这条。`,
    "",
    "【什么时候通知】",
    ...steps.map((step) => `- ${step}`),
  ].join("\n");
  const card: CardDocument = {
    version: CARD_VERSION,
    blocks: [
      { type: "heading", text: "Paseo 通知已连接" },
      { type: "status", label: `来自 ${host}`, tone: "success" },
      { type: "markdown", text: `**【什么时候通知】**\n\n${steps.map((step) => `- ${step}`).join("\n")}` },
    ],
  };
  // Low priority: no sound or vibration for a message that only confirms the connection.
  return { title: STARTUP_TITLE, summary: STARTUP_TITLE, body, card, priority: 2 };
}

export function testMessage(config: NtfyConfig): OutgoingMessage {
  const body = ["收到这条，说明 ntfy 配置正确，agent 通知会按下面的设置发出。", "", `服务器：${config.server}`, `主题：${config.topic}`].join(
    "\n",
  );
  const card: CardDocument = {
    version: CARD_VERSION,
    blocks: [
      { type: "heading", text: "Paseo 通知测试" },
      { type: "status", label: "配置正确", tone: "success" },
      {
        type: "kv",
        items: [
          { label: "服务器", value: config.server },
          { label: "主题", value: config.topic },
        ],
      },
    ],
  };
  return { title: TEST_TITLE, summary: TEST_TITLE, body, card, priority: 3 };
}
