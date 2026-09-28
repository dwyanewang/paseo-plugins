import { describe, expect, it } from "vitest";
import { describeClients, isWatching } from "../server/presence";

const now = Date.parse("2026-09-25T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("isWatching", () => {
  it("前台 App 三分钟内有操作才算在看", () => {
    expect(
      isWatching({ userPresent: true, clients: [{ deviceType: "mobile", appVisible: true, lastActivityAt: ago(60_000) }] }, now),
    ).toBe(true);
    expect(
      isWatching({ userPresent: true, clients: [{ deviceType: "mobile", appVisible: true, lastActivityAt: ago(181_000) }] }, now),
    ).toBe(false);
  });

  it("手机刚切到后台或锁屏不算在看，即便宿主仍判定为在场", () => {
    expect(
      isWatching({ userPresent: true, clients: [{ deviceType: "mobile", appVisible: false, lastActivityAt: ago(10_000) }] }, now),
    ).toBe(false);
  });

  it("桌面端窗口被其他窗口挡住时，三分钟内有操作仍算在看", () => {
    expect(
      isWatching({ userPresent: true, clients: [{ deviceType: "web", appVisible: false, lastActivityAt: ago(10_000) }] }, now),
    ).toBe(true);
    expect(
      isWatching({ userPresent: false, clients: [{ deviceType: "web", appVisible: false, lastActivityAt: ago(181_000) }] }, now),
    ).toBe(false);
  });

  it("多个 App 中任一满足即算在看", () => {
    expect(
      isWatching(
        {
          userPresent: true,
          clients: [
            { deviceType: "mobile", appVisible: false, lastActivityAt: ago(5_000) },
            { deviceType: "web", appVisible: true, lastActivityAt: ago(90_000) },
          ],
        },
        now,
      ),
    ).toBe(true);
  });

  it("没有连接的 App 时不算在看；时间戳无效时忽略该 App", () => {
    expect(isWatching({ userPresent: false, clients: [] }, now)).toBe(false);
    expect(
      isWatching({ userPresent: true, clients: [{ deviceType: "web", appVisible: true, lastActivityAt: null }] }, now),
    ).toBe(false);
  });

  it("宿主不提供客户端列表时沿用 userPresent", () => {
    expect(isWatching({ userPresent: true }, now)).toBe(true);
  });
});

describe("describeClients", () => {
  it("列出每个 App 的类型、可见性和上次操作距今多久", () => {
    expect(
      describeClients(
        {
          userPresent: false,
          clients: [
            { deviceType: "web", appVisible: false, lastActivityAt: ago(200_400) },
            { deviceType: "mobile", appVisible: true, lastActivityAt: null },
          ],
        },
        now,
      ),
    ).toEqual(["桌面/网页·隐藏·200 秒前有操作", "手机·可见·无操作记录"]);
  });
});
