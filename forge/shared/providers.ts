import type { PluginForgeDefinition } from "@getpaseo/plugin";
import type { Platform } from "./settings";

export const definitions = {
  codeup: {
    id: "forge-codeup",
    displayName: "Codeup",
    changeRequestAbbrev: "MR",
    changeRequestNoun: "merge request",
    changeRequestNumberPrefix: "!",
    issueNumberPrefix: "#",
    signIn: null,
    // Resolve configured hosts through probeHost. This allows the legacy Codeup
    // plugin to remain installed without creating an ambiguous cloud-host match.
  },
  gitee: {
    id: "forge-gitee",
    displayName: "Gitee",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    changeRequestNumberPrefix: "!",
    issueNumberPrefix: "#",
    signIn: null,
    cloudHosts: ["gitee.com"],
  },
} as const satisfies Record<Platform, PluginForgeDefinition>;
