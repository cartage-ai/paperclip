import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SEEN_EVENT_IDS_CAP, stateKey } from "./constants.js";

/**
 * Checks whether a Slack event_id has already been processed for a given agent.
 *
 * Postcondition: if the event is new, it is recorded before returning false,
 * so a second call with the same id returns true.
 */
export async function isEventSeen(ctx: PluginContext, agentId: string, eventId: string): Promise<boolean> {
  const scope = { scopeKind: "instance" as const, stateKey: stateKey.seenEventIds(agentId) };
  const existing = (await ctx.state.get(scope)) as string[] | null;
  const seenIds = existing ?? [];

  if (seenIds.includes(eventId)) return true;

  const next = [...seenIds, eventId];
  const capped = next.length > SEEN_EVENT_IDS_CAP ? next.slice(next.length - SEEN_EVENT_IDS_CAP) : next;
  await ctx.state.set(scope, capped);

  return false;
}
