import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS, stateKey, type AgentEntry, type SlackAgentPluginConfig, type IssueChannelMap } from "./constants.js";
import { verifySlackSignature } from "./slack-verify.js";
import { handleSlackEvent } from "./slack-events.js";

let currentContext: PluginContext | null = null;
let currentConfig: SlackAgentPluginConfig | null = null;

function parseAgentEntry(raw: unknown, index: number): AgentEntry {
  if (
    typeof raw !== "object" || raw === null ||
    typeof (raw as Record<string, unknown>).agentId !== "string" ||
    typeof (raw as Record<string, unknown>).slackBotTokenRef !== "string" ||
    typeof (raw as Record<string, unknown>).slackSigningSecretRef !== "string" ||
    typeof (raw as Record<string, unknown>).slackBotUserId !== "string" ||
    typeof (raw as Record<string, unknown>).companyId !== "string"
  ) {
    throw new Error(`plugin-slack-agent: agents[${index}] is missing required fields`);
  }
  const entry = raw as Record<string, unknown>;
  return {
    agentId: entry.agentId as string,
    slackBotTokenRef: entry.slackBotTokenRef as string,
    slackSigningSecretRef: entry.slackSigningSecretRef as string,
    slackBotUserId: entry.slackBotUserId as string,
    companyId: entry.companyId as string,
    displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
  };
}

function parseConfig(raw: Record<string, unknown>): SlackAgentPluginConfig {
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error("plugin-slack-agent: config.agents must be a non-empty array");
  }
  return { agents: raw.agents.map(parseAgentEntry) };
}

// ---------------------------------------------------------------------------
// Event subscription — post agent comments back to Slack
// ---------------------------------------------------------------------------

async function postAgentReplyToSlack(ctx: PluginContext, agent: AgentEntry, event: PluginEvent): Promise<void> {
  const payload = event.payload as { commentId?: string } | undefined;
  const commentId = payload?.commentId;
  const issueId = event.entityId;

  if (!commentId || !issueId) return;

  const botToken = await ctx.secrets.resolve(agent.slackBotTokenRef);

  const channelMap = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: stateKey.issueChannelMap(agent.agentId),
  })) as IssueChannelMap | null) ?? {};

  const entry = channelMap[issueId];
  if (!entry) return;

  const comments = await ctx.issues.listComments(issueId, agent.companyId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return;

  await ctx.http.fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: entry.channelId,
      thread_ts: entry.threadTs,
      text: comment.body,
    }),
  });
}

function registerEventHandlers(ctx: PluginContext): void {
  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    const config = currentConfig;
    if (!config) return;
    if (event.actorType !== "agent") return;
    const agent = config.agents.find((a) => a.agentId === event.actorId);
    if (!agent) return;
    await postAgentReplyToSlack(ctx, agent, event);
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    const raw = await ctx.config.get();
    currentConfig = parseConfig(raw);
    registerEventHandlers(ctx);
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    currentConfig = parseConfig(newConfig);
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.slackEvents) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const ctx = currentContext;
    const config = currentConfig;
    if (!ctx || !config) {
      throw new Error("plugin-slack-agent: context not ready");
    }

    // Resolve all signing secrets, then HMAC-match to identify which agent owns this event
    const signingSecrets = await Promise.all(
      config.agents.map((a) => ctx.secrets.resolve(a.slackSigningSecretRef))
    );

    const agentIndex = signingSecrets.findIndex(
      (secret) => verifySlackSignature(input.rawBody, input.headers, secret)
    );

    if (agentIndex === -1) {
      throw new Error("Slack signature verification failed — no registered agent matched");
    }

    const agent = config.agents[agentIndex]!;
    const signingSecret = signingSecrets[agentIndex]!;
    const botToken = await ctx.secrets.resolve(agent.slackBotTokenRef);

    await handleSlackEvent(ctx, input, agent, signingSecret, botToken);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
