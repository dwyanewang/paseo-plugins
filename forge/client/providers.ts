import {
  defineForgeClientProvider,
  defineForgeFacts,
  GITHUB_LINE_ANCHOR,
} from "@getpaseo/plugin";
import { definitions } from "../shared/providers";
import { MergeFactsSchema, deriveMergeCapability } from "../shared/facts";
import { platforms } from "../shared/settings";

export const clientProviders = platforms.map((platform) =>
  defineForgeClientProvider({
    definition: definitions[platform],
    facts: defineForgeFacts({
      family: definitions[platform].id,
      schema: MergeFactsSchema,
      deriveMergeCapability,
    }),
    setup: { screenId: "connections" },
    ...(platform === "gitee"
      ? {
          urlGrammar: {
            treeInfix: "/tree/",
            blobInfix: "/blob/",
            lineAnchor: GITHUB_LINE_ANCHOR,
            // Issue references are intentionally absent: Gitee uses alphanumeric IDs.
            referencePaths: [
              { kind: "change_request" as const, infix: "/pulls/" },
            ],
          },
        }
      : {}),
  })
);
