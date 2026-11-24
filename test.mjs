// Offline check of sync.mjs with a fake Discord API. Run: node test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sync, trackToText, MAX_FILE_BYTES, MAX_TEXT_BYTES } from './sync.mjs';

// Same bytes the game's LocalFiles.Save writes: BinaryFormatter(string base64(gzip(text))).
function mrc(text, { record = 6, trailer = [11] } = {}) {
  const b64 = Buffer.from(gzipSync(Buffer.from(text)).toString('base64'), 'latin1');
  const len = [];
  for (let n = b64.length; ; n >>= 7) { len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); if (n <= 0x7f) break; }
  return Buffer.concat([
    Buffer.from([0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0, 0, 0, 0, 0, record, 1, 0, 0, 0]),
    Buffer.from(len), b64, Buffer.from(trailer),
  ]);
}

// --- trackToText
const TRACK = '7 owner id name 0 FF\r\n{1,2} {3,4}';
assert.equal(trackToText(mrc(TRACK)), '7 owner id name 0 FF\n{1,2} {3,4}'); // .mrc → text, CRLF normalised
assert.equal(trackToText(Buffer.from(TRACK)), '7 owner id name 0 FF\n{1,2} {3,4}'); // plain .txt passes
assert.throws(() => trackToText(mrc(TRACK, { record: 9 })), /single string record/); // other record types rejected
assert.throws(() => trackToText(mrc(TRACK, { trailer: [6, 11] })), /trailing records/); // extra objects rejected
assert.throws(() => trackToText(mrc('x'.repeat(MAX_TEXT_BYTES + 1)))); // zip bomb: gunzip cap
assert.throws(() => trackToText(Buffer.from([0xff, 0xfe, 0, 1]))); // binary junk
assert.throws(() => trackToText(Buffer.from('a\0b')), /not a track/);

// --- sync against a fake Discord
const TAG = { id: 'tagA', name: 'Approved' };
let last1 = 'm1';
const thread = (id, tags, parent = 'forum') => ({
  id, name: `T${id}`, parent_id: parent, applied_tags: tags, owner_id: 'owner',
  last_message_id: id === '1' ? last1 : `m${id}`, thread_metadata: { archive_timestamp: `2026-01-0${id}` },
});
const user = (id) => ({ id, username: id, global_name: id === 'owner' ? 'Dee' : null });
const msg = (id, author, files = [], day = 1) => ({
  id, author: user(author), timestamp: `2026-01-0${day}T00:00:00Z`, edited_timestamp: null,
  reactions: [{ count: 2 }, { count: 3 }],
  attachments: files.map(([attId, filename, size = 100]) => ({ id: attId, filename, size, url: `cdn/${attId}` })),
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
      ? json({ threads: [thread('3', ['tagA']), thread('4', ['tagA']), thread('5', ['tagA'])], has_more: false })
      : json({ threads: [thread('2', [])], has_more: true });
  }
  // starters
  if (p === '/channels/1/messages/1') return json(msg('1', 'owner', [['img', 'shot.png'], [att1, 'Track.MRC']]));
  if (/^\/channels\/[345]\/messages\/[345]$/.test(p)) return json(msg(p.at(-1), 'owner'));
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
  if (p.startsWith('/channels/5/messages?')) { listCalls++; return json([msg('5b', 'owner', [['big', 'huge.mrc', MAX_FILE_BYTES + 1]], 2)]); }
  if (url.startsWith('cdn/')) {
    downloads.push(url);
    const body = url === 'cdn/a1' || url === 'cdn/a1b' ? mrc(`track ${url}`) : Buffer.from(`track ${url}`);
    return { ok: true, arrayBuffer: async () => body };
  }
  throw new Error('unexpected ' + url);
};

const out = await mkdtemp(join(tmpdir(), 'mrc-'));
await mkdir(join(out, 'tracks'));
await writeFile(join(out, 'tracks', 'stale.mrc'), 'old');
await writeFile(join(out, 'index.json'), JSON.stringify({ tracks: [{ id: '1', file: 'tracks/1.mrc', attachmentId: 'a1', lastMessageId: 'm1' }] })); // format 1 → ignored
const opts = { token: 't', guildId: 'g', forumId: 'forum', out, log: () => {} };

let tracks = await sync(opts);
const byId = Object.fromEntries(tracks.map((t) => [t.id, t]));
assert.deepEqual(Object.keys(byId).sort(), ['1', '3']); // 4: only someone else's file; 5: author's file too big
assert.equal(byId['3'].file, 'tracks/3.txt'); // author's reply, not the newer file by someone else
assert.equal(byId['1'].file, 'tracks/1.txt'); // .mrc published as text
assert.equal(byId['1'].author, 'Dee');
assert.equal(byId['1'].reactions, 5);
assert.deepEqual((await readdir(join(out, 'tracks'))).sort(), ['1.txt', '3.txt']); // stale removed
assert.equal(await readFile(join(out, 'tracks', '1.txt'), 'utf8'), 'track cdn/a1'); // decoded, re-downloaded despite old index
assert.equal(JSON.parse(await readFile(join(out, 'index.json'), 'utf8')).format, 2);

downloads.length = 0; listCalls = 0;
await sync(opts);
assert.deepEqual(downloads, []); // nothing re-downloaded
assert.equal(listCalls, 2);      // only threads with nothing published yet (4, 5) are re-scanned

att1 = 'a1b'; last1 = 'm1b';
await sync(opts);
assert.deepEqual(downloads, ['cdn/a1b']); // new message in thread 1 → rescanned, new file downloaded
assert.equal(await readFile(join(out, 'tracks', '1.txt'), 'utf8'), 'track cdn/a1b');
console.log('ok');
