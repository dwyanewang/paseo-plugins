import { useRpc, type usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback } from "react";
import { resolveFiles, stageImages, type HostFile } from "../shared/contracts";
import { appendAttachmentPaths } from "../shared/prompt";
import type { TodoFileRef, TodoImageRef, WorkItem } from "../shared/schema";
import type { ExecuteSubmit } from "./execute-form";
import { useTodoImageStore } from "./images";
import { executeWorkItem, type ExecuteResult } from "./launch";
import type { LaunchCapability } from "./launch-guard";
import { runWorkItemNow } from "./run";
import type { TodoActions } from "./use-todo-actions";

type PaseoApi = ReturnType<typeof usePaseo>;

/** Who started it, for the attempt record: device kind and host, as every client reports it. */
export function initiatorLabel(platform: string, hostLabel: string): string {
  const device = platform === "ios" ? "iPhone/iPad" : platform === "android" ? "Android" : "Desktop/Web";
  return `${device} · ${hostLabel}`.slice(0, 80);
}

export interface LaunchContext {
  paseo: PaseoApi;
  actions: TodoActions;
  incarnationId: string;
  reload: () => Promise<void>;
  initiatorLabel: string;
  capability: LaunchCapability;
  /** Opens the agent a direct run created; absent on hosts without navigation. */
  openAgent?: ((input: { agentId: string }) => void) | undefined;
}

/**
 * The one launch path every Todo surface uses: the board, the card panel, and the header panel.
 *
 * Keeping it in one place is not tidiness. Acquiring the claim, recording each request-start
 * before the request, and reading a lost reply as unknown are what stop one launch from becoming
 * two; a second copy of this flow would be a second set of those rules to get wrong.
 */
export function useLaunchWorkItem(context: LaunchContext): {
  launch: (item: WorkItem, input: ExecuteSubmit) => Promise<boolean>;
  describeResult: (result: ExecuteResult) => boolean;
} {
  const toast = useToast();
  const { paseo, actions, incarnationId, reload, capability } = context;
  const label = context.initiatorLabel;
  const openAgent = context.openAgent;
  const imageStore = useTodoImageStore();
  const stage = useRpc(stageImages);
  const locate = useRpc(resolveFiles);

  /**
   * A card's images, inline and as files on the daemon host. Files are best effort: without them
   * a direct run still sends the inline copy, and the composer opens with the text alone.
   */
  const prepareImages = useCallback(
    async (refs: readonly TodoImageRef[]) => {
      if (refs.length === 0) return { images: [], files: [] };
      const images = imageStore.resolve(refs).map((image) => ({ data: image.data, mimeType: image.mimeType }));
      let files: HostFile[] = [];
      try {
        const staged = await stage({ ids: refs.map((ref) => ref.id) });
        if (staged.status === "ok") files = staged.files;
      } catch {
        // An older server without the RPC, or a lost reply: fall through without files.
      }
      return { images, files };
    },
    [imageStore, stage],
  );

  /** Where a card's attached files are on the daemon host; files it cannot find are left out. */
  const prepareFiles = useCallback(
    async (refs: readonly TodoFileRef[]): Promise<HostFile[] | null> => {
      if (refs.length === 0) return [];
      try {
        const found = await locate({ ids: refs.map((ref) => ref.id) });
        if (found.status !== "ok") return null;
        const byId = new Map(found.files.map((file) => [file.id, file]));
        return refs.flatMap((ref) => {
          const file = byId.get(ref.id);
          return file ? [{ id: ref.id, fileName: ref.name, mimeType: ref.mimeType || "application/octet-stream", size: file.size, path: file.path }] : [];
        });
      } catch {
        return null;
      }
    },
    [locate],
  );

  const describeResult = useCallback(
    (result: ExecuteResult) => {
      if (result.status === "error") return false;
      if (result.status === "unknown") return false;
      if (result.status === "rejected") {
        const code = result.open.code;
        toast.error(
          code === "wrong_device"
            ? "This launch draft belongs to another device. Check status or abandon it there."
            : code === "journal_invalid"
              ? "The local launch journal is invalid. Clear it from the workspace draft before retrying."
              : code === "launch_key_conflict"
                ? "This launch identity was already used with different inputs."
                : result.open.message,
        );
        return false;
      }
      if (result.status === "completed") {
        toast.show(
          result.open.terminalOutcome === "agent_known" ? "This launch already created an agent." : "This launch was discarded.",
          { variant: "info" },
        );
      }
      return true;
    },
    [toast],
  );

  const launch = useCallback(
    async (item: WorkItem, input: ExecuteSubmit): Promise<boolean> => {
      let target = item;
      if (input.updateDefaultPrompt) {
        const ok = await actions.update(target, { defaultPrompt: input.seedPrompt });
        if (!ok) return false;
        target = { ...target, defaultPrompt: input.seedPrompt, version: target.version + 1 };
      }
      const shared = {
        item: target,
        incarnationId,
        seedPrompt: input.seedPrompt,
        seedPromptSource: input.seedPromptSource,
        initiatorLabel: label,
        rpcs: actions.launchRpcs,
        onChange: () => void reload(),
      };
      const { images, files } = await prepareImages(target.images);
      const attached = (await prepareFiles(target.files)) ?? [];
      const lost = target.files.length - attached.length;
      if (lost > 0) {
        toast.error(lost === 1 ? "A file on this card could not be found on the host; the agent starts without it." : `${lost} files on this card could not be found on the host; the agent starts without them.`);
      }
      const hostFiles = [...files, ...attached];
      if (input.mode === "run") {
        const result = await runWorkItemNow({
          ...shared,
          paseo,
          target: input.target,
          config: input.config,
          ...(images.length > 0 ? { images } : {}),
          ...(hostFiles.length > 0 ? { files: hostFiles } : {}),
        });
        await reload();
        if (result.status === "error") {
          toast.error(
            result.certainty === "claim_unknown"
              ? `${result.message} Nothing was started. Reload, then check the item before trying again.`
              : result.message,
          );
          return false;
        }
        toast.show("Agent started.", { variant: "success" });
        openAgent?.({ agentId: result.agentId });
        return true;
      }
      if (!capability.available) return false;
      if (target.images.length > 0 && files.length === 0) {
        toast.error("The card's images could not be prepared, so the composer opens without them.");
      }
      const result = await executeWorkItem({
        ...shared,
        seedPrompt: appendAttachmentPaths(input.seedPrompt, { images: files, files: attached }),
        target: input.target,
        openAgentLaunch: capability.openAgentLaunch,
      });
      if (result.status === "unknown") {
        toast.error(`${result.message} Nothing was opened. Reload, then check the item before trying again.`);
        await reload();
        return false;
      }
      if (result.status === "error") {
        toast.error(result.error.message);
        await reload();
        return false;
      }
      return describeResult(result);
    },
    [actions, capability, describeResult, incarnationId, label, openAgent, paseo, prepareFiles, prepareImages, reload, toast],
  );

  return { launch, describeResult };
}
