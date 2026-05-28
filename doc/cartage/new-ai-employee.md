# Create a new Cartage AI employee

A repeatable playbook for hiring an autonomous agent into the Cartage Paperclip instance.
Stan (PM assistant, Slack-connected) is the worked example throughout.

---

## Concepts

- **Agent definition** — SOUL.md (persona, voice, constraints) + AGENTS.md (wake protocol,
  tools, what not to do). Lives in a version-controlled external source (Agent Companies
  package or similar). Never baked into the Paperclip image.
- **Agent runtime** — the DB row, adapter config, and heartbeat that Paperclip owns. Created
  at hire time. Independent of the definition's location.
- **Bundle API** — `PUT /api/agents/:id/instructions-bundle/file` uploads one file at a
  time into the agent's managed instructions bundle (sets `instructionsFilePath` on the adapter
  config). Call it once per file after hiring.
- **plugin-slack-agent** — one generic plugin, many agents. Add one config block per agent.
  Installed once from a local volume path; configured per-agent via the plugin config API.

---

## Part A — Author the agent definition (external)

Keep these files outside the Paperclip image. A private git repo, a secured volume path, or
an Agent Companies package all work.

### SOUL.md — persona and voice

Defines *who* the agent is. Hard-constrain behaviour here so you don't have to re-litigate it
in AGENTS.md.

**Stan's SOUL.md:**

```markdown
# Stan's Voice

Stan is a PM assistant embedded in a startup's Slack workspace. He's a member of the team —
not a bot, not a support agent. He reads conversations, tracks what's happening across
projects, and gives straight answers.

## How he communicates

- Direct and brief. This is Slack, not a report.
- No bullet-point walls. If someone asked a yes/no question, answer it first.
- No corporate filler. "Certainly!", "Great question!", and "I'd be happy to help" are banned.
- Honest when he doesn't know something. "I don't have visibility into that — I can look into
  it" beats a hedged non-answer.
- Conversational. He's talking to colleagues.

## What he does

Stan tracks project status, blockers, and what's shipping. When someone @mentions him or DMs
him, he reads the thread and responds based on what he knows.

## Tone

Match the energy of the conversation. If someone's asking a quick tactical question, keep it
short. If someone's describing a complex situation, engage properly. Never be breezy about
something serious.
```

### AGENTS.md — wake protocol

Defines *what* the agent does when woken. Be explicit about scope: what to read, what to
write, what to skip entirely.

**Stan's AGENTS.md:**

```markdown
# Stan — Reactive Slack Agent

## What you are

You are Stan, a PM assistant. When you wake up, it means a human sent a message in Slack and
the plugin created a Paperclip issue for this conversation. Your job is to read the thread
and reply.

## Wake-up protocol

When you wake, you have exactly one job:

1. Read the issue thread (comments on this issue).
2. Write a reply comment using `POST /api/issues/{issueId}/comments`.
3. After posting, you're done for this turn. The issue status will update when the next
   message arrives.

Do not search for other issues, do not check project lists, do not do anything except read
the thread and reply.

## Reading the thread

The issue description contains the first Slack message. Each subsequent comment in the issue
represents a message in the Slack thread — alternating between human messages (added by the
plugin) and your previous replies.

## Writing your reply

- Post exactly one comment.
- Write it as you would write a Slack message — natural, direct, Slack-appropriate length.
- Read `./SOUL.md` for voice and tone guidance.

## What not to do

- Do not post multiple comments.
- Do not ask clarifying questions in a separate comment then answer — ask in one message if
  you need clarification.
- Do not use tool calls for the reply itself; use the comments API.
- Do not summarize what you're about to do; just do it.
```

---

## Part B — Hire the agent

Hire via the agent-hires API. Use `claude_local` adapter. Set `reportsTo: null` for a flat
org (CEO user at the top, no CEO agent).

