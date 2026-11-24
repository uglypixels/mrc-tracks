// Mirrors track files from approved Discord forum posts into site/ (served by GitHub Pages).
// Every track is published as plain text: the game never runs its BinaryFormatter on downloaded bytes.
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const API = 'https://discord.com/api/v10';
const TRACK_EXT = /\.(mrc|txt)$/i;
const FORMAT = 2; // bump when the published file format changes → every track is re-downloaded
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // attachment as posted
export const MAX_TEXT_BYTES = 8 * 1024 * 1024; // track text after decompression (game enforces the same)

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
  const old = await readFile(`${out}/index.json`, 'utf8').then(JSON.parse, () => ({}));
  const prevById = new Map(old.format === FORMAT ? old.tracks.map((t) => [t.id, t]) : []);
  const tracks = [];

  for (const t of threads.values()) {
    if (!t.applied_tags?.includes(tag.id)) continue;
    const prev = prevById.get(t.id);
    try {
      const starter = await api(`/channels/${t.id}/messages/${t.id}`); // forum starter msg id == thread id; null if deleted
      // Thread unchanged since last run → keep the file we picked then (saves paging long threads).
      const pick = prev && prev.lastMessageId === t.last_message_id
        ? { attachmentId: prev.attachmentId, updatedAt: prev.updatedAt }
        : await pickTrack(api, t);
      if (!pick) continue;
      const file = `tracks/${t.id}.txt`;
      if (pick.att && prev?.attachmentId !== pick.attachmentId) {
        const res = await fetch(pick.att.url); // signed URL, fresh from the message fetch above
        if (!res.ok) throw new Error(`download ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`file too big (${bytes.length} B)`);
        await writeFile(`${out}/${file}`, trackToText(bytes));
        log(`+ ${t.name} (${file})`);
      }
      const author = starter?.author ?? pick.msg?.author;
      tracks.push({
        id: t.id,
        title: t.name,
        author: author ? author.global_name ?? author.username : prev?.author ?? '',
        reactions: (starter?.reactions ?? []).reduce((s, r) => s + r.count, 0),
        file,
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
  await writeFile(`${out}/index.json`, JSON.stringify({ format: FORMAT, generatedAt: new Date().toISOString(), tracks }, null, 1));
  return tracks;
}

// Newest track file posted by the thread's author (their updates). Files from anyone else are never published.
async function pickTrack(api, t) {
  for (let before; ;) {
    const q = new URLSearchParams({ limit: '100', ...(before && { before }) });
    const page = await api(`/channels/${t.id}/messages?${q}`); // newest first
    if (!page?.length) return null;
    for (const msg of page) {
      if (msg.author.id !== t.owner_id) continue;
      const att = msg.attachments?.find((a) => TRACK_EXT.test(a.filename) && a.size <= MAX_FILE_BYTES);
      if (att) return { msg, att, attachmentId: att.id, updatedAt: msg.edited_timestamp ?? msg.timestamp };
    }
    if (page.length < 100) return null;
    before = page.at(-1).id;
  }
}

// Saved .mrc = .NET BinaryFormatter stream holding ONE string: base64(gzip(track text)).
// Parse exactly that record layout (no general deserializer); anything else must already be plain UTF-8 text.
export function trackToText(bytes) {
  const HEADER = Buffer.from([0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0, 0, 0, 0, 0]);
  let text;
  if (bytes.subarray(0, HEADER.length).equals(HEADER)) {
    let p = HEADER.length;
    if (bytes[p++] !== 6) throw new Error('mrc: expected a single string record'); // BinaryObjectString
    p += 4; // object id
    let len = 0;
    for (let shift = 0; ; shift += 7) { // 7-bit encoded length
      if (shift > 28) throw new Error('mrc: bad string length');
      const b = bytes[p++];
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    if (p + len + 1 !== bytes.length || bytes[p + len] !== 11) throw new Error('mrc: unexpected trailing records'); // MessageEnd
    const gz = Buffer.from(bytes.subarray(p, p + len).toString('latin1'), 'base64');
    text = gunzipSync(gz, { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8'); // throws past the cap (zip bomb)
  } else {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // throws on binary junk
  }
  if (text.length === 0 || text.includes('\0')) throw new Error('not a track file');
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('track text too big');
  return text.replace(/\r\n/g, '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID, APPROVED_TAG } = process.env;
  if (!DISCORD_TOKEN || !GUILD_ID || !FORUM_CHANNEL_ID) throw new Error('Set DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID');
  const tracks = await sync({ token: DISCORD_TOKEN, guildId: GUILD_ID, forumId: FORUM_CHANNEL_ID, approvedTag: APPROVED_TAG || undefined });
  console.log(`${tracks.length} tracks`);
}
