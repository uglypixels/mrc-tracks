// Mirrors track files from approved Discord forum posts into site/ (served by GitHub Pages).
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://discord.com/api/v10';
const TRACK_EXT = /\.(mrc|txt)$/i;

export async function sync({ token, guildId, forumId, approvedTag = 'Approved', out = 'site', log = console.log }) {
  const api = async (path) => {
    for (;;) {
      const res = await fetch(API + path, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (mrc-tracks, 1.0)' },
      });
      if (res.status === 429) { await sleep(((await res.json()).retry_after ?? 1) * 1000); continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
      return res.json();
    }
  };

  const forum = await api(`/channels/${forumId}`);
  const tag = forum?.available_tags?.find((t) => t.name.toLowerCase() === approvedTag.toLowerCase());
  if (!tag) throw new Error(`Forum ${forumId} has no tag "${approvedTag}"`);

  const threads = new Map();
  for (const t of (await api(`/guilds/${guildId}/threads/active`)).threads)
    if (t.parent_id === forumId) threads.set(t.id, t);
  for (let before; ;) {
    const q = new URLSearchParams({ limit: '100', ...(before && { before }) });
    const page = await api(`/channels/${forumId}/threads/archived/public?${q}`);
    for (const t of page.threads) threads.set(t.id, t);
    if (!page.has_more || !page.threads.length) break;
    before = page.threads.at(-1).thread_metadata.archive_timestamp;
  }

  await mkdir(`${out}/tracks`, { recursive: true });
  const old = await readFile(`${out}/index.json`, 'utf8').then(JSON.parse, () => ({ tracks: [] }));
  const prevById = new Map(old.tracks.map((t) => [t.id, t]));
  const tracks = [];

  for (const t of threads.values()) {
    if (!t.applied_tags?.includes(tag.id)) continue;
    const prev = prevById.get(t.id);
    try {
      const starter = await api(`/channels/${t.id}/messages/${t.id}`); // forum starter msg id == thread id; null if deleted
      // Thread unchanged since last run → keep the file we picked then (saves paging long threads).
      let pick = prev && prev.lastMessageId === t.last_message_id
        ? { attachmentId: prev.attachmentId, file: prev.file, updatedAt: prev.updatedAt }
        : await pickTrack(api, t);
      if (!pick) continue;
      if (pick.att && prev?.attachmentId !== pick.attachmentId) {
        const res = await fetch(pick.att.url); // signed URL, fresh from the message fetch above
        if (!res.ok) throw new Error(`download ${res.status}`);
        await writeFile(`${out}/${pick.file}`, Buffer.from(await res.arrayBuffer()));
        log(`+ ${t.name} (${pick.file})`);
      }
      const author = (starter ?? pick.msg)?.author;
      tracks.push({
        id: t.id,
        title: t.name,
        author: author ? author.global_name ?? author.username : prev?.author ?? '',
        reactions: (starter?.reactions ?? []).reduce((s, r) => s + r.count, 0),
        file: pick.file,
        attachmentId: pick.attachmentId,
        updatedAt: pick.updatedAt,
        lastMessageId: t.last_message_id,
      });
    } catch (e) {
      // ponytail: one broken post must not block the rest; keep its last good copy
      log(`! ${t.id} ${t.name}: ${e.message}`);
      if (prev) tracks.push(prev);
    }
  }

  const keep = new Set(tracks.map((t) => t.file.slice('tracks/'.length)));
  for (const f of await readdir(`${out}/tracks`))
    if (!keep.has(f)) { await rm(`${out}/tracks/${f}`); log(`- ${f}`); }

  tracks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // generatedAt changes every run → every run commits → GitHub never disables the cron
  await writeFile(`${out}/index.json`, JSON.stringify({ generatedAt: new Date().toISOString(), tracks }, null, 1));
  return tracks;
}

// Newest track file posted by the thread's author (their updates); newest by anyone if the author posted none.
async function pickTrack(api, t) {
  let fallback;
  for (let before; ;) {
    const q = new URLSearchParams({ limit: '100', ...(before && { before }) });
    const page = await api(`/channels/${t.id}/messages?${q}`); // newest first
    if (!page?.length) break;
    for (const msg of page) {
      const att = msg.attachments?.find((a) => TRACK_EXT.test(a.filename));
      if (!att) continue;
      const pick = {
        msg, att, attachmentId: att.id,
        file: `tracks/${t.id}.${att.filename.match(TRACK_EXT)[1].toLowerCase()}`,
        updatedAt: msg.edited_timestamp ?? msg.timestamp,
      };
      if (msg.author.id === t.owner_id) return pick;
      fallback ??= pick;
    }
    if (page.length < 100) break;
    before = page.at(-1).id;
  }
  return fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID, APPROVED_TAG } = process.env;
  if (!DISCORD_TOKEN || !GUILD_ID || !FORUM_CHANNEL_ID) throw new Error('Set DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID');
  const tracks = await sync({ token: DISCORD_TOKEN, guildId: GUILD_ID, forumId: FORUM_CHANNEL_ID, approvedTag: APPROVED_TAG || undefined });
  console.log(`${tracks.length} tracks`);
}
