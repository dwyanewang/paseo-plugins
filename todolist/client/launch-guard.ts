import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Navigation = NonNullable<PluginSurfaceProps["navigation"]>;
export type OpenAgentLaunch = NonNullable<Navigation["openAgentLaunch"]>;

export type LaunchCapability =
  | { available: true; openAgentLaunch: OpenAgentLaunch }
  | { available: false; reason: "navigation_missing" | "launch_missing" };

/**
 * Runtime guard for partial deployments: a host whose version satisfies the manifest but whose
 * client predates `openAgentLaunch` gets an upgrade notice before any claim is written.
 */
export function resolveLaunchCapability(navigation: Navigation | undefined): LaunchCapability {
  if (!navigation) return { available: false, reason: "navigation_missing" };
  if (typeof navigation.openAgentLaunch !== "function") {
    return { available: false, reason: "launch_missing" };
  }
  return { available: true, openAgentLaunch: navigation.openAgentLaunch };
}

export const LAUNCH_UPGRADE_NOTICE =
  "This Paseo app cannot hand a Todo launch to the native composer. Todo starts the agent itself instead; update the app to get the composer option back.";
