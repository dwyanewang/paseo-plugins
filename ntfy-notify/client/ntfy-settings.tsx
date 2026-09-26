import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  DEFAULT_SERVER,
  DEFAULT_TOPIC,
  ntfyConfigSchema,
  readNtfyConfig,
  saveNtfyConfig,
  sendTestNotification,
  type NtfyConfig,
} from "../shared/ntfy";

interface Draft {
  server: string;
  topic: string;
  token: string;
}

type Notice = { tone: "ok" | "error"; text: string } | null;

function NtfyForm({
  theme,
  config,
  hasToken,
  onSaved,
}: {
  theme: PluginSurfaceProps["theme"];
  config: NtfyConfig | null;
  hasToken: boolean;
  onSaved(): void;
}) {
  const save = useRpc(saveNtfyConfig);
  const test = useRpc(sendTestNotification);
  const [draft, setDraft] = useState<Draft>(() => ({
    server: config?.server ?? DEFAULT_SERVER,
    topic: config?.topic ?? DEFAULT_TOPIC,
    token: "",
  }));
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const styles = useMemo(
    () => ({
      ok: { color: theme.colors.statusSuccess },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
  const update = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const persist = useCallback(
    async (clearToken: boolean) => {
      const parsed = ntfyConfigSchema.safeParse({ server: draft.server, topic: draft.topic });
      if (!parsed.success) {
        setNotice({ tone: "error", text: parsed.error.issues[0]?.message ?? "配置不完整" });
        return;
      }
      setBusy("saving");
      try {
        await save({ ...parsed.data, token: clearToken ? "" : draft.token, clearToken });
        setNotice({ tone: "ok", text: clearToken ? "已清除令牌" : "已保存，可以发一条测试通知确认" });
        onSaved();
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(null);
      }
    },
    [draft, save, onSaved],
  );

  const sendTest = useCallback(async () => {
    setBusy("testing");
    setNotice(null);
    try {
      const result = await test({});
      if (result.status === "sent") setNotice({ tone: "ok", text: "测试通知已发出，留意手机上的 ntfy" });
      else if (result.status === "unconfigured") setNotice({ tone: "error", text: "请先保存配置" });
      else setNotice({ tone: "error", text: `发送失败：${result.error}` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [test]);

  return (
    <>
      <SettingsSection title="ntfy 服务器">
        <SettingsCard>
          <SettingsInput
            label="服务器地址"
            hint="daemon 发布通知用的地址；ntfy 和 daemon 在同一台机器上时用 127.0.0.1"
            initialValue={draft.server}
            placeholder={DEFAULT_SERVER}
            disabled={busy !== null}
            onChangeText={(text) => update("server", text)}
          />
          <SettingsInput
            label="主题"
            hint="手机上订阅同一个主题"
            initialValue={draft.topic}
            placeholder={DEFAULT_TOPIC}
            disabled={busy !== null}
            onChangeText={(text) => update("topic", text)}
          />
          <SettingsInput
            label="访问令牌"
            hint="有发布权限的令牌（tk_ 开头）；服务器不需要认证时留空"
            placeholder={hasToken ? "已保存，留空则不修改" : "tk_…"}
            secureTextEntry
            disabled={busy !== null}
            onChangeText={(text) => update("token", text)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="操作">
        <SettingsCard>
          <SettingsAction
            label="保存配置"
            actionLabel={busy === "saving" ? "保存中…" : "保存"}
            disabled={busy !== null}
            onPress={() => void persist(false)}
          />
          <SettingsAction
            label="发送测试通知"
            hint="用已保存的配置发送"
            actionLabel={busy === "testing" ? "发送中…" : "发送"}
            disabled={busy !== null || !config}
            onPress={() => void sendTest()}
          />
          {hasToken ? (
            <SettingsAction
              label="清除已保存的令牌"
              hint="改用不需要认证的服务器时使用"
              actionLabel="清除"
              disabled={busy !== null}
              onPress={() => void persist(true)}
            />
          ) : null}
        </SettingsCard>
        {notice ? (
          <Text accessibilityRole={notice.tone === "error" ? "alert" : undefined} style={styles[notice.tone]}>
            {notice.text}
          </Text>
        ) : null}
      </SettingsSection>
    </>
  );
}

export function NtfySettings({ theme, host }: PluginSurfaceProps) {
  const read = useRpc(readNtfyConfig);
  const query = useQuery({ queryKey: ["ntfy-notify", "config", host.id], queryFn: () => read({}) });
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const refetch = query.refetch;
  const onSaved = useCallback(() => void refetch(), [refetch]);
  if (query.isPending) return <Text style={style}>读取配置…</Text>;
  if (query.isError)
    return (
      <SettingsSection title="ntfy 服务器">
        <Text style={style}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text>
        <SettingsAction label="读取配置失败" actionLabel="重试" onPress={() => void refetch()} />
      </SettingsSection>
    );
  return <NtfyForm theme={theme} config={query.data.config} hasToken={query.data.hasToken} onSaved={onSaved} />;
}
