import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, ConfirmModal, Notice } from "./components";
import { useTodoRecovery } from "./data";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";

/** Read-only recovery screen for an invalid or failed document. Reset needs two confirmations. */
export function RecoveryScreen(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  error: string;
  revision: string | null;
  reload: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const { styles, theme } = props;
  const recovery = useTodoRecovery();
  const [confirm, setConfirm] = useState(false);
  const [armed, setArmed] = useState(false);
  return (
    <View style={styles.screen}>
      <Text style={styles.headerTitle}>Todo data needs recovery</Text>
      <Notice styles={styles} theme={theme} kind="danger" title="The stored Todo document cannot be used">
        <Text style={styles.body}>{props.error}</Text>
        {props.revision ? <Text style={styles.mono}>Revision {props.revision}</Text> : null}
      </Notice>
      <Text style={styles.muted}>Nothing is discarded automatically. Reload to retry, or reset after confirming twice.</Text>
      <View style={styles.rowWrap}>
        <Button styles={styles} theme={theme} label="Reload" icon="RefreshCw" onPress={() => void props.reload()} />
        <Button styles={styles} theme={theme} label="Reset Todo data" icon="Trash2" variant="danger" disabled={recovery.saving} onPress={() => { setArmed(false); setConfirm(true); }} />
      </View>
      {recovery.saveError ? <Text style={styles.danger}>{recovery.saveError}</Text> : null}
      <ConfirmModal
        styles={styles}
        theme={theme}
        open={confirm}
        title="Reset Todo data"
        message={TEXT.resetWarning}
        confirmLabel="Reset now"
        danger
        requireDouble
        armed={armed}
        onArm={() => setArmed(true)}
        onOpenChange={setConfirm}
        onConfirm={() => {
          setConfirm(false);
          void recovery.reset().then(async (ok) => {
            if (ok) await props.onReset();
          });
        }}
      />
    </View>
  );
}
