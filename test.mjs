// Offline check of sync.mjs with a fake Discord API. Run: node test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sync } from './sync.mjs';

const TAG = { id: 'tagA', name: 'Approved' };
let last1 = 'm1';
const thread = (id, tags, parent = 'forum') => ({
  id, name: `T${id}`, parent_id: parent, applied_tags: tags, owner_id: 'owner',
  last_message_id: id === '1' ? last1 : `m${id}`, thread_metadata: { archive_timestamp: `2026-01-0${id}` },
});
const user = (id, name) => ({ id, username: name, global_name: id === 'owner' ? 'Dee' : null });
const msg = (id, author, files = [], day = 1) => ({
  id, author: user(author, author), timestamp: `2026-01-0${day}T00:00:00Z`, edited_timestamp: null,
  reactions: [{ count: 2 }, { count: 3 }],
  attachments: files.map(([attId, filename]) => ({ id: attId, filename, url: `cdn/${attId}` })),
});

let att1 = 'a1';
const downloads = [];
let listCalls = 0;
globalThis.fetch = async (url) => {
  const json = (b) => ({ ok: true, status: 200, json: async () => b });
  const p = url.replace('https://discord.com/api/v10', '');
  if (p === '/channels/forum') return json({ available_tags: [TAG] });
  if (p === '/guilds/g/threads/active') return json({ threads: [thread('1', ['tagA']), thread('9', ['tagA'], 'other')] });
  if (p.startsWith('/channels/forum/threads/archived/public')) {
    return p.includes('before') // second page
      ? json({ threads: [thread('3', ['tagA']), thread('4', ['tagA'])], has_more: false })
      : json({ threads: [thread('2', [])], has_more: true });
  }
  // starters
  if (p === '/channels/1/messages/1') return json(msg('1', 'owner', [['img', 'shot.png'], [att1, 'Track.MRC']]));
  if (p === '/channels/3/messages/3') return json(msg('3', 'owner', [['img3', 'shot.png']]));
  if (p === '/channels/4/messages/4') return json(msg('4', 'owner'));
  // thread histories, newest first
  if (p.startsWith('/channels/1/messages?')) { listCalls++; return json([msg('1', 'owner', [[att1, 'Track.MRC']])]); }
  if (p.startsWith('/channels/3/messages?')) {
    listCalls++;
    return json([
      msg('3c', 'someone', [['x3', 'remix.mrc']], 5), // newer, but not the author
      msg('3b', 'owner', [['a3', 'b.txt']], 4),       // author's update → picked
      msg('3', 'owner', [['img3', 'shot.png']], 3),
    ]);
  }
  if (p.startsWith('/channels/4/messages?')) { listCalls++; return json([msg('4b', 'someone', [['x4', 'only.mrc']], 2), msg('4', 'owner')]); }
  if (url.startsWith('cdn/')) { downloads.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer }; }
  throw new Error('unexpected ' + url);
};

const out = await mkdtemp(join(tmpdir(), 'mrc-'));
await mkdir(join(out, 'tracks'));
await writeFile(join(out, 'tracks', 'stale.mrc'), 'old');
const opts = { token: 't', guildId: 'g', forumId: 'forum', out, log: () => {} };

let tracks = await sync(opts);
const byId = Object.fromEntries(tracks.map((t) => [t.id, t]));
assert.deepEqual(Object.keys(byId).sort(), ['1', '3', '4']); // approved only, right forum, both pages
assert.equal(byId['3'].file, 'tracks/3.txt'); // author's reply, not the newer file by someone else
assert.equal(byId['4'].file, 'tracks/4.mrc'); // author posted no file → newest by anyone
assert.equal(byId['1'].author, 'Dee');
assert.equal(byId['1'].reactions, 5);
assert.deepEqual((await readdir(join(out, 'tracks'))).sort(), ['1.mrc', '3.txt', '4.mrc']); // stale removed
assert.equal(await readFile(join(out, 'tracks', '1.mrc'), 'utf8'), 'cdn/a1');

downloads.length = 0; listCalls = 0;
await sync(opts);
assert.deepEqual(downloads, []); // nothing re-downloaded
assert.equal(listCalls, 0);      // unchanged threads not re-scanned

att1 = 'a1b'; last1 = 'm1b';
await sync(opts);
assert.deepEqual(downloads, ['cdn/a1b']); // new message in thread 1 → rescanned, new file downloaded
assert.equal(listCalls, 1);
assert.equal(JSON.parse(await readFile(join(out, 'index.json'), 'utf8')).tracks.length, 3);
console.log('ok');
