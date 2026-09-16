import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PlatformSchema = z.enum(["codeup", "gitee"]);
export type Platform = z.infer<typeof PlatformSchema>;
export const platforms: Platform[] = ["codeup", "gitee"];

// Validated again on the server. Credentials belong exclusively in server.secrets.
const ApiUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    // Avoid URL/DOM globals in shared code: React Native also evaluates this schema.
    return /^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value);
  }, "API 地址必须是 HTTPS，且不含用户名、密码、查询参数或片段")
  .transform((s) => s.replace(/\/+$/, ""));
const HostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
    "填写域名，不含协议、端口或路径"
  );
const connectionFields = {
  hosts: z
    .array(HostSchema)
    .min(1)
    .max(20)
    .refine((hosts) => new Set(hosts).size === hosts.length, "域名不能重复"),
  apiBaseUrl: ApiUrlSchema,
};
export const ForgeSettingsSchema = z
  .object({
    codeup: z
      .object({
        ...connectionFields,
        hosts: connectionFields.hosts.default(["codeup.aliyun.com"]),
        apiBaseUrl: ApiUrlSchema.default("https://openapi-rdc.aliyuncs.com"),
        edition: z.enum(["central", "region"]).default("central"),
        organizationId: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9_-]*$/)
          .default(""),
      })
      .prefault({}),
    gitee: z
      .object({
        ...connectionFields,
        hosts: connectionFields.hosts.default(["gitee.com"]),
        apiBaseUrl: ApiUrlSchema.default("https://gitee.com/api/v5"),
      })
      .prefault({}),
  })
  .superRefine((value, ctx) => {
    if (value.codeup.hosts.some((host) => value.gitee.hosts.includes(host))) {
      ctx.addIssue({
        code: "custom",
        message: "Codeup 和 Gitee 不能使用相同的 Git 域名",
      });
    }
  });
export type ForgeSettings = z.infer<typeof ForgeSettingsSchema>;
export const forgeSettings = defineSettings({
  id: "connections",
  scope: "host",
  version: 1,
  schema: ForgeSettingsSchema,
});
