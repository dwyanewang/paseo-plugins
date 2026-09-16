import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { PlatformSchema } from "./settings";

const target = { platform: PlatformSchema, apiBaseUrl: z.string() };
export const tokenStatus = defineRpc({
  name: "credentials.status",
  input: z.object({}),
  output: z.object({ codeup: z.boolean(), gitee: z.boolean() }),
});
export const saveToken = defineRpc({
  name: "credentials.save",
  input: z.object({ ...target, token: z.string().trim().min(1).max(8192) }),
  output: z.object({ saved: z.literal(true) }),
});
export const deleteToken = defineRpc({
  name: "credentials.delete",
  input: z.object(target),
  output: z.object({ deleted: z.literal(true) }),
});
export const testConnection = defineRpc({
  name: "connection.test",
  input: z.object(target),
  output: z.object({ authenticated: z.boolean(), message: z.string() }),
});
