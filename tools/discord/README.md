# A-Identity Discord — automated setup

One command builds the whole server: roles, categories, channels, permissions, AutoMod
rules, the welcome screen, onboarding prompts and the pinned welcome / announcement /
roadmap content. It is **idempotent** — everything is matched by name and only created
when missing, so re-running is always safe and is the normal way to apply a change.

```bash
cd tools/discord
npm install
cp .env.sample .env      # fill DISCORD_BOT_TOKEN + GUILD_ID
npm run setup:dry        # preview, writes nothing
npm run setup
```

Four files, split so the description of the server is separate from the code that
applies it:

| File | What it is |
|---|---|
| `config.mjs` | The server as data: roles, channels, AutoMod inputs, pinned copy. **Edit this.** |
| `setup.mjs` | Applies the config to Discord. Idempotent. |
| `validate.mjs` | Checks the config against Discord's limits offline. Runs automatically before setup. |
| `whoami.mjs` | `npm run whoami` — is the token valid, which servers is the bot in, what is the GUILD_ID |
| `announce.mjs` | Posts an announcement from a text file. For whoever handles comms. |

`npm run setup` runs the validator first and refuses to touch Discord if it fails. A
live run is a bad place to find a typo: half the config lands, the run throws, and you
reconcile a half-built server by hand.

The check that earns its keep: **Discord silently rewrites text and forum channel names
to lowercase-with-hyphens.** Name a channel `Mod Log` and Discord creates `mod-log`, so
the next run looks for `Mod Log`, does not find it, and creates a second channel. Every
time. Idempotency depends on the name you write being the name Discord keeps, and the
validator refuses any name that would not survive.

## 1. Create the bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New
   Application** → name it `A-Identity`.
2. **Bot** → **Reset Token** → copy it into `.env` as `DISCORD_BOT_TOKEN`.
   The token is a full write credential for the server. It belongs in `.env` and
   nowhere else: not in a commit, not in a doc, not pasted into a chat. If it ever
   leaves that file, reset it in the portal.
3. **Installation** → uncheck any Public install if you do not want others adding it.
4. Invite it, replacing `YOUR_APP_ID` with the Application ID from **General
   Information**:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=8
   ```

   `permissions=8` is Administrator, which is the simplest way to make the first run
   work. **Then take it away.** A setup bot has no business holding admin permanently:
   after the run, Server Settings → Roles → the bot's role → turn Administrator off.
   If you prefer to never grant it, use the scoped set instead and expect a couple of
   warnings on things it cannot reach:

   ```
   ...&permissions=275683339376
   ```

   That is Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Manage
   Messages, View Channels, Send Messages, Send in Threads, Read History, Add
   Reactions, Attach Files, Embed Links.

5. Get the server id: Discord → Settings → Advanced → **Developer Mode** on, then
   right-click the server → **Copy Server ID** → `GUILD_ID` in `.env`.

### When something goes wrong

```bash
npm run whoami
```

It prints the bot, every server it is in with the `GUILD_ID` line ready to paste, whether
it has admin, and which permission it is missing if any. It never prints the token.

`DiscordAPIError[10004]: Unknown Guild` is the first error nearly everyone hits, and the
API text explains nothing. There are exactly three causes:

1. **`GUILD_ID` holds the Application ID.** Both are 18-19 digit snowflakes and look
   identical, so this is the usual one. The Application ID is on the General Information
   page; the server id comes from right-clicking the server itself.
2. The bot was never invited.
3. The token belongs to a different application than the invite did.

`setup.mjs` catches that error and says all three rather than printing a stack trace.

## 2. What it builds

**Roles**, highest first:

| Role | Notes |
|---|---|
| Core Team | Administrator, hoisted |
| Moderator | **Not** an admin. Manage Messages, Timeout, Kick, Manage Threads, Audit Log |
| Partner | Circle / Arc, OKX, Stellar and other ecosystem contacts |
| Contributor | Pull requests, issues, spec work |
| Builder | Integrating A-Identity |
| Agent Owner | Runs an agent under guardrails, the end-user segment |
| Guardrails · Arc / Circle · OKX / X Layer · MCP / x402 · Stellar · Announcements | Self-assign, picked in onboarding |

Two choices worth knowing about, because they look like oversights and are not:

- **Moderator is not an administrator.** It gets exactly what moderation needs. Admin on
  a moderation role means one compromised moderator account is a compromised server,
  which is how most project Discords are actually lost.
- **No role is called "Verified".** A-Identity's product has KYA verification, and a
  Discord role with that name would read as a claim about an agent's real verification
  status. `Builder` and `Agent Owner` say what they mean and claim nothing.

**Channels**

- **START HERE** (read-only) — `#welcome` (rules + the security rule), `#announcements`
  (announcement channel), `#roadmap`
- **COMMUNITY** — `#general`, `#introductions`, `#showcase`, `#off-topic`
- **BUILD** — `#dev`, `#guardrails`, `#mcp-and-x402`, `#arc-and-circle`, `#okx-x-layer`,
  `#feedback`
- **SUPPORT** — `#help`, a **forum** channel with tags (guardrails, setup, mcp / x402,
  arc / circle, okx, bug, answered)
- **FEEDS** (read-only) — `#git-feed`, `#status`, each with a webhook the script prints
- **STAFF** (hidden) — `#mod-log` (AutoMod alerts land here), `#staff-chat`
- **VOICE** — Community, Office Hours

Read-only channels also deny **Attach Files** and **Embed Links** to `@everyone`. That
is not tidiness: a read-only channel that still accepts an image is a place to post a
screenshot of a fake announcement, which is the scam format that actually works now.

