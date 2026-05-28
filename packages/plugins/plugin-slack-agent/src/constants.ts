export const PLUGIN_ID = "paperclip-slack-agent";
export const PLUGIN_VERSION = "0.1.5";

export const WEBHOOK_KEYS = {
  slackEvents: "slack-events",
} as const;

// State keys namespaced by agentId so multiple agents share one plugin instance
export const stateKey = {
  threadIssueMap: (agentId: string) => `${agentId}:thread-issue-map`,
  issueChannelMap: (agentId: string) => `${agentId}:issue-channel-map`,
  seenEventIds: (agentId: string) => `${agentId}:seen-event-ids`,
};

export const SEEN_EVENT_IDS_CAP = 1000;

export type AgentEntry = {
  agentId: string;
  slackBotToken: string;
  slackSigningSecret: string;
  slackBotUserId: string;
  companyId: string;
  displayName?: string;
};

export type SlackAgentPluginConfig = {
  agents: AgentEntry[];
};

export type ThreadIssueMap = Record<string, string>;

export type IssueChannelEntry = { channelId: string; threadTs: string };
export type IssueChannelMap = Record<string, IssueChannelEntry>;
