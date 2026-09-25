import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef } from "react";
import { Text, TextInput, View } from "react-native";
import type { WorkItem } from "../shared/schema";
import { useExecuteForm, type ExecuteSubmit } from "./execute-form";
import { PillSelect, PillStrip, WEB_TEXT_INPUT, type MenuItem } from "./floating-menu";
import { AttachmentStrip } from "./attachments";
import { refToDraftFile } from "./files";
import { NEW_WORKSPACE, NEW_WORKTREE } from "./launch-defaults";
import { LAUNCH_UPGRADE_NOTICE } from "./launch-guard";
import { MetaLine, Overlay, OverlayBox, useOverlay } from "./overlay";
import { CheckOption, IconAction, InlineNote, KEYS, MetaText, TextAction } from "./overlay-parts";
import type { ProjectRecord } from "./projects";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";
import { CardTextArea } from "./work-item-editor";

export type { ExecuteSubmit } from "./execute-form";

interface ExecuteBoxProps {
  styles: TodoStyles;
  theme: PluginTheme;
  item: WorkItem | null;
  /** The item's project: only git projects offer a new worktree, which is cut from its root. */
  project: ProjectRecord | undefined;
  defaultWorkspaceId: string | null;
  canOpenComposer: boolean;
  onClose: () => void;
  onSubmit: (input: ExecuteSubmit) => Promise<boolean>;
  /** Present when the box came from moving the card into In progress: move without running. */
  onMoveOnly?: () => void;
}

/**
 * Starting an agent on a card, built like the new-item box: this run's prompt on top, and one row
 * of choices under it (launch, workspace, model, mode, thinking) with the start button at its end.
 */
export function ExecuteBox(props: ExecuteBoxProps) {
  return (
    <Overlay theme={props.theme} open={props.item !== null} onClose={props.onClose} variant="box">
      {props.item ? <ExecuteBody {...props} item={props.item} /> : null}
    </Overlay>
  );
}

