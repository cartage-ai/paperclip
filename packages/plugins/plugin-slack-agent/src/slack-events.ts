import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { AgentEntry, IssueChannelMap, ThreadIssueMap } from "./constants.js";
import { stateKey, ATTACHMENT_KEY_PREFIX, ATTACHMENT_MAX_BYTES } from "./constants.js";
import { verifySlackSignature } from "./slack-verify.js";
import { hasEventBeenSeen, markEventSeen } from "./state-dedupe.js";
import pdfParse from "pdf-parse";

// ---------------------------------------------------------------------------
// Slack event shape types
// ---------------------------------------------------------------------------

type SlackFile = {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download: string;
};

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
    files?: SlackFile[];
    subtype?: string;
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

function messageMentionsBot(event: NonNullable<SlackEventBody["event"]>, botUserId: string): boolean {
  const text = event.text ?? "";
  return text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`);
}

function slackMessageBody(event: NonNullable<SlackEventBody["event"]>): string {
  const text = (event.text ?? "").trim();
  if (text.length > 0) return text;
  const fileCount = event.files?.length ?? 0;
  if (fileCount > 0) return `[Slack message with ${fileCount} attachment${fileCount === 1 ? "" : "s"}]`;
  return "[Slack message]";
}

function slackMessageDedupeId(event: NonNullable<SlackEventBody["event"]>): string | null {
  if (!event.channel || !event.ts) return null;
  return `slack-message:${event.channel}:${event.ts}`;
}

/** Truncates a Slack message to a reasonable issue title. */
function firstMessageTitle(event: NonNullable<SlackEventBody["event"]>): string {
  const stripped = slackMessageBody(event).replace(/<[^>]+>/g, "").trim();
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
// File attachment ingestion
// ---------------------------------------------------------------------------

// Build a key matching the server's issueDocumentKeySchema:
// ^[a-z0-9][a-z0-9_-]*$, max 64 chars. Raw filenames (spaces, dots, parens,
// uppercase) would fail validation, so slug each part and cap the name.
function toDocumentKey(fileName: string, fileId: string): string {
  const slug = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const namePart = slug(fileName).slice(0, 30).replace(/-+$/g, "");
  const idPart = slug(fileId);
  return [ATTACHMENT_KEY_PREFIX, namePart, idPart].filter(Boolean).join("-");
}

async function ingestSingleFile(
  ctx: PluginContext,
  botToken: string,
  file: SlackFile,
  issueId: string,
  companyId: string,
): Promise<void> {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    await ctx.issues.createComment(
      issueId,
      `[Slack attachment] Skipped "${file.name}" — file too large (${(file.size / (1024 * 1024)).toFixed(1)} MB, limit 10 MB).`,
      companyId,
    );
    return;
  }

  const key = toDocumentKey(file.name, file.id);
  const existingDocument = await ctx.issues.documents.get(issueId, key, companyId);
  if (existingDocument) return;

  const isTextLike =
    file.mimetype.startsWith("text/") ||
    (file.mimetype === "application/octet-stream" && file.name.endsWith(".md"));
  const isPdf = file.mimetype === "application/pdf";
  const isImage = file.mimetype.startsWith("image/");

  if (isImage) {
    await ctx.issues.documents.upsert({
      issueId,
      key,
      companyId,
      title: file.name,
      body: [
        `# Slack image attachment: ${file.name}`,
        "",
        `- Slack file ID: ${file.id}`,
        `- MIME type: ${file.mimetype}`,
        `- Size: ${file.size} bytes`,
        file.url_private_download ? `- Slack private download URL: ${file.url_private_download}` : null,
        "",
        "This image was attached in Slack. If visual details are required and the agent cannot access the image content directly, ask the requester to describe the relevant parts or provide a text/PDF spec.",
      ].filter(Boolean).join("\n"),
    });
    await ctx.issues.createComment(issueId, `[Slack attachment] Image attached: ${file.name} (${file.mimetype}).`, companyId);
    return;
  }

  if (!isPdf && !isTextLike) {
    await ctx.issues.createComment(
      issueId,
      `[Slack attachment] Unsupported attachment received: "${file.name}" (${file.mimetype}, ${(file.size / 1024).toFixed(1)} KB).`,
      companyId,
    );
    return;
  }

  const res = await ctx.http.fetch(file.url_private_download, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  let body: string;
  if (isPdf) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const data = await pdfParse(buffer);
    body = data.text;
  } else {
    body = await res.text();
  }

  await ctx.issues.documents.upsert({ issueId, key, body, companyId, title: file.name });
}

async function resolveSlackDisplayName(
  ctx: PluginContext,
  botToken: string,
  userId: string,
): Promise<string> {
  try {
    const url = `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`;
    const res = await ctx.http.fetch(url, {
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
    });
    const data = await res.json() as { ok: boolean; user?: { real_name?: string; name?: string } };
    if (data.ok && data.user) {
      return data.user.real_name || data.user.name || userId;
    }
  } catch {
    // fall through to userId
  }
  return userId;
}

