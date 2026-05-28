import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { AgentEntry, IssueChannelMap, ThreadIssueMap } from "./constants.js";
import { stateKey } from "./constants.js";
import { verifySlackSignature } from "./slack-verify.js";
import { isEventSeen } from "./state-dedupe.js";

// ---------------------------------------------------------------------------
// Slack event shape types
// ---------------------------------------------------------------------------

type SlackEventBody = {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts: string;
    channel: string;
    channel_type?: string;
    thread_ts?: string;
  };
  team_id?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function channelKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function dmKey(channelId: string): string {
  return `dm:${channelId}`;
}

/** Truncates a Slack message to a reasonable issue title. */
function firstMessageTitle(text: string): string {
  const stripped = text.replace(/<[^>]+>/g, "").trim();
  const firstLine = stripped.split("\n")[0] ?? stripped;
  return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine || "Slack message";
}

async function readThreadMap(ctx: PluginContext, agentId: string): Promise<ThreadIssueMap> {
  return ((await ctx.state.get({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(agentId) })) as ThreadIssueMap | null) ?? {};
}

async function readChannelMap(ctx: PluginContext, agentId: string): Promise<IssueChannelMap> {
  return ((await ctx.state.get({ scopeKind: "instance", stateKey: stateKey.issueChannelMap(agentId) })) as IssueChannelMap | null) ?? {};
}

async function persistThreadMaps(
  ctx: PluginContext,
  agentId: string,
  threadMap: ThreadIssueMap,
  channelMap: IssueChannelMap,
): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: stateKey.threadIssueMap(agentId) }, threadMap);
  await ctx.state.set({ scopeKind: "instance", stateKey: stateKey.issueChannelMap(agentId) }, channelMap);
}

async function postAckReaction(
  ctx: PluginContext,
  botToken: string,
  channel: string,
  timestamp: string,
): Promise<void> {
  await ctx.http.fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, timestamp, name: "eyes" }),
  });
}

// ---------------------------------------------------------------------------
// New-issue path
// ---------------------------------------------------------------------------

async function handleNewConversation(
  ctx: PluginContext,
  agent: AgentEntry,
  botToken: string,
  event: NonNullable<SlackEventBody["event"]>,
  mapKey: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const issue = await ctx.issues.create({
    companyId: agent.companyId,
    title: firstMessageTitle(event.text ?? ""),
    description: event.text ?? "",
    assigneeAgentId: agent.agentId,
  });

  const [threadMap, channelMap] = await Promise.all([readThreadMap(ctx, agent.agentId), readChannelMap(ctx, agent.agentId)]);
  threadMap[mapKey] = issue.id;
  channelMap[issue.id] = { channelId, threadTs };
  await persistThreadMaps(ctx, agent.agentId, threadMap, channelMap);

  await ctx.issues.requestWakeup(issue.id, agent.companyId, { reason: "Slack message received" });
  await postAckReaction(ctx, botToken, event.channel, event.ts);
}

// ---------------------------------------------------------------------------
// Continuation path
// ---------------------------------------------------------------------------

async function handleContinuation(
  ctx: PluginContext,
  agent: AgentEntry,
  botToken: string,
  event: NonNullable<SlackEventBody["event"]>,
  issueId: string,
): Promise<void> {
  await ctx.issues.createComment(issueId, event.text ?? "", agent.companyId);
  await ctx.issues.requestWakeup(issueId, agent.companyId, { reason: "Slack thread reply" });
  await postAckReaction(ctx, botToken, event.channel, event.ts);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Processes a single Slack Events API delivery for a specific agent.
 *
 * Precondition: caller has already verified the HMAC signature and identified `agent`
 * as the owner of this event. `signingSecret` is passed only for the secondary
 * verify inside url_verification handling (which is a no-op anyway).
 * Postcondition: side effects committed to Paperclip (issue created or comment added, wakeup queued).
 *
 * NOTE: URL-verification challenges cannot be echoed back through this webhook
 * interface (the host controls the HTTP response). Slack requires a direct echo
 * of the challenge value as the response body. For production use, configure
 * the Slack app's Request URL verification to use the plugin's raw webhook URL
 * and handle the initial verification in the host layer, OR disable challenge
 * verification in Slack settings after setting up the endpoint.
 */
export async function handleSlackEvent(
  ctx: PluginContext,
  input: PluginWebhookInput,
  agent: AgentEntry,
  signingSecret: string,
  botToken: string,
): Promise<void> {
  const body = input.parsedBody as SlackEventBody | undefined;

  // 1. URL verification challenge — log and return (can't echo challenge through plugin webhook)
  if (body?.type === "url_verification") {
    await ctx.activity.log({
      companyId: agent.companyId,
      message: `Received Slack URL verification challenge for ${agent.displayName ?? agent.agentId} — cannot echo from plugin webhook layer`,
    });
    return;
  }

  // 2. HMAC verification — reject forged requests (secondary check; caller already verified for routing)
  const signatureValid = verifySlackSignature(input.rawBody, input.headers, signingSecret);
  if (!signatureValid) {
    throw new Error("Slack signature verification failed");
  }

  // 3. Dedupe on Slack event_id
  const eventId = body?.event_id;
  if (eventId && await isEventSeen(ctx, agent.agentId, eventId)) return;

  const event = body?.event;
  if (!event) return;

  // 4. Ignore messages from this agent's own bot user
  if (event.user === agent.slackBotUserId || event.bot_id) return;

  const isDm = event.channel_type === "im" || event.type === "message.im";

  // 5. Route: DM — always create or continue
  if (isDm) {
    const threadMap = await readThreadMap(ctx, agent.agentId);
    const key = dmKey(event.channel);
    const existingIssueId = threadMap[key];

    if (existingIssueId) {
      await handleContinuation(ctx, agent, botToken, event, existingIssueId);
    } else {
      await handleNewConversation(ctx, agent, botToken, event, key, event.channel, event.ts);
    }
    return;
  }

  // 6. Route: app_mention — create new or continue thread
  if (event.type === "app_mention") {
    const threadMap = await readThreadMap(ctx, agent.agentId);
    const threadTs = event.thread_ts ?? event.ts;
    const key = channelKey(event.channel, threadTs);
    const existingIssueId = threadMap[key];

    if (existingIssueId) {
      await handleContinuation(ctx, agent, botToken, event, existingIssueId);
    } else {
      await handleNewConversation(ctx, agent, botToken, event, key, event.channel, threadTs);
    }
    return;
  }

  // 7. Route: untagged channel message in a tracked thread
  if (event.type === "message" && event.thread_ts) {
    const threadMap = await readThreadMap(ctx, agent.agentId);
    const key = channelKey(event.channel, event.thread_ts);
    const existingIssueId = threadMap[key];
    if (existingIssueId) {
      await handleContinuation(ctx, agent, botToken, event, existingIssueId);
    }
  }
}
