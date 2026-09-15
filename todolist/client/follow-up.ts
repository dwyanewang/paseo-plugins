import type { usePaseo } from "@getpaseo/plugin/client";

type PaseoApi = ReturnType<typeof usePaseo>;

export type FollowUpResult =
  | { status: "sent" }
  /** `replayRefused`: Paseo saw an earlier ambiguous send with this ID and will not replay it. */
  | { status: "unknown"; message: string; replayRefused: boolean }
  | { status: "conflict"; message: string };

/**
 * Sends one follow-up with a stable message ID. Paseo keeps a receipt per agent and message ID, so
 * resending the same text with the same ID never delivers twice, and after an ambiguous failure it
 * refuses to replay. Every failure is therefore reported as unknown, and the only retry the dialog
 * offers reuses both the ID and the text. The same ID with different text is a conflict.
 */
export async function sendFollowUp(input: {
  paseo: Pick<PaseoApi, "agents">;
  agentId: string;
  text: string;
  messageId: string;
}): Promise<FollowUpResult> {
  try {
    await input.paseo.agents.ref(input.agentId).send(input.text, { messageId: input.messageId });
    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "The message could not be confirmed.";
    if (message.includes("agent_request_key_conflict")) return { status: "conflict", message };
    return { status: "unknown", message, replayRefused: message.includes("agent_request_outcome_unknown") };
  }
}
