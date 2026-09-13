import type { PluginServerContext } from "@getpaseo/plugin/server";
import { codeupServerProvider } from "./server/codeup";

export default function contribute(server: PluginServerContext) {
  server.addForgeServerProvider(codeupServerProvider);
  return () => {};
}
