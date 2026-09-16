import type { PluginForgeMergeCapability } from "@getpaseo/plugin";
import { z } from "zod";

export const MergeFactsSchema = z.object({
  forge: z.enum(["forge-codeup", "forge-gitee"]),
  ready: z.boolean(),
  allowedMethods: z.array(z.enum(["merge", "squash", "rebase"])),
});
export function deriveMergeCapability(
  facts: z.infer<typeof MergeFactsSchema>
): PluginForgeMergeCapability {
  return {
    directMergeReady: facts.ready,
    allowedMethods: facts.allowedMethods,
    preferredMethod: null,
    canEnableAutoMerge: false,
    autoMergeEnabled: false,
    canDisableAutoMerge: false,
    mergeBlockedByQueue: false,
  };
}
