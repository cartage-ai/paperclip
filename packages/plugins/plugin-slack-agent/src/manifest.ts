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
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "events.subscribe",
    "activity.log.write",
    "agents.read",
    "webhooks.receive",
    "issue.documents.read",
    "issue.documents.write",
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
            slackBotToken: {
              type: "string",
              title: "Slack Bot Token",
              description: "The Slack bot OAuth token (xoxb-...).",
            },
            slackSigningSecret: {
              type: "string",
              title: "Slack Signing Secret",
              description: "The Slack app signing secret.",
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
          required: ["agentId", "slackBotToken", "slackSigningSecret", "slackBotUserId", "companyId"],
        },
      },
      secretRefAnchor: {
        type: "string",
        format: "secret-ref",
        title: "(reserved — do not set)",
        description: "Internal. Leave unset. Declared so the host scopes plugin secret-ref extraction to declared fields instead of treating every config UUID (agentId, companyId) as a disabled secret reference.",
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
