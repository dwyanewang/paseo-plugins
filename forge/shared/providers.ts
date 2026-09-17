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
    // No cloud hosts: probeHost only claims configured hosts that have a token.
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
