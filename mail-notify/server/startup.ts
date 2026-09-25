import type { NotificationSender } from "./types";

export const STARTUP_TEXT = "🔔 Paseo 邮件通知已连接";

// Every plugin start (install, reload, daemon restart) sends one message, so a wrong authorization
// code or address shows up right away instead of at the next long agent turn.
export async function sendStartupNotice(
  sender: NotificationSender,
  log?: (message: string, details?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    if (await sender.send({ summary: STARTUP_TEXT, body: STARTUP_TEXT })) return true;
    log?.("启动测试邮件未送达，邮件通知当前不可用");
  } catch (error) {
    log?.("启动测试邮件发送异常", { error: error instanceof Error ? error.message : String(error) });
  }
  return false;
}
