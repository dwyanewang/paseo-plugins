import { startupMessage } from "./notices";
import type { NotificationSender } from "./types";

// Every plugin start (install, reload, daemon restart) sends one message, so a wrong authorization
// code or address shows up right away instead of at the next long agent turn.
export async function sendStartupNotice(
  sender: NotificationSender,
  host: string,
  log?: (message: string, details?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    if (await sender.send(startupMessage(host))) return true;
    log?.("启动测试邮件未送达，邮件通知当前不可用");
  } catch (error) {
    log?.("启动测试邮件发送异常", { error: error instanceof Error ? error.message : String(error) });
  }
  return false;
}