function ExecuteBody(props: ExecuteBoxProps & { item: WorkItem }) {
  const { styles, theme, item } = props;
  const { phone } = useOverlay();
  const inputRef = useRef<TextInput | null>(null);
  const form = useExecuteForm({
    item,
    project: props.project,
    defaultWorkspaceId: props.defaultWorkspaceId,
    canOpenComposer: props.canOpenComposer,
    onSubmit: props.onSubmit,
    onDone: props.onClose,
  });
  const run = form.effectiveMode === "run";
  const refocus = () => {
    if (!phone) inputRef.current?.focus();
  };

  const workspaceItems = useMemo<MenuItem[]>(
    () =>
      form.workspaceOptions.map((option) => ({
        key: option.value,
        label: option.label,
        icon: option.value === NEW_WORKTREE ? "GitBranchPlus" : option.value === NEW_WORKSPACE ? "FolderPlus" : "Folder",
        checked: option.value === form.effectiveTarget,
      })),
    [form.workspaceOptions, form.effectiveTarget],
  );
  const workspace = form.workspaceOptions.find((option) => option.value === form.effectiveTarget);
  const providers = form.catalog.providers;
  const providerLabel = (provider: string) => providers.find((entry) => entry.value === provider)?.label ?? provider;
  // One pill for provider and model: the menu groups models under their provider.
  const modelItems = useMemo<MenuItem[]>(
    () =>
      form.catalog.models.map((option) => ({
        key: option.value,
        label: option.modelLabel,
        section: providers.find((entry) => entry.value === option.provider)?.label ?? option.provider,
        checked: option.value === form.effectiveModel,
      })),
    [form.catalog.models, providers, form.effectiveModel],
  );
  const selectedModel = form.catalog.models.find((option) => option.value === form.effectiveModel);
  const modeLabel = form.modes.find((option) => option.value === form.effectiveModeId)?.label;
  const thinkingLabel = form.thinkingOptions.find((option) => option.value === form.effectiveThinkingOptionId)?.label;
  const images = form.images;
  const files = useMemo(() => item.files.map(refToDraftFile), [item.files]);

  return (
    <OverlayBox
      size="wide"
      accessibilityLabel={`Execute #${item.number}`}
      scroll={false}
      meta={
        <MetaLine theme={theme}>
          <MetaText
            theme={theme}
            parts={[
              `Execute #${item.number}`,
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0, flexShrink: 1 }}>
                <Icon name="Folder" size={12} color={theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                  {item.projectNameSnapshot}
                </Text>
              </View>,
            ]}
          />
        </MetaLine>
      }
    >
      <CardTextArea
        theme={theme}
        inputRef={inputRef}
        value={form.seedPrompt}
        onChangeText={form.setSeedPrompt}
        placeholder="What the agent should do"
        accessibilityLabel="Prompt for this attempt"
        autoFocus={!phone}
        editable={!form.busy}
        onSubmitKey={() => void form.submit()}
      />
      {images.length > 0 || files.length > 0 ? (
        <View style={{ marginTop: 4 }}>
          <AttachmentStrip styles={styles} theme={theme} images={images} files={files} size={phone ? 48 : 60} />
          <InlineNote theme={theme} kind="info">
            {attachmentNote(run, images.length, files.length)}
          </InlineNote>
        </View>
      ) : null}
      {form.edited ? <CheckOption theme={theme} label="Also save as the card's default prompt" value={form.updateDefault} onChange={form.setUpdateDefault} disabled={form.busy} /> : null}
      {form.newWorktree ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 10, marginHorizontal: 2 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Branch</Text>
          <SmallInput theme={theme} value={form.branchName} onChangeText={form.setBranchName} placeholder={form.generatedBranch} label="Branch" editable={!form.busy} grow />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>from</Text>
          <SmallInput theme={theme} value={form.baseBranch} onChangeText={form.setBaseBranch} placeholder="default branch" label="Base branch" editable={!form.busy} />
        </View>
      ) : null}
      {!props.canOpenComposer ? <InlineNote theme={theme} kind="info">{LAUNCH_UPGRADE_NOTICE}</InlineNote> : null}
      {form.workspaces.isError ? <InlineNote theme={theme}>Could not list workspaces for this project.</InlineNote> : null}
      {form.noWorkspace ? <InlineNote theme={theme}>{props.canOpenComposer ? TEXT.noWorkspaceForRun : TEXT.noWorkspaceAtAll}</InlineNote> : null}
      {form.noModel ? <InlineNote theme={theme}>{form.catalog.error ?? TEXT.noProviderForRun}</InlineNote> : null}
      {form.invalid ? <InlineNote theme={theme}>{form.invalid.reason === "empty" ? "Enter a prompt before launching." : "The prompt is too long."}</InlineNote> : null}
      {!run ? <InlineNote theme={theme} kind="info">{TEXT.composerModeHint}</InlineNote> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
        <PillStrip theme={theme}>
          {props.canOpenComposer ? (
            <PillSelect
              theme={theme}
              label="Launch"
              icon={run ? "Play" : "SquarePen"}
              text={run ? "Run now" : "In the composer"}
              disabled={form.busy}
              items={[
                { key: "run", label: "Run now", icon: "Play", checked: run },
                { key: "composer", label: "In the composer", icon: "SquarePen", checked: !run },
              ]}
              onSelect={(key) => form.setMode(key as "run" | "composer")}
              onClosed={refocus}
            />
          ) : null}
          {form.workspaceOptions.length > 0 ? (
            <PillSelect
              theme={theme}
              label="Workspace"
              icon={form.effectiveTarget === NEW_WORKTREE ? "GitBranchPlus" : form.effectiveTarget === NEW_WORKSPACE ? "FolderPlus" : "Folder"}
              text={workspace?.label ?? "Workspace"}
              disabled={form.busy}
              items={workspaceItems}
              onSelect={form.setTarget}
              {...(workspaceItems.length > 8 ? { filter: { placeholder: "Filter workspaces…", noun: "workspaces" } } : {})}
              onClosed={refocus}
            />
          ) : null}
          {run && form.catalog.models.length > 0 ? (
            <PillSelect
              theme={theme}
              label="Model"
              icon="Sparkles"
              text={selectedModel ? `${providerLabel(selectedModel.provider)} · ${selectedModel.modelLabel}` : "Model"}
              disabled={form.busy}
              items={modelItems}
              onSelect={form.setModel}
              filter={{ placeholder: "Filter models…", noun: "models" }}
              width={300}
              onClosed={refocus}
            />
          ) : null}
          {run && form.modes.length > 0 ? (
            <PillSelect
              theme={theme}
              label="Mode"
              icon="Shield"
              text={modeLabel ?? "Mode"}
              disabled={form.busy}
              items={form.modes.map((option) => ({ key: option.value, label: option.label, checked: option.value === form.effectiveModeId }))}
              onSelect={form.setModeId}
              onClosed={refocus}
            />
          ) : null}
          {run && form.thinkingOptions.length > 0 ? (
            <PillSelect
              theme={theme}
              label="Thinking"
              icon="Brain"
              text={thinkingLabel ?? "Thinking"}
              disabled={form.busy}
              items={form.thinkingOptions.map((option) => ({ key: option.value, label: option.label, checked: option.value === form.effectiveThinkingOptionId }))}
              onSelect={form.setThinkingOptionId}
              onClosed={refocus}
            />
          ) : null}
        </PillStrip>
        {props.onMoveOnly ? <TextAction theme={theme} label="Move only" kind="ghost" disabled={form.busy} onPress={props.onMoveOnly} /> : null}
        <IconAction
          theme={theme}
          icon={run ? "Play" : "SquareArrowOutUpRight"}
          label={run ? "Start agent" : "Open composer"}
          tip={form.busy ? "Starting…" : run ? "Start agent" : "Open composer"}
          keys={KEYS.submit}
          kind="round"
          disabled={form.blocked}
          onPress={() => void form.submit()}
        />
      </View>
    </OverlayBox>
  );
}

/** A one-line input inside a sentence, such as the branch of a new worktree. */
/** How the card's attachments reach the agent, which depends on where it starts. */
function attachmentNote(run: boolean, images: number, files: number): string {
  const count = (n: number, noun: string) => (n === 1 ? `the ${noun}` : `${n} ${noun}s`);
  if (!run) return "The composer takes text only, so the attachments' paths are added to the prompt.";
  const parts = [
    images > 0 ? `${images === 1 ? "The image is" : `${images} images are`} sent with the prompt, and saved as ${images === 1 ? "a file" : "files"} the agent can open again.` : null,
    files > 0 ? `The agent gets ${count(files, "file")} as ${files === 1 ? "a path" : "paths"} it can open.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}

function SmallInput(props: { theme: PluginTheme; value: string; onChangeText: (value: string) => void; placeholder: string; label: string; editable: boolean; grow?: boolean }) {
  const { theme } = props;
  return (
    <TextInput
      accessibilityLabel={props.label}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      editable={props.editable}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        {
          color: theme.colors.foreground,
          fontFamily: "monospace",
          fontSize: 12,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 7,
          backgroundColor: theme.colors.surface1,
          minWidth: 120,
        },
        props.grow ? { flexGrow: 1, flexBasis: 200 } : null,
        WEB_TEXT_INPUT,
      ]}
    />
  );
}
