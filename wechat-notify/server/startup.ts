import type { NotificationSender } from "./types";

export const STARTUP_TEXT = "🔔 Paseo 微信通知已连接";

// Every plugin start (install, reload, daemon restart) sends one message, so a stale token or
// missing recipient shows up right away instead of at the next long agent turn.
export async function sendStartupNotice(
  sender: NotificationSender,
  log?: (message: string, details?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    if (await sender.send(STARTUP_TEXT)) return true;
    log?.("启动测试通知未送达，微信推送当前不可用");
  } catch (error) {
    log?.("启动测试通知发送异常", { error: error instanceof Error ? error.message : String(error) });
  }
  return false;
}
