# @cartage/paperclip-plugin-slack-agent

Connect one or more [Paperclip](https://paperclip.dev) agents to Slack. Each agent answers
`@mentions` and DMs in its Slack workspace: a mention opens a Paperclip issue, the agent's
replies post back into the Slack thread, and follow-up messages continue the same issue.

## Install

Install at runtime via the Paperclip plugins API (no redeploy needed):

```bash
curl -X POST "$PAPERCLIP_URL/api/plugins/install" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "packageName": "@cartage/paperclip-plugin-slack-agent", "version": "0.1.12" }'
```

## Configure

Tokens are supplied **per agent in the plugin config** — one Slack app per agent. Set the
`agents` array via the config API:

```bash
curl -X PUT "$PAPERCLIP_URL/api/plugins/$PLUGIN_ID/config" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agents": [{
      "agentId":         "<paperclip-agent-id>",
      "companyId":       "<paperclip-company-id>",
      "slackBotToken":   "xoxb-...",
      "slackSigningSecret": "...",
      "slackBotUserId":  "U........",
      "displayName":     "Stan"
    }]
  }'
```

| Field | Description |
|-------|-------------|
| `agentId` | Paperclip agent that owns this Slack identity |
| `companyId` | Paperclip company the agent belongs to |
| `slackBotToken` | Slack **Bot User OAuth Token** (`xoxb-…`) |
| `slackSigningSecret` | Slack app **Signing Secret** (used to verify inbound events) |
| `slackBotUserId` | Bot's Slack member ID (`U…`) — used to ignore the bot's own messages |
| `displayName` | Optional label for logs |

## Slack app setup

1. **Event Subscriptions → Request URL:**
   `$PAPERCLIP_URL/api/plugins/$PLUGIN_ID/webhooks/slack-events`
   (the `url_verification` challenge is echoed automatically)
2. **Subscribe to bot events:** `app_mention`, `message.channels`, `message.im`
   (and `message.groups` if the bot operates in private channels). `message.channels`
   is required for **thread replies** in public channels — without it Slack only delivers
   the initial `@mention`, and follow-ups in the thread are never received.
3. **OAuth scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `im:history`,
   `im:read`, `reactions:write` (add `groups:history` for private channels)
4. Install the app to the workspace and copy the Bot Token + Signing Secret into the config above.

## Behavior

- `@mention` in a channel → 👀 reaction → new Paperclip issue → agent reply posts in-thread
- Reply in the thread → continues the same issue (multi-turn)
- DM → same flow in the DM channel
- Duplicate Slack `event_id`s are de-duplicated (one reply per event)
- Inbound events are HMAC-verified against the agent's signing secret; forged signatures are rejected

## License

MIT