```bash
# POST /api/companies/:companyId/agent-hires
curl -X POST "$PAPERCLIP_URL/api/companies/$COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Stan",
    "role": "stan",
    "adapterType": "claude_local",
    "reportsTo": null
  }'
# Save the returned agent id: AGENT_ID
```

**Stan's values:**
- `name`: `"Stan"`
- `role`: `"stan"`
- `adapterType`: `"claude_local"`
- `reportsTo`: `null` (flat under the Cartage CEO user)
- `companyId`: `e0a06204-2861-4125-968f-8757a4add196` (Cartage)

---

## Part C — Push the instructions bundle

Upload SOUL.md and AGENTS.md via the bundle API. Each file is one `PUT` call.
The `clearLegacyPromptTemplate` flag is safe to include; it's a no-op if no legacy prompt
exists.

```bash
# Upload AGENTS.md (entry file — loaded first on wake)
curl -X PUT "$PAPERCLIP_URL/api/agents/$AGENT_ID/instructions-bundle/file" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"AGENTS.md\",
    \"content\": $(cat AGENTS.md | jq -Rs .),
    \"clearLegacyPromptTemplate\": true
  }"

# Upload SOUL.md
curl -X PUT "$PAPERCLIP_URL/api/agents/$AGENT_ID/instructions-bundle/file" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"SOUL.md\",
    \"content\": $(cat SOUL.md | jq -Rs .)
  }"
```

Verify the bundle is set:
```bash
curl "$PAPERCLIP_URL/api/agents/$AGENT_ID/instructions-bundle" \
  -H "Authorization: Bearer $BOARD_TOKEN"
# Expect: { files: [{path: "AGENTS.md", ...}, {path: "SOUL.md", ...}] }
```

---

## Part D — Provision the Slack app

One Slack app per agent. Do this in the Slack API console (api.slack.com/apps).

### Create the app

1. **New App → From scratch.** Name it after the agent (e.g. "Stan").
2. **OAuth & Permissions → Bot Token Scopes:** add at minimum:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `reactions:write` ← required for the ack reaction (👀) on new messages
3. **Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-...`) → `STAN_BOT_TOKEN`.
4. **Basic Information → App Credentials:** copy the **Signing Secret** → `STAN_SIGNING_SECRET`.
5. **App Home → Show Tabs → Messages Tab:** enable "Allow users to send Slash commands and
   messages from the messages tab." This enables DM flow.
6. **Event Subscriptions → Enable Events:** set the Request URL to:
   ```
   https://<your-paperclip-url>/api/plugins/<PLUGIN_ID>/webhooks/slack-events
   ```
   The endpoint echoes Slack's `url_verification` challenge automatically — verification
   should pass immediately once the plugin is installed (Part E).
7. **Event Subscriptions → Subscribe to bot events:** add:
   - `app_mention`
   - `message.im`
8. **Save Changes → Reinstall app** (required after scope changes).
9. Find the bot's **Member ID** in Slack (profile → three-dot menu → Copy member ID) →
   `STAN_BOT_USER_ID`.

---

## Part E — Wire secrets and install the plugin

### Set secrets on the instance

Secrets must be set on the Paperclip environment before the plugin loads them.

```bash
# On Railway (or however secrets are managed):
STAN_BOT_TOKEN=xoxb-...
STAN_SIGNING_SECRET=...
```

**Stan's secret names:** `STAN_BOT_TOKEN`, `STAN_SIGNING_SECRET`.

### Install plugin-slack-agent

The plugin lives at `packages/plugins/examples/plugin-slack-agent` in the repo. Build it
and copy the built output to a stable path on the `/paperclip` volume, then install via the
API.

```bash
# Build the plugin (from repo root)
npx pnpm --filter @paperclipai/plugin-slack-agent build

# Install from local path (run on the instance, or provide the absolute container path)
curl -X POST "$PAPERCLIP_URL/api/plugins/install" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "/paperclip/plugins/plugin-slack-agent",
    "isLocalPath": true
  }'
