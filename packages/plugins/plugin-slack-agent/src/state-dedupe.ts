import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SEEN_EVENT_IDS_CAP, stateKey } from "./constants.js";

/**
 * Checks whether a Slack event_id has already been processed for a given agent.
 *
 * Read-only: callers must invoke `markEventSeen` after the event is fully
 * processed. Marking on check would turn a transient processing failure into
 * permanent message loss — Slack retries the same event_id, and a pre-marked
 * id makes every retry dedupe away before the work is redone.
 */
export async function hasEventBeenSeen(ctx: PluginContext, agentId: string, eventId: string): Promise<boolean> {
  const scope = { scopeKind: "instance" as const, stateKey: stateKey.seenEventIds(agentId) };
  const existing = (await ctx.state.get(scope)) as string[] | null;
  return (existing ?? []).includes(eventId);
}

/**
 * Records a Slack event_id as processed for a given agent.
 *
 * Call only after the event's side effects have committed successfully, so a
 * failed delivery stays eligible for Slack's retry.
 */
export async function markEventSeen(ctx: PluginContext, agentId: string, eventId: string): Promise<void> {
  const scope = { scopeKind: "instance" as const, stateKey: stateKey.seenEventIds(agentId) };
  const existing = (await ctx.state.get(scope)) as string[] | null;
  const seenIds = existing ?? [];
  if (seenIds.includes(eventId)) return;

  const next = [...seenIds, eventId];
  const capped = next.length > SEEN_EVENT_IDS_CAP ? next.slice(next.length - SEEN_EVENT_IDS_CAP) : next;
  await ctx.state.set(scope, capped);
}
