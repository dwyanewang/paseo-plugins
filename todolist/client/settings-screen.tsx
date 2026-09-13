import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { CAPACITY, DETAILS_MAX_BYTES, PROMPT_MAX_BYTES, TITLE_MAX_CODE_POINTS } from "../shared/limits";
import { TEXT } from "./text";

export function TodoSettingsScreen({ theme }: PluginSurfaceProps) {
  const body = { color: theme.colors.foreground, fontSize: 14 };
  return (
    <SettingsSection title="Todo data and trust">
      <SettingsCard>
        <SettingsRow label="Trust domain">
          <Text style={body}>{TEXT.trustNotice}</Text>
        </SettingsRow>
        <SettingsRow label="Removing the plugin">
          <Text style={body}>{TEXT.removeNotice}</Text>
        </SettingsRow>
        <SettingsRow label="Launch drafts">
          <Text style={body}>{TEXT.offlineJournalNotice}</Text>
        </SettingsRow>
        <SettingsRow label="Projects">
          <Text style={body}>{TEXT.rebindNotice}</Text>
        </SettingsRow>
        <SettingsRow label="Limits">
          <Text style={body}>
            {`Title ${TITLE_MAX_CODE_POINTS} characters, details ${DETAILS_MAX_BYTES / 1024} KiB, prompts ${PROMPT_MAX_BYTES / 1024} KiB. Ordinary growth stops at ${CAPACITY.softLimitBytes / 1024} KiB; recovery writes may use ${CAPACITY.recoveryReserveBytes / 1024} KiB more; nothing grows past ${CAPACITY.absoluteLimitBytes / 1024} KiB.`}
          </Text>
        </SettingsRow>
        <SettingsRow label="Recovery">
          <Text style={body}>Invalid data shows a read-only recovery screen in the Todo surface. Reset is explicit and confirmed twice.</Text>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