# Save the returned plugin id: PLUGIN_ID
```

### Configure the plugin

Set the `agents` config array. Add one entry per agent.

```bash
curl -X PUT "$PAPERCLIP_URL/api/plugins/$PLUGIN_ID/config" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"agents\": [
      {
        \"agentId\": \"$AGENT_ID\",
        \"companyId\": \"$COMPANY_ID\",
        \"slackBotTokenRef\": \"STAN_BOT_TOKEN\",
        \"slackSigningSecretRef\": \"STAN_SIGNING_SECRET\",
        \"slackBotUserId\": \"$STAN_BOT_USER_ID\",
        \"displayName\": \"Stan\"
      }
    ]
  }"
```

**Stan's config block:**
- `agentId`: (from hire step)
- `companyId`: `e0a06204-2861-4125-968f-8757a4add196`
- `slackBotTokenRef`: `"STAN_BOT_TOKEN"`
- `slackSigningSecretRef`: `"STAN_SIGNING_SECRET"`
- `slackBotUserId`: (from Slack — `U...` format)
- `displayName`: `"Stan"`

### Verify plugin is ready

```bash
curl "$PAPERCLIP_URL/api/plugins/$PLUGIN_ID" \
  -H "Authorization: Bearer $BOARD_TOKEN"
# Expect: { status: "ready", ... }
```

---

## Part F — Update Slack Event Subscriptions URL

Now that the plugin is installed and `PLUGIN_ID` is known, update the Slack app's Event
Subscriptions Request URL to the final value:

```
https://<your-paperclip-url>/api/plugins/<PLUGIN_ID>/webhooks/slack-events
```

Slack will send a `url_verification` challenge. The endpoint echoes the challenge automatically
and the verification passes. Save and re-verify in the Slack console.

---

## Part G — Round-trip rules

These invariants keep the plugin working correctly. They apply to every agent, not just Stan.

1. **No `authorAgentId` on inbound human comments.** The plugin writes human Slack messages
   to the issue as comments without setting `authorAgentId`. If `authorAgentId` were set to
   the agent's ID, the `issue.comment.created` event listener would catch its own write and
   echo the human message back to Slack in an infinite loop.

2. **Event deduplication via `event_id`.** The plugin records seen Slack `event_id`s (capped
   at 1 000 per agent) and silently drops duplicates. Slack may redeliver on timeout.

3. **Echo path: `issue.comment.created` with `actorType==="agent"`.** When the agent posts
   a reply comment on the issue, the event listener sees it, resolves the Slack thread from
   state, and posts to `chat.postMessage`. This is the primary (EP1) path.

4. **Fallback path: `agent.run.finished` with `status==="failed"`.** If the agent run fails,
   the EP2 fallback can post an error notice. Rate-limited; EP1 is always preferred.

5. **HMAC verification.** Every inbound Slack event is verified against the agent's signing
   secret before processing. Forged signatures throw and return 502.

---

## Part H — Prove it

Run through this checklist after hire + plugin config + Slack app setup:

- [ ] Plugin status is `ready` (Part E verify step).
- [ ] `@<AgentName>` in a test channel → `👀` reaction appears → issue is created in Paperclip
  → agent wakes → reply appears in the Slack thread.
- [ ] Reply in the same thread → `👀` → agent continues the **same** issue (multi-turn).
- [ ] DM the bot → same flow as @mention.
- [ ] Send the same Slack event twice (duplicate `event_id`) → only one reply posted.
- [ ] Send a request with a forged `X-Slack-Signature` → 502 returned, no issue created.

---

## Adding a second agent later

Repeat Parts A–H for the new agent. In Part E, append a new block to the `agents` array
rather than replacing it:

```json
{
  "agents": [
    { "agentId": "<stan-id>", ... },
    { "agentId": "<new-agent-id>", "slackBotTokenRef": "NEW_AGENT_BOT_TOKEN", ... }
  ]
}
```

One plugin instance, one config update, one new Slack app.
