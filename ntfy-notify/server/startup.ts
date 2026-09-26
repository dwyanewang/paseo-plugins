import { startupMessage } from "./notices";
import type { NotificationSender } from "./types";

// Every plugin start (install, reload, daemon restart) sends one message, so a wrong token or
// unreachable server shows up right away instead of at the next agent turn.
export async function sendStartupNotice(
  sender: NotificationSender,
  host: string,
  log?: (message: string, details?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    if (await sender.send(startupMessage(host))) return true;
    log?.("启动通知未送达，ntfy 通知当前不可用");
  } catch (error) {
    log?.("启动通知发送异常", { error: error instanceof Error ? error.message : String(error) });
  }
  return false;
}
