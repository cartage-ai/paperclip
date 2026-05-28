import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Stan",
  description: "Reactive Slack-chat agent — @mention Stan or DM him to get answers from your internal PM.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "events.subscribe",
    "activity.log.write",
    "agents.read",
    "webhooks.receive",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackBotTokenRef: {
        type: "string",
        title: "Slack Bot Token Secret Ref",
        description: "Secret reference for the Slack bot OAuth token (xoxb-...).",
      },
      slackSigningSecretRef: {
        type: "string",
        title: "Slack Signing Secret Ref",
        description: "Secret reference for the Slack app signing secret.",
      },
      stanAgentId: {
        type: "string",
        title: "Stan Agent ID",
        description: "The Paperclip agent ID for Stan.",
      },
      slackBotUserId: {
        type: "string",
        title: "Slack Bot User ID",
        description: "Stan's Slack user ID (UXXXXXXXX) — used to filter out self-messages.",
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description: "The Paperclip company ID that Stan belongs to.",
      },
    },
    required: ["slackBotTokenRef", "slackSigningSecretRef", "stanAgentId", "slackBotUserId", "companyId"],
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.slackEvents,
      displayName: "Slack Events",
      description: "Receives Slack Events API payloads (app_mention, message.im).",
    },
  ],
};

export default manifest;
