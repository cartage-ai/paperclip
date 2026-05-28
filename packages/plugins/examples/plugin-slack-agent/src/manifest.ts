import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Agent",
  description: "Connect one or more Paperclip agents to Slack — @mention or DM to create issues and get replies.",
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
      agents: {
        type: "array",
        title: "Agents",
        description: "One entry per Slack app / Paperclip agent pair. Each Slack app must point its Event Subscriptions URL at this plugin's webhook endpoint.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              title: "Agent ID",
              description: "The Paperclip agent ID.",
            },
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
            slackBotUserId: {
              type: "string",
              title: "Slack Bot User ID",
              description: "The bot's Slack user ID (UXXXXXXXX) — used to filter out self-messages.",
            },
            companyId: {
              type: "string",
              title: "Company ID",
              description: "The Paperclip company ID this agent belongs to.",
            },
            displayName: {
              type: "string",
              title: "Display Name",
              description: "Optional human-readable label for logs (e.g. 'Stan', 'Kelly').",
            },
          },
          required: ["agentId", "slackBotTokenRef", "slackSigningSecretRef", "slackBotUserId", "companyId"],
        },
      },
    },
    required: ["agents"],
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
