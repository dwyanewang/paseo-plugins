import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import {
  ForgeSettingsSchema,
  forgeSettings,
  platforms,
  type Platform,
} from "../shared/settings";
import { definitions } from "../shared/providers";
import {
  deleteToken,
  saveToken,
  testConnection,
  tokenStatus,
} from "../shared/rpc";

type Ready = Extract<
  SettingsState<typeof ForgeSettingsSchema>,
  { status: "ready" }
>;

function ConnectionEditor({
  platform,
  settings,
  onClose,
}: {
  platform: Platform;
  settings: Ready;
  onClose(): void;
}) {
  // Pin both the draft and revision. An update from another device must conflict,
  // rather than silently applying this draft over that device's settings.
  const [snapshot] = useState(() => ({
    values: settings.values,
    revision: settings.revision,
  }));
  const [apiBaseUrl, setApiBaseUrl] = useState(
    snapshot.values[platform].apiBaseUrl
  );
  const [hosts, setHosts] = useState(
    snapshot.values[platform].hosts.join(", ")
  );
  const [edition, setEdition] = useState(snapshot.values.codeup.edition);
  const [organizationId, setOrganizationId] = useState(
    snapshot.values.codeup.organizationId
  );
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const parsed = ForgeSettingsSchema.safeParse({
      ...snapshot.values,
      [platform]: {
        apiBaseUrl,
        hosts: hosts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(platform === "codeup" ? { edition, organizationId } : {}),
      },
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("；"));
      return;
    }
    setError(null);
    if (await settings.save(parsed.data, snapshot.revision)) onClose();
  }
  return (
    <SettingsCard>
      <SettingsInput
        label="API 地址"
        initialValue={apiBaseUrl}
        onChangeText={setApiBaseUrl}
        disabled={settings.saving}
        hint="修改地址后需要重新填写令牌。"
        error={error ?? settings.saveError}
      />
      <SettingsInput
        label="Git 域名"
        initialValue={hosts}
        onChangeText={setHosts}
        disabled={settings.saving}
        hint="多个域名用英文逗号分隔；可添加 SSH 别名。"
      />
      {platform === "codeup" ? (
        <>
          <SettingsSelect<"central" | "region">
            label="云效版本"
            value={edition}
            onValueChange={setEdition}
            disabled={settings.saving}
            options={[
              { label: "中心站", value: "central" },
              { label: "Region 站", value: "region" },
            ]}
          />
          <SettingsInput
            label="组织 ID"
            initialValue={organizationId}
            onChangeText={setOrganizationId}
            disabled={settings.saving}
            hint="中心站留空时从 Git 路径第一段读取；Region 站不需要填写。"
          />
        </>
      ) : null}
      <SettingsAction
        label="连接设置"
        actionLabel="保存"
        onPress={() => void save()}
        disabled={settings.saving}
      />
      <SettingsAction
        label="放弃本次修改"
        actionLabel="取消"
        onPress={onClose}
        disabled={settings.saving}
      />
    </SettingsCard>
  );
}

function Credentials({
  platform,
  apiBaseUrl,
  configured,
  refresh,
  theme,
}: {
  platform: Platform;
  apiBaseUrl: string;
  configured: boolean | undefined;
  refresh(): Promise<unknown>;
  theme: PluginSurfaceProps["theme"];
}) {
  const write = useRpc(saveToken),
    remove = useRpc(deleteToken),
    test = useRpc(testConnection);
  const [token, setToken] = useState("");
  const inputRef = useRef<SettingsInputHandle>(null);
  const mutation = useMutation({
    // Credentials are never mutation variables or query data.
    mutationFn: async (action: "save" | "delete" | "test") => {
      const target = { platform, apiBaseUrl };
      if (action === "test") return (await test(target)).message;
      if (action === "save") {
        await write({ ...target, token });
        setToken("");
        inputRef.current?.replaceText("");
      } else await remove(target);
      await refresh();
      return action === "save" ? "令牌已保存" : "令牌已移除";
    },
  });
  return (
    <SettingsCard>
      <SettingsRow
        label="认证"
        hint={
          configured === undefined
            ? "正在读取令牌状态…"
            : configured
            ? "已配置令牌"
            : "尚未配置令牌"
        }
      />
      <SettingsInput
        ref={inputRef}
        label="个人访问令牌"
        placeholder="输入新令牌"
        onChangeText={setToken}
        secureTextEntry
        disabled={mutation.isPending}
        hint="仅保存在当前宿主；保存后不会回显。"
      />
      <SettingsAction
        label="更新令牌"
        actionLabel="保存令牌"
        disabled={mutation.isPending || !token.trim()}
        onPress={() => mutation.mutate("save")}
      />
      <SettingsAction
        label="验证令牌"
        actionLabel="测试连接"
        disabled={mutation.isPending || !configured}
        onPress={() => mutation.mutate("test")}
      />
      {configured ? (
        <SettingsAction
          label="清除认证"
          actionLabel="移除令牌"
          disabled={mutation.isPending}
          onPress={() => mutation.mutate("delete")}
        />
      ) : null}
      {mutation.error || mutation.data ? (
        <SettingsRow label="连接结果">
          <Text
            accessibilityRole={mutation.error ? "alert" : undefined}
            style={{ color: theme.colors.foreground }}
          >
            {mutation.error?.message ?? mutation.data}
          </Text>
        </SettingsRow>
      ) : null}
    </SettingsCard>
  );
}