async function ingestFileAttachments(
  ctx: PluginContext,
  botToken: string,
  files: SlackFile[],
  issueId: string,
  companyId: string,
): Promise<void> {
  for (const file of files) {
    try {
      await ingestSingleFile(ctx, botToken, file, issueId, companyId);
    } catch (err) {
      await ctx.issues.createComment(
        issueId,
        `[Slack attachment] Failed to ingest "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
        companyId,
      );
    }
  }
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
    title: firstMessageTitle(event),
    description: slackMessageBody(event),
    assigneeAgentId: agent.agentId,
    status: "todo",
    workMode: "chat",
  });

  const [threadMap, channelMap] = await Promise.all([readThreadMap(ctx, agent.agentId), readChannelMap(ctx, agent.agentId)]);
  threadMap[mapKey] = issue.id;
  channelMap[issue.id] = { channelId, threadTs };
  await persistThreadMaps(ctx, agent.agentId, threadMap, channelMap);

  const displayName = await resolveSlackDisplayName(ctx, botToken, event.user ?? "");
  const slackTs = event.ts ? new Date(parseFloat(event.ts) * 1000).toISOString() : undefined;
  await ctx.issues.createComment(issue.id, slackMessageBody(event), agent.companyId, {
    authorType: "user",
    presentation: {
      kind: "message",
      tone: "neutral",
      title: displayName ? `Slack · ${displayName}` : "Slack",
      detailsDefaultOpen: false,
    },
    createdAt: slackTs,
  });

  if (event.files?.length) {
    await ingestFileAttachments(ctx, botToken, event.files, issue.id, agent.companyId);
  }

  await ctx.issues.requestWakeup(issue.id, agent.companyId, { reason: "Slack message received" });
  await postAckReaction(ctx, botToken, event.channel, event.ts);
}

// ---------------------------------------------------------------------------
// Continuation path
// ---------------------------------------------------------------------------

async function ensureChatContinuationIsWakeable(
  ctx: PluginContext,
  agent: AgentEntry,
  issueId: string,
): Promise<void> {
  const issue = await ctx.issues.get(issueId, agent.companyId);
  if (!issue) throw new Error(`Tracked Slack issue not found: ${issueId}`);

  if (issue.status === "done" && issue.workMode === "chat") {
    await ctx.issues.update(issueId, { status: "todo" }, agent.companyId, {
      actorAgentId: agent.agentId,
    });
  }
}

async function handleContinuation(
  ctx: PluginContext,
  agent: AgentEntry,
  botToken: string,
  event: NonNullable<SlackEventBody["event"]>,
  issueId: string,
): Promise<void> {
  await ensureChatContinuationIsWakeable(ctx, agent, issueId);

  const displayName = await resolveSlackDisplayName(ctx, botToken, event.user ?? "");
  const slackTs = event.ts ? new Date(parseFloat(event.ts) * 1000).toISOString() : undefined;
  await ctx.issues.createComment(issueId, slackMessageBody(event), agent.companyId, {
    authorType: "user",
    presentation: {
      kind: "message",
      tone: "neutral",
      title: displayName ? `Slack · ${displayName}` : "Slack",
      detailsDefaultOpen: false,
    },
    createdAt: slackTs,
  });

  if (event.files?.length) {
    await ingestFileAttachments(ctx, botToken, event.files, issueId, agent.companyId);
  }

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

  // 3. Dedupe on Slack event_id — read-only check; mark only after success
  //    so a failed delivery stays eligible for Slack's retry.
  const eventId = body?.event_id;
  if (eventId && await hasEventBeenSeen(ctx, agent.agentId, eventId)) return;

  const event = body?.event;
  if (!event) return;

  const messageDedupeId = slackMessageDedupeId(event);
  if (messageDedupeId && await hasEventBeenSeen(ctx, agent.agentId, messageDedupeId)) return;

  const didProcess = await routeSlackEvent(ctx, agent, botToken, event);

  if (eventId) await markEventSeen(ctx, agent.agentId, eventId);
  if (didProcess && messageDedupeId) await markEventSeen(ctx, agent.agentId, messageDedupeId);
}

/**
 * Routes a verified, de-duplicated Slack event to the new-issue or continuation
 * path. Throws on any side-effect failure so the caller skips `markEventSeen`
 * and the delivery can be retried.
 */
async function routeSlackEvent(
  ctx: PluginContext,
  agent: AgentEntry,
  botToken: string,
  event: NonNullable<SlackEventBody["event"]>,
): Promise<boolean> {
  // Ignore messages from this agent's own bot user
  if (event.user === agent.slackBotUserId || event.bot_id) return false;

  const isDm = event.channel_type === "im" || event.type === "message.im";

  // Route: DM — always create or continue
  if (isDm) {
    const threadMap = await readThreadMap(ctx, agent.agentId);
    const key = dmKey(event.channel);
    const existingIssueId = threadMap[key];

    if (existingIssueId) {
      await handleContinuation(ctx, agent, botToken, event, existingIssueId);
    } else {
      await handleNewConversation(ctx, agent, botToken, event, key, event.channel, event.ts);
    }
    return true;
  }

  // Route: app_mention or a generic channel message containing the bot mention.
  // Slack can deliver file_share messages with mentions as `message`, not `app_mention`.
  if (event.type === "app_mention" || messageMentionsBot(event, agent.slackBotUserId)) {
    const threadMap = await readThreadMap(ctx, agent.agentId);
    const threadTs = event.thread_ts ?? event.ts;
    const key = channelKey(event.channel, threadTs);
    const existingIssueId = threadMap[key];

    if (existingIssueId) {
      await handleContinuation(ctx, agent, botToken, event, existingIssueId);
    } else {
      await handleNewConversation(ctx, agent, botToken, event, key, event.channel, threadTs);
    }
    return true;
  }

  // Route: untagged channel message in a tracked thread
  if (event.type === "message" && event.thread_ts) {
    const threadMap = await readThreadMap(ctx, agent.agentId);
    const key = channelKey(event.channel, event.thread_ts);
    const existingIssueId = threadMap[key];
    if (existingIssueId) {
      await handleContinuation(ctx, agent, botToken, event, existingIssueId);
      return true;
    }
  }

  return false;
}
