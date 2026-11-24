# mrc-tracks

Every 30 minutes, a GitHub Action copies Marble Race Creator tracks from Discord forum posts that have the **Approved** tag into `site/`, then publishes them with GitHub Pages.

- `index.json` — `{ generatedAt, tracks: [{ id, title, author, reactions, file, attachmentId, updatedAt }] }`, newest first
- `tracks/<threadId>.mrc|.txt` — the first track file in each approved post. It is downloaded again when the post's file changes.

The game reads `https://<user>.github.io/mrc-tracks/index.json` and downloads the `file` paths relative to it.

## Setup

1. **Discord bot** ([developer portal](https://discord.com/developers/applications)): create a new application, then go to **Bot**.
   - Turn on **Message Content Intent**. Without it, the bot can't see attachments.
   - Copy the bot token.
   - Under **OAuth2 › URL Generator**, pick the `bot` scope with **View Channels** and **Read Message History**, then use the generated URL to invite the bot to your server.
2. **Forum**: create an `Approved` tag on the forum channel. Mods add this tag to a post to publish it.
3. **IDs**: in Discord, turn on Developer Mode. Then right-click the server → Copy Server ID, and right-click the forum → Copy Channel ID.
4. **GitHub repo** (public):
   - Settings › Secrets and variables › Actions:
     - Secret `DISCORD_TOKEN`
     - Variables `GUILD_ID` and `FORUM_CHANNEL_ID`
     - Optional variable `APPROVED_TAG`, if your tag isn't named `Approved`
   - Settings › Pages › Source: **GitHub Actions**
   - Actions › sync › **Run workflow** for the first run.

## Local

```sh
node test.mjs                       # offline check, fake Discord API
DISCORD_TOKEN=… GUILD_ID=… FORUM_CHANNEL_ID=… node sync.mjs   # writes ./site
```
