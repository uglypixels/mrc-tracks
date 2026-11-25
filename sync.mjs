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
  const skipped = []; // approved threads not (or no longer freshly) published, with why: public, for moderators

  for (const t of threads.values()) {
    if (!t.applied_tags?.includes(tag.id)) continue;
    const prev = prevById.get(t.id);
    const skip = (reason) => { skipped.push({ id: t.id, title: t.name, reason }); log(`? ${t.name}: ${reason}`); };
    try {
      const starter = await api(`/channels/${t.id}/messages/${t.id}`); // forum starter msg id == thread id; null if deleted
      const file = `tracks/${t.id}.txt`;
      let pick;
      if (prev && prev.lastMessageId === t.last_message_id) {
        // Thread unchanged since last run → keep the file we picked then (saves paging long threads).
        pick = { attachmentId: prev.attachmentId, updatedAt: prev.updatedAt };
      } else {
        const problems = [];
        for await (const cand of authorFiles(api, t, starter)) {
          if (cand.attachmentId === prev?.attachmentId) { pick = cand; break; } // already published
          try {
            const res = await fetch(cand.att.url); // signed URL, fresh from the message fetch
            if (!res.ok) throw new Error(`download ${res.status}`);
            const bytes = Buffer.from(await res.arrayBuffer());
            if (bytes.length > MAX_FILE_BYTES) throw new Error(`too big (${bytes.length} B)`);
            await writeFile(`${out}/${file}`, trackToText(bytes));
            log(`+ ${t.name} (${cand.att.filename} → ${file})`);
            pick = cand;
            break;
          } catch (e) {
            problems.push(`${cand.att.filename}: ${e.message}`); // e.g. a chat message.txt: try the author's older files
          }
        }
        if (!pick) {
          skip(problems.length ? `no usable track file (${problems.slice(0, 3).join('; ')})` : 'no .mrc/.txt file posted by the author');
          continue;
        }
      }
      const author = starter?.author ?? pick.msg?.author;
      tracks.push({
        id: t.id,
        title: t.name,
        author: author ? authorName(author) : prev?.author ?? '',
        reactions: (starter?.reactions ?? []).reduce((s, r) => s + r.count, 0),
        file,
        attachmentId: pick.attachmentId,
        updatedAt: pick.updatedAt,
        lastMessageId: t.last_message_id,
      });
    } catch (e) {
      // ponytail: one broken post must not block the rest; keep its last good copy
      skip(`error: ${e.message}${prev ? ' (kept last good copy)' : ''}`);
      if (prev) tracks.push(prev);
    }
  }
  await writeFile(`${out}/skipped.json`, JSON.stringify(skipped, null, 1));

  const keep = new Set(tracks.map((t) => t.file.slice('tracks/'.length)));
  for (const f of await readdir(`${out}/tracks`))
    if (!keep.has(f)) { await rm(`${out}/tracks/${f}`); log(`- ${f}`); }

  tracks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // generatedAt changes every run → every run commits → GitHub never disables the cron
  await writeFile(`${out}/index.json`, JSON.stringify({ format: FORMAT, generatedAt: new Date().toISOString(), tracks }, null, 1));
  return tracks;
}

// Track files posted by the thread's author, newest first (their updates come first). Files from anyone else are
// never published. "Author" = thread owner_id or whoever posted the starter message: a deleted account's messages
// carry Discord's placeholder user id, which no longer matches owner_id.
async function* authorFiles(api, t, starter) {
  const authors = new Set([t.owner_id, starter?.author?.id].filter(Boolean));
  let tried = 0;
  for (let before; ;) {
    const q = new URLSearchParams({ limit: '100', ...(before && { before }) });
    const page = await api(`/channels/${t.id}/messages?${q}`); // newest first
    if (!page?.length) return;
    for (const msg of page) {
      if (!authors.has(msg.author.id)) continue;
      for (const att of msg.attachments ?? []) {
        if (!TRACK_EXT.test(att.filename) || att.size > MAX_FILE_BYTES) continue;
        if (++tried > 5) return; // ponytail: cap downloads per thread per run
        yield { msg, att, attachmentId: att.id, updatedAt: msg.edited_timestamp ?? msg.timestamp };
      }
    }
    if (page.length < 100) return;
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
    text = gunzipBase64(bytes.subarray(p, p + len).toString('latin1'));
  } else {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // throws on binary junk
    // Same payload without the .mrc wrapper, e.g. pasted into Discord (long pastes become message.txt).
    const t = text.trim();
    if (t.startsWith('H4sI') && /^[A-Za-z0-9+/=\s]+$/.test(t)) text = gunzipBase64(t);
  }
  if (text.length === 0 || text.includes('\0')) throw new Error('not a track file');
  if (!/^\d+ \S+ \S+/.test(text)) throw new Error('not a track file (no track header)');
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('track text too big');
  return text.replace(/\r\n/g, '\n');
}

// Deleted accounts: placeholder id 456226577798135808, name "Deleted User" (or deleted_user_<hex>).
function authorName(a) {
  const deleted = a.id === '456226577798135808' || /^deleted[ _]user/i.test(a.username ?? '') || a.global_name === 'Deleted User';
  return deleted ? 'Former Community Member' : a.global_name ?? a.username;
}

function gunzipBase64(b64) {
  // throws past the cap (zip bomb)
  return gunzipSync(Buffer.from(b64.replace(/\s+/g, ''), 'base64'), { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID, APPROVED_TAG } = process.env;
  if (!DISCORD_TOKEN || !GUILD_ID || !FORUM_CHANNEL_ID) throw new Error('Set DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID');
  const tracks = await sync({ token: DISCORD_TOKEN, guildId: GUILD_ID, forumId: FORUM_CHANNEL_ID, approvedTag: APPROVED_TAG || undefined });
  console.log(`${tracks.length} tracks`);
}
