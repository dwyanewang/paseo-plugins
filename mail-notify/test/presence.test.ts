import { describe, expect, it } from "vitest";
import { isWatching } from "../server/presence";

const now = Date.parse("2026-09-25T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("isWatching", () => {
  it("前台 App 三分钟内有操作才算在看", () => {
    expect(isWatching({ userPresent: true, clients: [{ appVisible: true, lastActivityAt: ago(60_000) }] }, now)).toBe(true);
    expect(isWatching({ userPresent: true, clients: [{ appVisible: true, lastActivityAt: ago(181_000) }] }, now)).toBe(false);
  });

  it("手机刚切到后台或锁屏不算在看，即便宿主仍判定为在场", () => {
    expect(isWatching({ userPresent: true, clients: [{ appVisible: false, lastActivityAt: ago(10_000) }] }, now)).toBe(false);
  });

  it("多个 App 中任一满足即算在看", () => {
    expect(
      isWatching(
        {
          userPresent: true,
          clients: [
            { appVisible: false, lastActivityAt: ago(5_000) },
            { appVisible: true, lastActivityAt: ago(90_000) },
          ],
        },
        now,
      ),
    ).toBe(true);
  });

  it("没有连接的 App 时不算在看；时间戳无效时忽略该 App", () => {
    expect(isWatching({ userPresent: false, clients: [] }, now)).toBe(false);
    expect(isWatching({ userPresent: true, clients: [{ appVisible: true, lastActivityAt: null }] }, now)).toBe(false);
  });

  it("宿主不提供客户端列表时沿用 userPresent", () => {
    expect(isWatching({ userPresent: true }, now)).toBe(true);
  });
});