function Controls({
  settings,
  theme,
  layout,
}: { settings: Ready } & Pick<PluginSurfaceProps, "theme" | "layout">) {
  const [editing, setEditing] = useState<Platform | null>(null);
  const readStatus = useRpc(tokenStatus),
    client = useQueryClient();
  const key = [
    "forge-credentials",
    settings.values.codeup.apiBaseUrl,
    settings.values.gitee.apiBaseUrl,
  ];
  const tokens = useQuery({ queryKey: key, queryFn: () => readStatus({}) });
  return (
    <View style={{ gap: layout.compact ? 16 : 24 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        通过 HTTP API 连接 Codeup 和 Gitee。配置后即可在仓库中查看、创建和合并
        PR/MR。
      </Text>
      {platforms.map((platform) => (
        <SettingsSection
          key={platform}
          title={definitions[platform].displayName}
        >
          {editing === platform ? (
            <ConnectionEditor
              platform={platform}
              settings={settings}
              onClose={() => setEditing(null)}
            />
          ) : (
            <SettingsCard>
              <SettingsRow
                label="API 地址"
                hint={settings.values[platform].apiBaseUrl}
              />
              <SettingsRow
                label="Git 域名"
                hint={settings.values[platform].hosts.join(", ")}
              />
              <SettingsAction
                label="连接设置"
                actionLabel="编辑"
                disabled={editing !== null}
                onPress={() => setEditing(platform)}
              />
            </SettingsCard>
          )}
          <Credentials
            key={settings.values[platform].apiBaseUrl}
            platform={platform}
            apiBaseUrl={settings.values[platform].apiBaseUrl}
            configured={tokens.data?.[platform]}
            refresh={() =>
              client.invalidateQueries({ queryKey: ["forge-credentials"] })
            }
            theme={theme}
          />
        </SettingsSection>
      ))}
      {tokens.error ? (
        <SettingsCard>
          <SettingsRow label="无法读取认证状态" error={tokens.error.message} />
          <SettingsAction
            label="重试"
            actionLabel="刷新"
            onPress={() => void tokens.refetch()}
          />
        </SettingsCard>
      ) : null}
      <Text style={{ color: theme.colors.foregroundMuted }}>
        保存设置或令牌后，需重新加载 Forge 插件以更新仓库识别。
      </Text>
    </View>
  );
}

export function ForgeSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(forgeSettings);
  if (settings.status === "loading")
    return (
      <Text style={{ color: theme.colors.foreground }}>正在读取设置…</Text>
    );
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Forge 连接">
        <Text
          style={{ color: theme.colors.foreground }}
          accessibilityRole="alert"
        >
          {settings.error}
        </Text>
        <SettingsAction
          label="重试读取"
          actionLabel="刷新"
          onPress={() => void settings.reload()}
        />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="恢复默认连接配置（保留令牌）"
            actionLabel="重置"
            onPress={() => void settings.reset()}
            disabled={settings.saving}
          />
        ) : null}
      </SettingsSection>
    );
  return <Controls settings={settings} theme={theme} layout={layout} />;
}
