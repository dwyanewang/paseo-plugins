import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { resolveInProgressIntent, type InProgressIntent } from "../shared/board";
import { createId } from "../shared/ids";
import { validateSeedPrompt } from "../shared/limits";
import { Button, DialogActions, Field, Notice } from "./components";
import type { WorkItemView } from "./data";
import type { FollowUpResult } from "./follow-up";
import type { TodoStyles } from "./styles";
import { DISPLAY_STATE_PRESENTATION, TEXT } from "./text";

export interface StartRequest {
  viewId: string;
  intent: Extract<InProgressIntent, { kind: "continue" | "permission" }>;
  /** True when confirming also moves the card into In progress. */
  move: boolean;
}

type Phase = { kind: "editing" } | { kind: "sending" } | { kind: "failed"; result: Exclude<FollowUpResult, { status: "sent" }> };

/**
 * Continue an agent, or send the user to one waiting for approval. The card's live view is passed
 * in on every render, so the dialog notices when the agent starts running again before sending.
 */
export function ContinueModal(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  request: StartRequest | null;
  view: WorkItemView | null;
  onClose: () => void;
  onMoveOnly: (view: WorkItemView) => void;
  onOpenAgent: ((view: WorkItemView, agentId: string) => void) | null;
  onExecuteInstead: (view: WorkItemView) => void;
  onSend: (input: { view: WorkItemView; agentId: string; text: string; messageId: string }) => Promise<FollowUpResult | null>;
  onCheck: (view: WorkItemView) => Promise<void>;
}) {
  const { request, view } = props;
  const item = view?.item;
  const title = !item || !request ? "Continue" : request.intent.kind === "permission" ? `#${item.number} needs approval` : `Continue #${item.number}`;
  return (
    <Modal title={title} open={request !== null && view !== null} onOpenChange={(next) => !next && props.onClose()}>
      <Modal.Content>
        {/* The body mounts per opening, so its message ID and text start fresh every time. */}
        {request && view ? <ContinueBody {...props} request={request} view={view} /> : null}
      </Modal.Content>
    </Modal>
  );
}

