import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SEEN_EVENT_IDS_CAP, STATE_KEYS } from "./constants.js";

const SCOPE = { scopeKind: "instance" as const, stateKey: STATE_KEYS.seenEventIds };

/**
 * Checks whether a Slack event_id has already been processed.
 *
 * Postcondition: if the event is new, it is recorded before returning false,
 * so a second call with the same id returns true.
 */
export async function isEventSeen(ctx: PluginContext, eventId: string): Promise<boolean> {
  const existing = (await ctx.state.get(SCOPE)) as string[] | null;
  const seenIds = existing ?? [];

  if (seenIds.includes(eventId)) return true;

  const next = [...seenIds, eventId];
  const capped = next.length > SEEN_EVENT_IDS_CAP ? next.slice(next.length - SEEN_EVENT_IDS_CAP) : next;
  await ctx.state.set(SCOPE, capped);

  return false;
}
