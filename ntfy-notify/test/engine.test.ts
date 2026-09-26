import { describe, expect, it } from "vitest";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { NotificationEngine } from "../server/engine";
import { formatMerged } from "../server/format";
import type { Clock, NotificationWorkspace, RuntimeInspection } from "../server/types";

class TestClock implements Clock {
  time = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void; interval?: number }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => this.tasks.delete(handle as number);
  setInterval = (callback: () => void, interval: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + interval, callback, interval });
    return id;
  };
  clearInterval = (handle: unknown) => this.tasks.delete(handle as number);
  pendingCount() {
    return this.tasks.size;
  }
  async advance(delay: number) {
    const target = this.time + delay;
    while (true) {
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      const [id, task] = next;
      if (task.interval !== undefined) task.at += task.interval;
      else this.tasks.delete(id);
      task.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

const workspace: NotificationWorkspace = {
  id: "ws-1",
  projectDisplayName: "演示项目",
  projectKind: "git",
  name: "feature/demo",
  branch: "feature/demo",
  status: "done",
};

function agent(id: string, parentAgentId: string | null = null, provider = "claude"): PluginHookAgent {
  return {
    id,
    workspaceId: "ws-1",
    parentAgentId,
    provider,
    cwd: "/tmp/demo",
    title: null,
  };
}

function setup(
  initial: RuntimeInspection = { workspace, agents: [] },
  isUserPresent?: () => Promise<boolean>,
) {
  const clock = new TestClock();
  const sent: string[] = [];
  const bodies: string[] = [];
  const cards: (typeof undefined | import("../shared/card").CardDocument)[] = [];
  const logs: string[] = [];
  let inspection = initial;
  const engine = new NotificationEngine({
    clock,
    sender: {
      send: async (message) => (
        sent.push(message.summary), bodies.push(message.body), cards.push(message.card), "message-id"
      ),
    },
    inspect: async () => inspection,
    ...(isUserPresent ? { isUserPresent } : {}),
    log: (message) => logs.push(message),
  });
  return { clock, sent, bodies, cards, logs, engine, setInspection: (next: RuntimeInspection) => (inspection = next) };
}

async function finishLongTurn(clock: TestClock, engine: NotificationEngine) {
  const current = agent("a");
  engine.onTurnStarted(current);
  await clock.advance(60_000);
  engine.onTurnEnded({ agent: current, turnId: "t", outcome: { kind: "completed" } });
  await clock.advance(1);
  await clock.advance(5_000);
  // The flush awaits presence before sending; let that chain settle.
  await new Promise((resolve) => setImmediate(resolve));
}

describe("NotificationEngine", () => {
  it("跳过子 agent，并在取消时清掉挂起任务", async () => {
    const { clock, sent, engine } = setup();
    const child = agent("child", "parent");
    engine.onTurnStarted(child);
    engine.onPermissionRequested({ agent: child, request: { id: "p1", name: "Bash", provider: "claude", kind: "tool" } });
    engine.onTurnEnded({ agent: child, turnId: "t", outcome: { kind: "completed" } });
    await clock.advance(30_000);
    expect(sent).toEqual([]);
    const parent = agent("parent");
    engine.onTurnStarted(parent);
    engine.onPermissionRequested({ agent: parent, request: { id: "p2", name: "Bash", provider: "claude", kind: "tool" } });
    engine.onTurnEnded({ agent: parent, turnId: "t", outcome: { kind: "canceled", reason: "user" } });
    await clock.advance(30_000);
    expect(sent).toEqual([]);
  });

  it("完成邮件正文带本轮指令和回复", async () => {
    const { clock, sent, bodies, cards, engine } = setup();
    const current = { ...agent("a"), title: "登录修复" };
    engine.onTurnStarted(current);
    await clock.advance(60_000);
    engine.onTurnEnded({
      agent: current,
      turnId: "t",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "修复登录超时" },
        { type: "assistant_message", text: "已修复" },
      ],
    });
    await clock.advance(1);
    await clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual(["✅ 演示项目 · feature/demo · Claude 完成 · 1 分钟 · 本分支已全部结束"]);
    expect(bodies[0]).toContain("Agent：登录修复");
    expect(bodies[0]).toContain("【你的指令】\n修复登录超时");
    expect(bodies[0]).toContain("【Agent 回复】\n已修复");
    expect(cards[0]?.version).toBe(1);
    expect(cards[0]?.blocks.some((block) => block.type === "status")).toBe(true);
    expect(JSON.stringify(cards[0])).toContain("修复登录超时");
  });

  it("不到一分钟的完成也推送，耗时按秒显示", async () => {
    const { clock, sent, engine } = setup();
    const current = agent("a");
    engine.onTurnStarted(current);
    await clock.advance(35_000);
    engine.onTurnEnded({ agent: current, turnId: "t", outcome: { kind: "completed" } });
    await clock.advance(1);
    await clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual(["✅ 演示项目 · feature/demo · Claude 完成 · 35 秒 · 本分支已全部结束"]);
  });

  it("插件加载前就开始的一轮不写耗时", async () => {
    const { clock, sent, engine } = setup();
    engine.onTurnEnded({ agent: agent("a"), turnId: "t", outcome: { kind: "completed" } });
    await clock.advance(1);
    await clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual(["✅ 演示项目 · feature/demo · Claude 完成 · 本分支已全部结束"]);
  });

  it("新的一轮重新计时，被后台结果唤醒的一轮继续累计", async () => {
    const { clock, sent, engine, setInspection } = setup();
    const current = agent("a");
    engine.onTurnStarted(current);
    await clock.advance(120_000);
    engine.onTurnEnded({ agent: current, turnId: "1", outcome: { kind: "completed" } });
    await clock.advance(1);
    await clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent[0]).toContain("完成 · 2 分钟");

    // A fresh prompt: timed from its own start, not from the first turn.
    engine.onTurnStarted(current);
    await clock.advance(10_000);
    setInspection({ workspace: { ...workspace, status: "running" }, agents: [] });
    engine.onTurnEnded({ agent: current, turnId: "2", outcome: { kind: "completed" } });
    await clock.advance(1);
    expect(sent).toHaveLength(1);

    // Background work woke the agent: the task keeps its original start.
    await clock.advance(50_000);
    engine.onTurnStarted(current);
    setInspection({ workspace, agents: [] });
    engine.onTurnEnded({ agent: current, turnId: "3", outcome: { kind: "completed" } });
    await clock.advance(1);
    await clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent[1]).toContain("完成 · 1 分钟");
  });

  it("限额提示当作失败上报，即使宿主报告正常完成", async () => {
    const { clock, sent, bodies, engine } = setup();
    const current = { ...agent("a"), title: "谷歌商店下载" };
    engine.onTurnStarted(current);
    await clock.advance(300_000);
    engine.onTurnEnded({
      agent: current,
      turnId: "t",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "ntfy配置好后，每次新打开都会这样，我是从谷歌商店中下载的" },
        { type: "assistant_message", text: "You've hit your weekly limit · resets Sep 27, 5am (Asia/Shanghai)" },
      ],
    });
    await clock.advance(1);
    await clock.advance(5_000);
    expect(sent[0]).toContain("❌");
    expect(sent[0]).toContain("失败 · 5 分钟");
    expect(sent[0]).not.toContain("✅");
    expect(bodies[0]).toContain("【错误】\nYou've hit your weekly limit");
    expect(bodies[0]).toContain("【你的指令】");
  });

  it("失败通知带错误第一行且截断到 60 字", async () => {
    const { clock, sent, engine } = setup();
    const current = agent("a");
    engine.onTurnStarted(current);
    await clock.advance(60_000);
    engine.onTurnEnded({
      agent: current,
      turnId: "t",
      outcome: { kind: "failed", error: { message: `${"x".repeat(80)}\nsecret` } },
    });
    await clock.advance(1);
    await clock.advance(5_000);
    expect(sent[0]).toContain("❌ 演示项目 · feature/demo · Claude 失败 · 1 分钟");
    expect(sent[0]).toContain(`   ${"x".repeat(59)}…`);
    expect(sent[0]).not.toContain("secret");
  });

  it("权限请求延迟 20 秒，期间解决则取消", async () => {
    const first = setup();
    const current = agent("a");
    first.engine.onPermissionRequested({ agent: current, request: { id: "p1", name: "Bash", provider: "claude", kind: "tool" } });
    await first.clock.advance(19_999);
    expect(first.sent).toEqual([]);
    first.engine.onPermissionResolved("p1");
    await first.clock.advance(2_000);
    expect(first.sent).toEqual([]);

    const second = setup();
    second.engine.onPermissionRequested({ agent: current, request: { id: "p2", name: "Bash", provider: "claude", kind: "tool" } });
    await second.clock.advance(25_000);
    expect(second.sent[0]).toBe("⏸ 演示项目 · feature/demo · 等待批准：Bash");
  });

  it("取消会移除已经排队但尚未发送的通知", async () => {
    const { clock, sent, engine } = setup();
    const current = agent("a");
    engine.onPermissionRequested({ agent: current, request: { id: "p1", name: "Bash", provider: "claude", kind: "tool" } });
    await clock.advance(20_000);
    engine.onTurnEnded({ agent: current, turnId: "t", outcome: { kind: "canceled", reason: "user" } });
    await clock.advance(5_000);
    expect(sent).toEqual([]);
  });

  it("5 秒合并窗口内同工作区完成合并为 N 个完成", async () => {
    const { clock, sent, engine } = setup();
    const first = agent("a");
    const second = agent("b", null, "codex");
    engine.onTurnStarted(first);
    engine.onTurnStarted(second);
    await clock.advance(60_000);
    engine.onTurnEnded({ agent: first, turnId: "a", outcome: { kind: "completed" } });
    engine.onTurnEnded({ agent: second, turnId: "b", outcome: { kind: "completed" } });
    await clock.advance(1);
    await clock.advance(5_000);
    expect(sent).toEqual(["✅ 演示项目 · feature/demo · 2 个完成"]);
  });

  it("后台工作结束后等待唤醒宽限再推送完成", async () => {
    const parent = agent("parent");
    const child = { id: "child", workspaceId: "ws-1", status: "running", labels: { "paseo.parent-agent-id": "parent" } };
    const state = setup({ workspace, agents: [child] });
    state.engine.onTurnStarted(parent);
    await state.clock.advance(60_000);
    state.engine.onTurnEnded({ agent: parent, turnId: "t", outcome: { kind: "completed" } });
    await state.clock.advance(1);
    expect(state.sent).toEqual([]);
    state.setInspection({ workspace: { ...workspace, status: "done" }, agents: [{ ...child, status: "done" }] });
    await state.clock.advance(60_000);
    expect(state.sent).toEqual([]);
    await state.clock.advance(30_000);
    await state.clock.advance(1);
    await state.clock.advance(5_000);
    expect(state.sent[0]).toContain("Claude 完成");
    state.engine.dispose();
    expect(state.clock.pendingCount()).toBe(0);
  });

  it("收到实时更新后立刻复查，不等轮询间隔", async () => {
    const parent = agent("parent");
    const child = { id: "child", workspaceId: "ws-1", status: "running", labels: { "paseo.parent-agent-id": "parent" } };
    const state = setup({ workspace, agents: [child] });
    state.engine.setRecheckInterval(300_000);
    state.engine.onTurnStarted(parent);
    state.engine.onTurnEnded({ agent: parent, turnId: "t", outcome: { kind: "completed" } });
    await state.clock.advance(1);
    state.engine.nudge();
    await state.clock.advance(1_000);
    expect(state.sent).toEqual([]);

    state.setInspection({ workspace, agents: [{ ...child, status: "idle" }] });
    state.engine.nudge();
    state.engine.nudge();
    await state.clock.advance(1_000);
    await state.clock.advance(30_000);
    await state.clock.advance(1);
    await state.clock.advance(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.sent[0]).toContain("Claude 完成");
    state.engine.dispose();
    expect(state.clock.pendingCount()).toBe(0);
  });

  it("没有在等后台工作时，实时更新不做任何事", () => {
    const state = setup();
    state.engine.nudge();
    expect(state.clock.pendingCount()).toBe(0);
  });

  it("工作区仍为 running 且没有任何 Paseo agent running 时视为后台工作", async () => {
    const current = agent("parent");
    const state = setup({ workspace: { ...workspace, status: "running" }, agents: [] });
    state.engine.onTurnStarted(current);
    await state.clock.advance(60_000);
    state.engine.onTurnEnded({ agent: current, turnId: "t", outcome: { kind: "completed" } });
    await state.clock.advance(60_000);
    expect(state.sent).toEqual([]);
    state.setInspection({ workspace: { ...workspace, status: "done" }, agents: [] });
    await state.clock.advance(60_000);
    await state.clock.advance(30_000);
    await state.clock.advance(1);
    await state.clock.advance(5_000);
    expect(state.sent[0]).toContain("本分支已全部结束");
  });

  it("用户正在使用 Paseo 时跳过，离开后照常推送", async () => {
    let present = true;
    const { clock, sent, logs, engine } = setup(undefined, async () => present);
    await finishLongTurn(clock, engine);
    expect(sent).toEqual([]);
    expect(logs).toContain("用户正在使用 Paseo，跳过 ntfy 通知");

    present = false;
    await finishLongTurn(clock, engine);
    expect(sent).toHaveLength(1);
  });

  it("读取在场状态失败时照常推送", async () => {
    const { clock, sent, logs, engine } = setup(undefined, async () => {
      throw new Error("presence unavailable");
    });
    await finishLongTurn(clock, engine);
    expect(sent).toHaveLength(1);
    expect(logs).toContain("读取在场状态失败，照常发送");
  });

  it("消息格式支持小时耗时与分支已结束", () => {
    expect(formatMerged([{ kind: "completed", agentId: "a", workspaceId: "ws-1", workspace, provider: "opencode", durationMs: 3_720_000, runningRootCount: 0 }])).toBe(
      "✅ 演示项目 · feature/demo · OpenCode 完成 · 1 小时 2 分钟 · 本分支已全部结束",
    );
  });

  it("非 git 工作区使用工作区名称作为分支标签", () => {
    const nonGit = { ...workspace, projectKind: "non_git", name: "本地目录", branch: null };
    expect(formatMerged([
      { kind: "completed", agentId: "a", workspaceId: "ws-1", workspace: nonGit, provider: "claude", durationMs: 60_000, runningRootCount: 0 },
    ])).toBe("✅ 演示项目 · 本地目录 · Claude 完成 · 1 分钟 · 本分支已全部结束");
  });

  it("不同工作区的完成通知不合并", () => {
    const other = { ...workspace, id: "ws-2", projectDisplayName: "另一个项目", name: "feature/other", branch: "feature/other" };
    expect(formatMerged([
      { kind: "completed", agentId: "a", workspaceId: "ws-1", workspace, provider: "claude", durationMs: 60_000, runningRootCount: 0 },
      { kind: "completed", agentId: "b", workspaceId: "ws-2", workspace: other, provider: "codex", durationMs: 60_000, runningRootCount: 0 },
    ])).toBe([
      "✅ 演示项目 · feature/demo · Claude 完成 · 1 分钟 · 本分支已全部结束",
      "✅ 另一个项目 · feature/other · Codex 完成 · 1 分钟 · 本分支已全部结束",
    ].join("\n"));
  });
});
