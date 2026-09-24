import type { PluginTheme } from "@getpaseo/plugin";
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { resolveInProgressIntent, type InProgressIntent } from "../shared/board";
import { createId } from "../shared/ids";
import { validateSeedPrompt } from "../shared/limits";
import type { WorkItemView } from "./data";
import { PillSelect, PillStrip } from "./floating-menu";
import type { FollowUpResult } from "./follow-up";
import { MetaLine, Overlay, OverlayBox, useOverlay } from "./overlay";
import { IconAction, InlineNote, KEYS, MetaText, TextAction } from "./overlay-parts";
import type { TodoStyles } from "./styles";
import { DISPLAY_STATE_COLOR, DISPLAY_STATE_PRESENTATION, TEXT } from "./text";
import { CardTextArea } from "./work-item-editor";

export interface StartRequest {
  viewId: string;
  intent: Extract<InProgressIntent, { kind: "continue" | "permission" }>;
  /** True when confirming also moves the card into In progress. */
  move: boolean;
}

type Phase = { kind: "editing" } | { kind: "sending" } | { kind: "failed"; result: Exclude<FollowUpResult, { status: "sent" }> };

interface ContinueProps {
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
}

/**
 * A word to an agent that is waiting on you, or a pointer to one waiting for approval. The card's
 * live view is passed in on every render, so the box notices when the agent starts running again
 * before sending.
 */
export function ContinueBox(props: ContinueProps) {
  return (
    <Overlay theme={props.theme} open={props.request !== null && props.view !== null} onClose={props.onClose} variant="box">
      {/* The body mounts per opening, so its message ID and text start fresh every time. */}
      {props.request && props.view ? <ContinueBody {...props} request={props.request} view={props.view} /> : null}
    </Overlay>
  );
}

function agentLabel(view: WorkItemView, agentId: string): string {
  const link = view.links.find((entry) => entry.agentId === agentId);
  return link ? `${link.provider}${link.model ? ` · ${link.model}` : ""}` : agentId;
}