## 3. Security posture, and what it does not cover

The five AutoMod rules the script creates:

| Rule | What it does |
|---|---|
| scam and drainer phrases | Blocks ~25 phrases that appear in wallet-drainer and impersonation attempts and essentially never in real conversation here ("seed phrase", "connect your wallet", "claim your airdrop", "dm me", …). Alerts `#mod-log`. |
| mention spam | Blocks messages with more than 5 mentions, mention-raid protection on |
| spam | Discord's spam classifier |
| commonly flagged words | Profanity, sexual content, slurs |
| impersonation in names | Usernames containing `a-identity`, `admin`, `moderator`, `support`, `official`, `team` are blocked from interacting at all, at the profile, before they can talk to anyone |

Core Team and Moderator are exempt from all of them, so nobody gets blocked while
explaining an attack in `#guardrails`.

**The honest limit: AutoMod reads text.** The dominant Discord scam vector is now an
image — a screenshot of a fake announcement, a QR code to a drainer — and not one of
those rules can see it. What actually helps there is the pinned "we never DM you first"
rule, the join gate, and Discord's own raid protection. Which brings us to:

### Four things a bot cannot do, so do them once by hand

1. **Server Settings → Safety Setup**: turn on **Raid Protection** and the
   **suspicious links** filter. Neither is exposed to bots, and the link filter is the
   only control that catches drainer domains nobody has seen before.
2. **Server Settings → Moderation**: **require 2FA for moderators**. Owner-only
   endpoint, so the script cannot set it.
3. **Paste the webhook URLs** the script prints (see below).
4. **Server banner** needs Level 2 boosts. Upload `public/og-image.png` by hand once
   the server is boosted.

Two more, for whoever owns the server:

- Keep the **server owner account** separate from the account you use daily, with an
  authenticator app rather than SMS.
- Review **Server Settings → Integrations** occasionally. Webhooks are write
  credentials, and an old unused one is a liability, not a leftover.

### The join gate

`VERIFICATION=high` by default: verified email, 5 minutes on Discord, 10 minutes in the
server. The security write-ups recommend the highest level (verified phone) for anything
finance-adjacent, which this is. It is not the default because phone verification turns
real people away and an empty server protects nobody. Move to `VERIFICATION=highest` and
re-run once the server is large enough to be worth attacking.

## 4. Wiring the two feeds

The script prints a webhook URL for each feed channel, once, when it creates it. If you
missed them: Server Settings → Integrations → Webhooks.

**`#git-feed`** — GitHub → repo Settings → Webhooks → New webhook. Paste the URL with
`/github` appended, content type `application/json`, and pick the events you want
(pushes, pull requests, releases).

**`#status`** — this one is the reason the server looks alive without anyone posting.
The hourly guardrail canary already runs in CI; add the webhook URL as the repository
secret `DISCORD_STATUS_WEBHOOK`, then add this step to
`.github/workflows/guardrail-canary.yml` after the self-check:

```yaml
      - name: Report to Discord
        if: env.HOOK != ''
        env:
          HOOK: ${{ secrets.DISCORD_STATUS_WEBHOOK }}
        run: |
          node -e "
            const s = require('/tmp/status.json');
            const passed = (s.vectors || []).filter(v => v.pass).length;
            const body = {
              embeds: [{
                title: s.enforcing ? 'Guardrail enforcing' : 'Guardrail NOT enforcing',
                description: passed + '/' + (s.vectors || []).length + ' decision vectors passed',
                color: s.enforcing ? 0x1aab7a : 0xdc2626,
                timestamp: s.checkedAt,
              }],
            };
            fetch(process.env.HOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }).then(r => console.log('discord:', r.status));
          "
```

It posts the real output of the real engine every hour. That is worth more than a badge,
because a badge can be stale and this cannot.

## 5. Posting an announcement

For whoever handles comms. No code, no Discord UI.

```bash
# post.md: first line is the title, the rest is the body
node announce.mjs --file post.md --dry        # preview
node announce.mjs --file post.md --pin --publish --ping
```

`--pin` keeps exactly one announcement pinned and unpins the previous one. `--publish`
pushes it to servers following the channel. `--ping` mentions the self-assign
**Announcements** role, and is opt-in because a ping nobody asked for is how a server
gets muted.

**One editorial rule.** Do not put user counts, decision counts or protected-value
figures in an announcement unless you just read them from
`https://a-identity-backend.onrender.com/api/traction`. Those numbers are currently
zero and the product says so on its own site. A figure a reader cannot reproduce is the
one thing that costs more trust than it buys.

## 6. Changing the server later

Edit `config.mjs`, run `npm run setup` again.

- `ROLES` — roles, colors, hierarchy
- `TREE` — categories, channels, topics, read-only and private flags
- `SCAM_PHRASES` / `IMPERSONATION_PATTERNS` — AutoMod inputs
- the `*Embed` objects — pinned copy

The onboarding prompts live in `setupOnboarding` in `setup.mjs`, because they reference
roles and channels by key rather than being pure data. The validator cross-checks those
references anyway: if a prompt points at a channel or role the config never creates, it
fails before the run.

**Renaming is the one thing to be careful with.** The script matches by name, so
renaming in `config.mjs` reads as "create a new one" and leaves the old one behind.
Rename it in Discord first, then in the config.

Editing pinned copy has the same shape: a pin is recognized by its footer marker, so
changing an embed's text does **not** update the existing pin. Delete the old pinned
message in Discord, then re-run.