function ContinueBody(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  request: StartRequest;
  view: WorkItemView;
  onClose: () => void;
  onMoveOnly: (view: WorkItemView) => void;
  onOpenAgent: ((view: WorkItemView, agentId: string) => void) | null;
  onExecuteInstead: (view: WorkItemView) => void;
  onSend: (input: { view: WorkItemView; agentId: string; text: string; messageId: string }) => Promise<FollowUpResult | null>;
  onCheck: (view: WorkItemView) => Promise<void>;
}) {
  const { styles, theme, request, view } = props;
  const initialAgentId = request.intent.kind === "permission" ? request.intent.agentId : (request.intent.agentIds[0] ?? "");
  const [agentId, setAgentId] = useState(initialAgentId);
  const [text, setText] = useState("");
  // One message ID per dialog: a retry after an unconfirmed send reuses it with the same text.
  const [messageId] = useState(() => createId("msg"));
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [checking, setChecking] = useState(false);

  const link = view.links.find((entry) => entry.agentId === agentId);
  const openAgent = props.onOpenAgent;

  if (request.intent.kind === "permission") {
    return (
      <>
        <Text style={styles.detailTitle}>{view.item.title}</Text>
        <Notice styles={styles} theme={theme} kind="warning">{TEXT.permissionNotice}</Notice>
        <DialogActions styles={styles}>
          <Button styles={styles} theme={theme} label="Cancel" onPress={props.onClose} />
          {request.move ? <Button styles={styles} theme={theme} label="Move only" onPress={() => props.onMoveOnly(view)} /> : null}
          {openAgent ? (
            <Button styles={styles} theme={theme} label={request.move ? "Move and open agent" : "Open agent"} icon="Bot" variant="primary" onPress={() => openAgent(view, agentId)} />
          ) : null}
        </DialogActions>
      </>
    );
  }

  // Re-checked on every render from the live card: an agent that started running since the dialog
  // opened must not receive a message, which would interrupt its turn.
  const live = resolveInProgressIntent(view);
  const stillIdle = live.kind === "continue" && live.agentIds.includes(agentId);
  // Not idle either because it runs (a message likely arrived) or because Todo lost track of it.
  const nowRunning = !stillIdle && (link?.displayState === "running" || link?.displayState === "initializing" || live.kind === "move_only");
  const candidates = live.kind === "continue" ? live.agentIds : request.intent.agentIds;
  const invalid = validateSeedPrompt(text);
  const failed = phase.kind === "failed" ? phase.result : null;
  const sending = phase.kind === "sending";
  const locked = phase.kind !== "editing";

  async function send() {
    if (invalid || !stillIdle) return;
    setPhase({ kind: "sending" });
    const result = await props.onSend({ view, agentId, text, messageId });
    if (result === null) setPhase({ kind: "editing" });
    else if (result.status !== "sent") setPhase({ kind: "failed", result });
  }

  const presentation = link ? DISPLAY_STATE_PRESENTATION[link.displayState] : null;
  return (
    <>
      <Text style={styles.detailTitle}>{view.item.title}</Text>
      {candidates.length > 1 ? (
        <SettingsSelect
          label="Agent"
          value={agentId}
          options={candidates.map((id) => {
            const entry = view.links.find((candidate) => candidate.agentId === id);
            return { value: id, label: entry ? `${entry.provider}${entry.model ? ` · ${entry.model}` : ""} · ${DISPLAY_STATE_PRESENTATION[entry.displayState].label}` : id };
          })}
          onValueChange={setAgentId}
          disabled={locked}
        />
      ) : null}
      {link && presentation ? (
        <Text style={styles.mono}>
          {link.provider}
          {link.model ? ` · ${link.model}` : ""} · {presentation.label}
        </Text>
      ) : null}
      {link?.displayState === "closed" ? <Notice styles={styles} theme={theme}>{TEXT.followUpReopenNotice}</Notice> : null}
      {!stillIdle && !failed ? (
        <Notice styles={styles} theme={theme} kind="warning">{nowRunning ? TEXT.followUpBusyNotice : TEXT.followUpUnreachableNotice}</Notice>
      ) : null}
      <Field
        styles={styles}
        theme={theme}
        label="Message"
        value={text}
        onChangeText={setText}
        multiline
        editable={!locked}
        placeholder="What should the agent do next?"
        {...(locked ? { hint: "Locked after sending, so a retry sends exactly the same message." } : {})}
      />
      {failed?.status === "unknown" ? (
        <Notice styles={styles} theme={theme} kind="warning" title="Delivery not confirmed">
          {failed.replayRefused
            ? TEXT.followUpReplayRefusedNotice
            : stillIdle
              ? TEXT.followUpUnknownNotice
              : nowRunning
                ? TEXT.followUpArrivedNotice
                : TEXT.followUpUnreachableNotice}
        </Notice>
      ) : null}
      {failed ? <Text style={styles.mono}>Paseo said: {failed.message}</Text> : null}
      {failed?.status === "conflict" ? (
        <Notice styles={styles} theme={theme} kind="danger" title="Message ID already used">{failed.message}</Notice>
      ) : null}
      <Text style={styles.mono}>{TEXT.followUpNotice}</Text>
      {failed ? (
        <DialogActions styles={styles}>
          <Button styles={styles} theme={theme} label="Close" onPress={props.onClose} />
          <Button
            styles={styles}
            theme={theme}
            label={checking ? "Checking…" : "Check status"}
            icon="RefreshCw"
            disabled={checking}
            onPress={() => {
              setChecking(true);
              void props.onCheck(view).finally(() => setChecking(false));
            }}
          />
          {openAgent ? <Button styles={styles} theme={theme} label="Open agent" icon="Bot" onPress={() => openAgent(view, agentId)} /> : null}
          {failed.status === "unknown" && !failed.replayRefused && stillIdle ? (
            <Button styles={styles} theme={theme} label="Retry the same message" icon="RotateCcw" variant="primary" onPress={() => void send()} />
          ) : null}
        </DialogActions>
      ) : (
        <DialogActions styles={styles}>
          <Button styles={styles} theme={theme} label="Cancel" disabled={sending} onPress={props.onClose} />
          <Button styles={styles} theme={theme} label="Start a new run instead" icon="Play" disabled={sending} onPress={() => props.onExecuteInstead(view)} />
          {request.move ? <Button styles={styles} theme={theme} label="Move only" disabled={sending} onPress={() => props.onMoveOnly(view)} /> : null}
          <Button
            styles={styles}
            theme={theme}
            label={sending ? "Sending…" : request.move ? "Send and move" : "Send"}
            icon="Send"
            variant="primary"
            disabled={sending || Boolean(invalid) || !stillIdle}
            onPress={() => void send()}
          />
        </DialogActions>
      )}
    </>
  );
}
