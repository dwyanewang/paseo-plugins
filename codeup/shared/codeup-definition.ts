import type { PluginForgeDefinition } from "@getpaseo/plugin";

export const codeupDefinition = {
  id: "codeup",
  displayName: "Codeup",
  changeRequestAbbrev: "MR",
  changeRequestNoun: "merge request",
  changeRequestNumberPrefix: "!",
  issueNumberPrefix: "#",
  signIn: { cli: "aliyun", command: "aliyun configure" },
  cloudHosts: ["codeup.aliyun.com"],
} satisfies PluginForgeDefinition;
