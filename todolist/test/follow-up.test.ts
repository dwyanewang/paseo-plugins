import { describe, expect, it, vi } from "vitest";
import { sendFollowUp } from "../client/follow-up";

function paseoWith(send: ReturnType<typeof vi.fn>) {
  const ref = vi.fn().mockReturnValue({ send });
  return { paseo: { agents: { ref } } as unknown as Parameters<typeof sendFollowUp>[0]["paseo"], ref };
}

describe("follow-up messages", () => {
  it("sends the text to the chosen agent with the dialog's stable message ID", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { paseo, ref } = paseoWith(send);
    await expect(sendFollowUp({ paseo, agentId: "agent-1", text: "Keep going", messageId: "msg_1" })).resolves.toEqual({ status: "sent" });
    expect(ref).toHaveBeenCalledWith("agent-1");
    expect(send).toHaveBeenCalledExactlyOnceWith("Keep going", { messageId: "msg_1" });
  });

  it("reports any failure as unknown and never retries on its own", async () => {
    const send = vi.fn().mockRejectedValue(new Error("socket closed"));
    const { paseo } = paseoWith(send);
    await expect(sendFollowUp({ paseo, agentId: "agent-1", text: "Keep going", messageId: "msg_1" })).resolves.toEqual({
      status: "unknown",
      message: "socket closed",
      replayRefused: false,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("recognises Paseo refusing to replay an ambiguous send, and an ID reused with other text", async () => {
    const refused = paseoWith(vi.fn().mockRejectedValue(new Error("agent_request_outcome_unknown")));
    await expect(sendFollowUp({ paseo: refused.paseo, agentId: "a", text: "t", messageId: "m" })).resolves.toMatchObject({ status: "unknown", replayRefused: true });
    const conflict = paseoWith(vi.fn().mockRejectedValue(new Error("agent_request_key_conflict")));
    await expect(sendFollowUp({ paseo: conflict.paseo, agentId: "a", text: "t", messageId: "m" })).resolves.toMatchObject({ status: "conflict" });
  });
});
