import type { PluginClientContext } from "@getpaseo/plugin/client";
import { codeupClientProvider } from "./client/codeup";

export default function contribute(client: PluginClientContext) {
  client.addForgeClientProvider(codeupClientProvider);
  return () => {};
}
