export const PLUGIN_ID = "paperclip-slack-stan";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  slackEvents: "slack-events",
} as const;

// Plugin state keys — all stored at scopeKind "instance"
export const STATE_KEYS = {
  // Maps "${channelId}:${threadTs}" → issueId
  threadIssueMap: "thread-issue-map",
  // Maps issueId → { channelId, threadTs }
  issueChannelMap: "issue-channel-map",
  // Array of seen Slack event_id strings (capped at 1000)
  seenEventIds: "seen-event-ids",
} as const;

export const SEEN_EVENT_IDS_CAP = 1000;

export type StanPluginConfig = {
  slackBotTokenRef: string;
  slackSigningSecretRef: string;
  stanAgentId: string;
  slackBotUserId: string;
  companyId: string;
};

export type ThreadIssueMap = Record<string, string>;

export type IssueChannelEntry = { channelId: string; threadTs: string };
export type IssueChannelMap = Record<string, IssueChannelEntry>;
