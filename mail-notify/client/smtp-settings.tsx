import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  readSmtpConfig,
  saveSmtpConfig,
  sendTestMail,
  SMTP_PRESETS,
  smtpConfigSchema,
  type SmtpConfig,
  type SmtpPreset,
} from "../shared/smtp";

type PresetChoice = SmtpPreset["id"] | "custom";

const PRESET_OPTIONS: { label: string; value: PresetChoice }[] = [
  ...SMTP_PRESETS.map((preset) => ({ label: preset.label, value: preset.id })),
  { label: "其他（自定义服务器）", value: "custom" },
];

interface Draft {
  preset: PresetChoice;
  host: string;
  port: string;
  user: string;
  to: string;
  password: string;
}

function presetFor(config: SmtpConfig | null): PresetChoice {
  // A separate 163 mailbox is the recommended sender, so it is the default for a new setup.
  if (!config) return "163";
  const match = SMTP_PRESETS.find((preset) => preset.host === config.host && preset.port === config.port);
  return match?.id ?? "custom";
}

function initialDraft(config: SmtpConfig | null): Draft {
  return {
    preset: presetFor(config),
    host: config?.host ?? "",
    port: String(config?.port ?? 465),
    user: config?.user ?? "",
    to: config?.to ?? "",
    password: "",
  };
}

type Notice = { tone: "ok" | "error"; text: string } | null;

function SmtpForm({
  theme,
  config,
  hasPassword,
  onSaved,
}: {
  theme: PluginSurfaceProps["theme"];
  config: SmtpConfig | null;
  hasPassword: boolean;
  onSaved(): void;
}) {
  const save = useRpc(saveSmtpConfig);
  const test = useRpc(sendTestMail);
  const [draft, setDraft] = useState(() => initialDraft(config));
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

  const saveDraft = useCallback(async () => {
    const preset = SMTP_PRESETS.find((candidate) => candidate.id === draft.preset);
    const parsed = smtpConfigSchema.safeParse({
      host: preset?.host ?? draft.host,
      port: preset?.port ?? Number(draft.port),
      user: draft.user,
      to: draft.to,
    });
    if (!parsed.success) {
      setNotice({ tone: "error", text: parsed.error.issues[0]?.message ?? "配置不完整" });
      return;
    }
    setBusy("saving");
    try {
      const result = await save({ ...parsed.data, password: draft.password.trim() });
      if (result.status === "missing-password") {
        setNotice({ tone: "error", text: "请填写授权码" });
        return;
      }
      setNotice({ tone: "ok", text: "已保存，可以发一封测试邮件确认" });
      onSaved();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [draft, save, onSaved]);

  const sendTest = useCallback(async () => {
    setBusy("testing");
    setNotice(null);
    try {
      const result = await test({});
      if (result.status === "sent") setNotice({ tone: "ok", text: "测试邮件已发出，留意微信里的 QQ 邮箱提醒" });
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
      <SettingsSection title="发件邮箱">
        <SettingsCard>
          <SettingsSelect
            label="服务商"
            value={draft.preset}
            options={PRESET_OPTIONS}
            disabled={busy !== null}
            onValueChange={(value) => update("preset", value)}
          />
          {draft.preset === "custom" ? (
            <SettingsInput
              label="SMTP 服务器"
              initialValue={draft.host}
              placeholder="smtp.example.com"
              disabled={busy !== null}
              onChangeText={(text) => update("host", text)}
            />
          ) : null}
          {draft.preset === "custom" ? (
            <SettingsInput
              label="端口"
              hint="465 走 SSL，其他端口走 STARTTLS"
              initialValue={draft.port}
              disabled={busy !== null}
              onChangeText={(text) => update("port", text)}
            />
          ) : null}
          <SettingsInput
            label="发件地址"
            hint="同时作为 SMTP 登录账号"
            initialValue={draft.user}
            placeholder="name@163.com"
            disabled={busy !== null}
            onChangeText={(text) => update("user", text)}
          />
          <SettingsInput
            label="授权码"
            hint="邮箱设置里开启 SMTP 后生成，不是登录密码"
            placeholder={hasPassword ? "已保存，留空则不修改" : "粘贴授权码"}
            secureTextEntry
            disabled={busy !== null}
            onChangeText={(text) => update("password", text)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="收件">
        <SettingsCard>
          <SettingsInput
            label="收件地址"
            hint="填 QQ 邮箱，并在微信 设置 → 通用 → 辅助功能 里启用 QQ 邮箱提醒"
            initialValue={draft.to}
            placeholder="12345@qq.com"
            disabled={busy !== null}
            onChangeText={(text) => update("to", text)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="操作">
        <SettingsCard>
          <SettingsAction
            label="保存配置"
            actionLabel={busy === "saving" ? "保存中…" : "保存"}
            disabled={busy !== null}
            onPress={() => void saveDraft()}
          />
          <SettingsAction
            label="发送测试邮件"
            hint="用已保存的配置发送"
            actionLabel={busy === "testing" ? "发送中…" : "发送"}
            disabled={busy !== null || !config}
            onPress={() => void sendTest()}
          />
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

export function SmtpSettings({ theme, host }: PluginSurfaceProps) {
  const read = useRpc(readSmtpConfig);
  const query = useQuery({ queryKey: ["mail-notify", "smtp", host.id], queryFn: () => read({}) });
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const refetch = query.refetch;
  const onSaved = useCallback(() => void refetch(), [refetch]);
  if (query.isPending) return <Text style={style}>读取配置…</Text>;
  if (query.isError)
    return (
      <SettingsSection title="发件邮箱">
        <Text style={style}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text>
        <SettingsAction label="读取配置失败" actionLabel="重试" onPress={() => void refetch()} />
      </SettingsSection>
    );
  return <SmtpForm theme={theme} config={query.data.config} hasPassword={query.data.hasPassword} onSaved={onSaved} />;
}
