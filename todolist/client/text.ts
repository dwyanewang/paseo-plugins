import type { TodoAgentDisplayState } from "../shared/schema";
import type { WorkItemAggregateState } from "../shared/state";

/** Every state has an icon and a label; color is never the only signal. */
export const AGGREGATE_PRESENTATION: Record<WorkItemAggregateState, { label: string; icon: string; tone: "default" | "warning" | "danger" | "success" }> = {
  permission: { label: "Needs permission", icon: "ShieldAlert", tone: "warning" },
  error: { label: "Agent error", icon: "CircleX", tone: "danger" },
  running: { label: "Agent running", icon: "LoaderCircle", tone: "default" },
  pending_launch: { label: "Launch pending", icon: "Hourglass", tone: "default" },
  outcome_unknown: { label: "Outcome unknown", icon: "CircleHelp", tone: "warning" },
  stale: { label: "Status stale", icon: "CloudOff", tone: "warning" },
  waiting_confirmation: { label: "Waiting for your review", icon: "CircleCheck", tone: "success" },
  closed: { label: "Agent closed", icon: "CircleSlash", tone: "default" },
  idle: { label: "Not started", icon: "Circle", tone: "default" },
};

export const DISPLAY_STATE_PRESENTATION: Record<TodoAgentDisplayState, { label: string; icon: string }> = {
  initializing: { label: "Initializing", icon: "LoaderCircle" },
  running: { label: "Running", icon: "Play" },
  permission: { label: "Needs permission", icon: "ShieldAlert" },
  error: { label: "Error", icon: "CircleX" },
  waiting_confirmation: { label: "Finished, awaiting review", icon: "CircleCheck" },
  closed: { label: "Closed", icon: "CircleSlash" },
  unavailable: { label: "Provider unavailable", icon: "CloudOff" },
};

export const TEXT = {
  trustNotice:
    "Todo runs inside the daemon.manage trust domain: any client with daemon management access can read and change every Todo item on this host. Project grouping is an organizational filter, not a security boundary.",
  removeNotice:
    "Removing the Todo plugin deletes its data on this daemon. Connected apps clear their local launch journals immediately; devices that are offline clean up on their next reconnect. There is no daemon-side restore.",
  rebindNotice:
    "Projects that were removed and re-added get a new identity. Todo never rebinds by path on its own; choose the new project explicitly.",
  unknownNotice:
    "A request was sent but its result is unknown. Todo never retries or resends on its own. Check the status, open the known workspace, or abandon and start a new attempt.",
  retryAnywayWarning:
    "Retry anyway starts a new attempt. If the earlier request did create a workspace or agent, you will end up with duplicates; late ones still appear here.",
  purgeWarning:
    "Purge permanently deletes this item and its launch history from Todo. Agents and workspaces are not touched.",
  forcePurgeWarning:
    "This item has attempts whose outcome is unknown. After a forced purge, late workspaces or agents from those attempts will no longer be linked here.",
  offlineJournalNotice:
    "Launch drafts live on the device that started them. Another device can check status and open known agents, but cannot take over the draft.",
  seedNotice:
    "The prompt starts from the saved default, or from the Todo title and details when no default is set. Whatever you finally submit in the composer is not copied back into Todo.",
  runNotice:
    "The prompt is sent as the agent's first message. Todo records the attempt and links the agent; it never resends on its own.",
  runModeHint: "Creates the agent in the chosen workspace and sends the prompt straight away.",
  composerModeHint:
    "Opens the native composer with the prompt filled in. You pick provider, model and workspace there and press send yourself.",
  noWorkspaceForRun:
    "This project has no open workspace, so there is nowhere to start the agent. Switch to the composer: its New workspace flow creates one.",
  noWorkspaceAtAll:
    "This project has no open workspace. Open one in Paseo first, then execute this item.",
  noProviderForRun: "No provider is ready on this daemon, so nothing can be started from here.",
  forgetAttemptWarning:
    "Removes this attempt and its agent links from the Todo history only. The agent and its workspace are untouched, but Todo stops tracking them.",
  checkNotice:
    "Check status re-reads every agent linked to this item from the daemon and updates the badges. It is the same action on the item and on an attempt.",
  resetWarning:
    "Reset replaces the Todo document with an empty one. Every item, attempt, and agent link on this host is lost, and open launch drafts on all devices become stale.",
};
