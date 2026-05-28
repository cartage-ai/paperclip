import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS, STATE_KEYS, type StanPluginConfig, type IssueChannelMap } from "./constants.js";
import { handleSlackEvent } from "./slack-events.js";

let currentContext: PluginContext | null = null;
let currentConfig: StanPluginConfig | null = null;

function parseConfig(raw: Record<string, unknown>): StanPluginConfig {
  if (
    typeof raw.slackBotTokenRef !== "string" ||
    typeof raw.slackSigningSecretRef !== "string" ||
    typeof raw.stanAgentId !== "string" ||
    typeof raw.slackBotUserId !== "string" ||
    typeof raw.companyId !== "string"
  ) {
    throw new Error("plugin-slack-stan: incomplete configuration");
  }
  return {
    slackBotTokenRef: raw.slackBotTokenRef,
    slackSigningSecretRef: raw.slackSigningSecretRef,
    stanAgentId: raw.stanAgentId,
    slackBotUserId: raw.slackBotUserId,
    companyId: raw.companyId,
  };
}

// ---------------------------------------------------------------------------
// Event subscription — post Stan's comments back to Slack
// ---------------------------------------------------------------------------

async function postStanReplyToSlack(ctx: PluginContext, config: StanPluginConfig, event: PluginEvent): Promise<void> {
  const payload = event.payload as { commentId?: string } | undefined;
  const commentId = payload?.commentId;
  const issueId = event.entityId;

  if (!commentId || !issueId) return;

  // 1. Resolve bot token at call time — never cache
  const botToken = await ctx.secrets.resolve(config.slackBotTokenRef);

  // 2. Look up which Slack thread this issue belongs to
  const channelMap = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.issueChannelMap,
  })) as IssueChannelMap | null) ?? {};

  const entry = channelMap[issueId];
  if (!entry) return;

  // 3. Find the specific comment body
  const comments = await ctx.issues.listComments(issueId, config.companyId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return;

  // 4. Post to Slack as a thread reply
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

function registerEventHandlers(ctx: PluginContext, config: StanPluginConfig): void {
  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    // Only relay comments authored by Stan's agent
    if (event.actorType !== "agent" || event.actorId !== config.stanAgentId) return;

    await postStanReplyToSlack(ctx, config, event);
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
    registerEventHandlers(ctx, currentConfig);
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    currentConfig = parseConfig(newConfig);
    // Re-registration of event handlers not required — they close over currentConfig
    // by reference via module-level var, so the updated value is picked up automatically.
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.slackEvents) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const ctx = currentContext;
    const config = currentConfig;
    if (!ctx || !config) {
      throw new Error("plugin-slack-stan: context not ready");
    }

    // Resolve secrets at call time — never cache
    const [signingSecret, botToken] = await Promise.all([
      ctx.secrets.resolve(config.slackSigningSecretRef),
      ctx.secrets.resolve(config.slackBotTokenRef),
    ]);

    await handleSlackEvent(ctx, input, config, signingSecret, botToken);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
