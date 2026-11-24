// Offline check of sync.mjs with a fake Discord API. Run: node test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sync } from './sync.mjs';

const TAG = { id: 'tagA', name: 'Approved' };
const thread = (id, tags, parent = 'forum') => ({ id, name: `T${id}`, parent_id: parent, applied_tags: tags, thread_metadata: { archive_timestamp: `2026-01-0${id}` } });
const msg = (id, attId, file) => ({
  author: { username: 'u', global_name: id === '1' ? 'Dee' : null },
  timestamp: `2026-01-0${id}T00:00:00Z`, edited_timestamp: null,
  reactions: [{ count: 2 }, { count: 3 }],
  attachments: [{ id: 'img', filename: 'shot.png', url: 'x' }, { id: attId, filename: file, url: `cdn/${attId}` }],
});

let att1 = 'a1';
const downloads = [];
globalThis.fetch = async (url) => {
  const json = (b) => ({ ok: true, status: 200, json: async () => b });
  const p = url.replace('https://discord.com/api/v10', '');
  if (p === '/channels/forum') return json({ available_tags: [TAG] });
  if (p === '/guilds/g/threads/active') return json({ threads: [thread('1', ['tagA']), thread('9', ['tagA'], 'other')] });
  if (p.startsWith('/channels/forum/threads/archived/public')) {
    return p.includes('before') // second page
      ? json({ threads: [thread('3', ['tagA'])], has_more: false })
      : json({ threads: [thread('2', [])], has_more: true });
  }
  if (p === '/channels/1/messages/1') return json(msg('1', att1, 'Track.MRC'));
  if (p === '/channels/3/messages/3') return json(msg('3', 'a3', 'b.txt'));
  if (url.startsWith('cdn/')) { downloads.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer }; }
  throw new Error('unexpected ' + url);
};

const out = await mkdtemp(join(tmpdir(), 'mrc-'));
await mkdir(join(out, 'tracks'));
await writeFile(join(out, 'tracks', 'stale.mrc'), 'old');
const opts = { token: 't', guildId: 'g', forumId: 'forum', out, log: () => {} };

let tracks = await sync(opts);
assert.deepEqual(tracks.map((t) => t.id), ['3', '1']); // approved only, right forum, both pages, newest first
assert.equal(tracks.find((t) => t.id === '1').author, 'Dee');
assert.equal(tracks.find((t) => t.id === '3').author, 'u');
assert.equal(tracks[0].reactions, 5);
assert.equal(tracks[0].file, 'tracks/3.txt');
assert.deepEqual((await readdir(join(out, 'tracks'))).sort(), ['1.mrc', '3.txt']); // stale removed
assert.equal(await readFile(join(out, 'tracks', '1.mrc'), 'utf8'), 'cdn/a1');

downloads.length = 0;
await sync(opts);
assert.deepEqual(downloads, []); // unchanged attachments not re-downloaded

att1 = 'a1b';
await sync(opts);
assert.deepEqual(downloads, ['cdn/a1b']); // edited post re-downloaded
assert.equal(JSON.parse(await readFile(join(out, 'index.json'), 'utf8')).tracks.length, 2);
console.log('ok');