function ContinueBody(props: ContinueProps & { request: StartRequest; view: WorkItemView }) {
  const { styles, theme, request, view } = props;
  const { phone } = useOverlay();
  const initialAgentId = request.intent.kind === "permission" ? request.intent.agentId : (request.intent.agentIds[0] ?? "");
  const [agentId, setAgentId] = useState(initialAgentId);
  const [text, setText] = useState("");
  // One message ID per box: a retry after an unconfirmed send reuses it with the same text.
  const [messageId] = useState(() => createId("msg"));
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<TextInput | null>(null);

  const link = view.links.find((entry) => entry.agentId === agentId);
  const openAgent = props.onOpenAgent;
  const presentation = link ? DISPLAY_STATE_PRESENTATION[link.displayState] : null;

  if (request.intent.kind === "permission") {
    return (
      <OverlayBox
        size="narrow"
        accessibilityLabel={`#${view.item.number} needs approval`}
        meta={
          <MetaLine theme={theme}>
            <MetaText theme={theme} parts={[`#${view.item.number} needs approval`]} />
          </MetaLine>
        }
        footer={
          <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 12 }}>
            {request.move ? <TextAction theme={theme} label="Move only" kind="ghost" onPress={() => props.onMoveOnly(view)} /> : null}
            {openAgent ? <TextAction theme={theme} label={request.move ? "Move and open agent" : "Open agent"} icon="Bot" kind="accent" onPress={() => openAgent(view, agentId)} /> : null}
          </View>
        }
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", lineHeight: 21, paddingHorizontal: 2 }}>{view.item.title}</Text>
        <InlineNote theme={theme}>{TEXT.permissionNotice}</InlineNote>
      </OverlayBox>
    );
  }

  // Re-checked on every render from the live card: an agent that started running since the box
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

  const sendLabel = sending ? "Sending…" : request.move ? "Send and move" : "Send";
  return (
    <OverlayBox
      size="narrow"
      accessibilityLabel={`Continue #${view.item.number}`}
      scroll={false}
      meta={
        <MetaLine theme={theme}>
          <MetaText
            theme={theme}
            parts={[
              `Continue #${view.item.number}`,
              link && presentation ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors[DISPLAY_STATE_COLOR[link.displayState]] }} />
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{presentation.label}</Text>
                </View>
              ) : null,
            ]}
          />
        </MetaLine>
      }
    >
      <CardTextArea
        theme={theme}
        inputRef={inputRef}
        value={text}
        onChangeText={setText}
        placeholder="What should the agent do next?"
        accessibilityLabel="Message"
        autoFocus={!phone}
        editable={!locked}
        onSubmitKey={() => void send()}
      />
      {link?.displayState === "closed" ? <InlineNote theme={theme} kind="info">{TEXT.followUpReopenNotice}</InlineNote> : null}
      {!stillIdle && !failed ? <InlineNote theme={theme}>{nowRunning ? TEXT.followUpBusyNotice : TEXT.followUpUnreachableNotice}</InlineNote> : null}
      {locked && !sending ? <InlineNote theme={theme} kind="info">Locked after sending, so a retry sends exactly the same message.</InlineNote> : null}
      {failed?.status === "unknown" ? (
        <InlineNote
          theme={theme}
          trailing={
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <TextAction
                theme={theme}
                small
                label={checking ? "Checking…" : "Check status"}
                icon="RefreshCw"
                disabled={checking}
                onPress={() => {
                  setChecking(true);
                  void props.onCheck(view).finally(() => setChecking(false));
                }}
              />
              {!failed.replayRefused && stillIdle ? <TextAction theme={theme} small label="Retry the same message" icon="RotateCcw" onPress={() => void send()} /> : null}
            </View>
          }
        >
          {`Delivery not confirmed. ${failed.replayRefused ? TEXT.followUpReplayRefusedNotice : stillIdle ? TEXT.followUpUnknownNotice : nowRunning ? TEXT.followUpArrivedNotice : TEXT.followUpUnreachableNotice}`}
        </InlineNote>
      ) : null}
      {failed?.status === "conflict" ? <InlineNote theme={theme} kind="danger">{`Message ID already used. ${failed.message}`}</InlineNote> : null}
      {failed && failed.status !== "conflict" ? <Text style={[styles.mono, { marginTop: 6, marginHorizontal: 2 }]}>Paseo said: {failed.message}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
        <PillStrip theme={theme}>
          <PillSelect
            theme={theme}
            label="Agent"
            icon="Bot"
            text={agentLabel(view, agentId)}
            disabled={locked || candidates.length < 2}
            items={candidates.map((id) => {
              const entry = view.links.find((candidate) => candidate.agentId === id);
              return {
                key: id,
                label: agentLabel(view, id),
                ...(entry ? { hint: DISPLAY_STATE_PRESENTATION[entry.displayState].label } : {}),
                checked: id === agentId,
              };
            })}
            onSelect={setAgentId}
          />
        </PillStrip>
        {failed ? (
          openAgent ? <TextAction theme={theme} label="Open agent" icon="Bot" onPress={() => openAgent(view, agentId)} /> : null
        ) : (
          <>
            {request.move ? <TextAction theme={theme} label="Move only" kind="ghost" disabled={sending} onPress={() => props.onMoveOnly(view)} /> : null}
            <IconAction theme={theme} icon="Play" label="Start a new run instead" tip="Start a new run instead" kind="outline" disabled={sending} onPress={() => props.onExecuteInstead(view)} />
            <IconAction theme={theme} icon="Send" label={sendLabel} tip={sendLabel} keys={KEYS.submit} kind="round" disabled={sending || Boolean(invalid) || !stillIdle} onPress={() => void send()} />
          </>
        )}
      </View>
    </OverlayBox>
  );
}
