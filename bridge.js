#!/usr/bin/env node
/**
 * 酷狗「一起听 / 众乐房」MCP 桥
 *
 * 让小号真的待在房间里：进房 + 定时心跳 + 点歌 + 切歌 + 暂停 / 拖进度。
 * 直接挂在 KuGouMusicApi 的同一个 Express 进程里，只占一个端口、一个容器。
 *
 * 启动：node bridge.js
 * 必需环境变量：platform=lite（概念版），否则一起听接口不可用
 * 可选环境变量：
 *   PORT          监听端口（默认 3000）
 *   MCP_TOKEN     /mcp 的访问口令，强烈建议设置
 *   KUGOU_DATA_DIR 登录态存放目录（默认 ./data，建议挂持久卷）
 *   KUGOU_COOKIE  直接把 cookie 写死（"token=xxx; userid=yyy"），可不走扫码
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.KUGOU_DATA_DIR || path.join(process.cwd(), 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const MCP_TOKEN = (process.env.MCP_TOKEN || '').trim();
const BIZ_MUSIC_ROOM = '1009';
const PROTOCOL_VERSION = '2025-06-18';

const base = () => `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;

/* ------------------------------------------------------------------ cookie */

let jar = {};
let room = null; // { groupid, biz } —— 小号当前所在的房间

function loadSession() {
  try {
    if (process.env.KUGOU_COOKIE) {
      for (const pair of process.env.KUGOU_COOKIE.split(/;\s+/)) {
        const i = pair.indexOf('=');
        if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      return;
    }
    if (fs.existsSync(SESSION_FILE)) {
      jar = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('[bridge] 读取登录态失败', e.message);
  }
}

function saveSession() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(jar), 'utf8');
  } catch (e) {
    console.error('[bridge] 保存登录态失败（没挂持久卷时正常）', e.message);
  }
}

const cookieHeader = () =>
  Object.entries(jar)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

function absorbSetCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let changed = false;
  for (const raw of list) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (!k) continue;
    if (jar[k] !== v) changed = true;
    jar[k] = v;
  }
  if (changed) saveSession();
}

function loggedIn() {
  return typeof jar.token === 'string' && jar.token.length > 4 && jar.userid;
}

/* ---------------------------------------------------------------- upstream */

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`)
    .join('&');
}

/** 调本地 KuGouMusicApi。所有请求都带 timestamp，避免撞上 2 分钟缓存。 */
async function kg(route, params = {}) {
  const paramsWithStamp = { ...params, timestamp: `${Date.now()}${Math.floor(Math.random() * 900)}` };
  const res = await fetch(`${base()}${route}?${qs(paramsWithStamp)}`, {
    headers: Object.keys(jar).length ? { cookie: cookieHeader() } : {},
    signal: AbortSignal.timeout(15000),
  });
  absorbSetCookie(res);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`上游返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (body && body.status !== undefined && body.status !== 1) {
    const msg = body.error_msg || body.msg || (body.data && body.data.msg) || '未知错误';
    throw new Error(`酷狗返回失败：${msg}${body.error_code ? `（code ${body.error_code}）` : ''}`);
  }
  return body;
}

async function kgTogether(domain, operation, params = {}) {
  const body = await kg(`/listen/together/${domain}`, { operation, biz: BIZ_MUSIC_ROOM, ...params });
  return body;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function deepFindArray(obj, keys, depth = 0) {
  if (!obj || depth > 4) return null;
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = deepFindArray(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/* ------------------------------------------------------------------- tools */

async function searchSongs(keyword, limit = 5) {
  const body = await kg('/search', { keywords: keyword, pagesize: Math.min(Number(limit) || 5, 20) });
  const lists = deepFindArray(body, ['lists', 'songs', 'list']) || [];
  return lists.slice(0, limit).map((s) => ({
    name: pick(s, ['SongName', 'songname', 'name']),
    singer: pick(s, ['SingerName', 'singername', 'singer']),
    hash: pick(s, ['FileHash', 'filehash', 'hash']),
    mixsongid: String(pick(s, ['MixSongID', 'mixsongid', 'EMixSongID']) ?? ''),
    duration: pick(s, ['Duration', 'duration']),
  }));
}

async function resolveSong(args) {
  if (args.hash) return { hash: args.hash, mixsongid: String(args.mixsongid ?? '') };
  if (!args.keyword) throw new Error('要给出 keyword（歌名/歌手）或者 hash');
  const found = await searchSongs(args.keyword, 3);
  if (!found.length) throw new Error(`搜不到「${args.keyword}」`);
  return found[0];
}

function requireRoom() {
  if (!room) throw new Error('小号还没进房间。先调 room_create 建房，或 room_join 加入房间。');
  return room;
}

const tools = [
  {
    name: 'login_status',
    description: '查看小号是否已登录酷狗概念版，返回昵称和 userid。没登录时先打开浏览器访问 /kt/login 扫码。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      if (!loggedIn()) return { logged_in: false, tip: '未登录：请在浏览器打开 https://你的域名/kt/login 用酷狗概念版 App 扫码' };
      const body = await kg('/user/detail');
      const d = body.data || {};
      return { logged_in: true, userid: jar.userid, nickname: pick(d, ['nickname', 'nick_name', 'user_name', 'kugouid']) || null };
    },
  },
  {
    name: 'search_song',
    description: '按歌名/歌手搜歌，拿到 hash 和 mixsongid。点歌、切歌前不确定是哪一首时先搜。',
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '歌名或「歌手 歌名」' }, limit: { type: 'number', description: '返回条数，默认 5' } },
      required: ['keyword'],
    },
    run: async (a) => searchSongs(a.keyword, a.limit || 5),
  },
  {
    name: 'room_create',
    description: '用小号在酷狗众乐房里建一个「一起听」房间，建完自动开始心跳，小号就一直在房间里。房间号返回给用户，用户在酷狗 App 里进同一个房间。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '房间名，可以写「和 Kelivo 一起听」' },
        privacy: { type: 'number', description: '3=私密（默认，容量 5 人），1=公开（会出现在房间列表）' },
      },
    },
    run: async (a) => {
      if (!loggedIn()) throw new Error('小号未登录，先去 /kt/login 扫码');
      const body = await kgTogether('room', 'create', {
        room_name: a.name || '一起听',
        room_privacy: a.privacy === 1 ? 1 : 3,
        capacity: 5,
      });
      const d = body.data || {};
      const gid = pick(d, ['groupid', 'group_id', 'roomid', 'room_id']);
      if (!gid) throw new Error(`建房没拿到房间号：${JSON.stringify(d).slice(0, 200)}`);
      room = { groupid: String(gid), biz: BIZ_MUSIC_ROOM };
      startHeartbeat();
      return { room_id: String(gid), privacy: a.privacy === 1 ? '公开' : '私密', tip: '让用户在酷狗 App 的众乐房/一起听里输入这个房间号进入' };
    },
  },
  {
    name: 'room_join',
    description: '让小号加入一个已存在的房间（房间号来自用户），之后小号会一直心跳待在里面。',
    inputSchema: {
      type: 'object',
      properties: { room_id: { type: 'string', description: '房间号' } },
      required: ['room_id'],
    },
    run: async (a) => {
      if (!loggedIn()) throw new Error('小号未登录，先去 /kt/login 扫码');
      await kgTogether('room', 'join', { room_id: a.room_id });
      room = { groupid: String(a.room_id), biz: BIZ_MUSIC_ROOM };
      startHeartbeat();
      return { joined: true, room_id: String(a.room_id) };
    },
  },
  {
    name: 'room_info',
    description: '看房间当前状态：在不在房里、里面几个人、现在放的是哪首。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const out = { in_room: !!room, room_id: room ? room.groupid : null };
      if (!room) return out;
      try {
        const b1 = await kgTogether('room', 'state', { room_id: room.groupid, biz: room.biz });
        const d1 = b1.data || {};
        out.room = { name: pick(d1, ['name', 'room_name']), online: pick(d1, ['online', 'online_num', 'member_num']) };
      } catch (e) {
        out.room_error = e.message;
      }
      try {
        const b2 = await kgTogether('music', 'detail', { roomid: room.groupid });
        const d2 = b2.data || {};
        out.now_playing = {
          name: pick(d2, ['song_name', 'songname', 'name', 'filename']),
          singer: pick(d2, ['singer_name', 'singername', 'author_name']),
          hash: pick(d2, ['hash', 'file_hash']),
          status: pick(d2, ['status', 'play_status', 'playstate']),
        };
      } catch (e) {
        out.detail_error = e.message;
      }
      return out;
    },
  },
  {
    name: 'room_playlist',
    description: '看房间的待播列表（当前队列），用来知道下一首是什么、或挑一首直接切过去。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      requireRoom();
      const body = await kgTogether('music', 'playlist', { roomid: room.groupid, pagesize: 50 });
      const list = deepFindArray(body, ['songs', 'list', 'audios', 'music_list', 'data']) || [];
      return list.slice(0, 50).map((s, i) => ({
        i,
        name: pick(s, ['filename', 'song_name', 'name', 'SongName']),
        hash: pick(s, ['hash', 'file_hash', 'FileHash']),
        mixsongid: String(pick(s, ['mixsongid', 'MixSongID', 'mixsong_id']) ?? ''),
        playing: !!pick(s, ['is_playing', 'playing', 'is_current']),
      }));
    },
  },
  {
    name: 'play_song',
    description: '在房间里切歌：把小号自己放进房间队列的第一首换掉并立即播放这首歌，双方都会听到。用户说「切到/放那首 XXX」时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '歌名或「歌手 歌名」，会自动搜第一首' },
        hash: { type: 'string', description: '已知 hash 时可直接传' },
        mixsongid: { type: 'string', description: '已知 mixsongid 时可直接传' },
        act_type: { type: 'number', description: '切歌动作类型，默认 1；如果切不动可以试 2' },
      },
    },
    run: async (a) => {
      requireRoom();
      const song = await resolveSong(a);
      await kgTogether('music', 'switch_song', {
        roomid: room.groupid,
        hash: song.hash,
        mixsongid: song.mixsongid,
        act_type: a.act_type || 1,
        is_auto: 0,
      });
      return { switched_to: song.name ? `${song.singer || ''} - ${song.name}`.replace(/^ - /, '') : undefined, hash: song.hash, mixsongid: song.mixsongid };
    },
  },
  {
    name: 'order_song',
    description: '点歌：把一首歌加进房间的点歌队列（不会打断当前播放，排到就会放）。用户说「加一首他想听的」时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '歌名或「歌手 歌名」' },
        hash: { type: 'string' },
        mixsongid: { type: 'string' },
      },
    },
    run: async (a) => {
      requireRoom();
      const song = await resolveSong(a);
      await kgTogether('music', 'order_song', { roomid: room.groupid, hash: song.hash, mixsongid: song.mixsongid });
      return { ordered: `${song.singer || ''} - ${song.name}`.replace(/^ - /, ''), hash: song.hash, mixsongid: song.mixsongid };
    },
  },
  {
    name: 'order_list',
    description: '看点歌队列：谁点了什么、排在第几首。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      requireRoom();
      const body = await kgTogether('music', 'song_order_list', { roomid: room.groupid });
      const list = deepFindArray(body, ['songs', 'list', 'order_list', 'data']) || [];
      return list.map((s, i) => ({
        i,
        name: pick(s, ['filename', 'song_name', 'name']),
        hash: pick(s, ['hash', 'file_hash']),
        mixsongid: String(pick(s, ['mixsongid', 'mix_songid', 'MixSongID']) ?? ''),
        order_userid: String(pick(s, ['order_userid', 'userid', 'user_id']) ?? ''),
      }));
    },
  },
  {
    name: 'remove_order',
    description: '从点歌队列里撤掉一首（按 order_list 里的序号）。',
    inputSchema: { type: 'object', properties: { index: { type: 'number', description: 'order_list 返回的 i，从 0 开始' } }, required: ['index'] },
    run: async (a) => {
      requireRoom();
      const body = await kgTogether('music', 'song_order_list', { roomid: room.groupid });
      const list = deepFindArray(body, ['songs', 'list', 'order_list', 'data']) || [];
      const item = list[a.index];
      if (!item) throw new Error(`队列里没有第 ${a.index} 首`);
      await kgTogether('music', 'remove_song', {
        roomid: room.groupid,
        hash: pick(item, ['hash', 'file_hash']),
        mixsongid: String(pick(item, ['mixsongid', 'mix_songid']) ?? ''),
        order_userid: String(pick(item, ['order_userid', 'userid']) ?? ''),
      });
      return { removed: pick(item, ['filename', 'song_name', 'name']) };
    },
  },
  {
    name: 'room_pause',
    description: '暂停或继续房间播放。paused=true 暂停，false 继续。',
    inputSchema: { type: 'object', properties: { paused: { type: 'boolean', description: 'true=暂停，false=继续播放' } }, required: ['paused'] },
    run: async (a) => {
      requireRoom();
      await kgTogether('music', 'player_operation', { roomid: room.groupid, action: 3, pause: a.paused ? 1 : 2 });
      return { paused: !!a.paused };
    },
  },
  {
    name: 'room_seek',
    description: '把房间播放进度拖到指定秒数。',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: '目标秒数' } }, required: ['seconds'] },
    run: async (a) => {
      requireRoom();
      await kgTogether('music', 'player_operation', { roomid: room.groupid, action: 2, progress: Math.max(0, Math.floor(Number(a.seconds) * 1000)) });
      return { seek_to: a.seconds };
    },
  },
  {
    name: 'room_members',
    description: '看房间里现在有谁。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      requireRoom();
      const body = await kgTogether('music', 'members', { roomid: room.groupid, pagesize: 50 });
      const list = deepFindArray(body, ['members', 'list', 'users', 'data']) || [];
      return list.map((u) => ({
        name: pick(u, ['nickname', 'nick_name', 'name']),
        userid: String(pick(u, ['userid', 'user_id', 'id']) ?? ''),
      }));
    },
  },
  {
    name: 'room_leave',
    description: '小号退出房间（停止心跳，一起听结束）。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      if (!room) return { in_room: false };
      await kgTogether('room', 'leave', { room_id: room.groupid, biz: room.biz });
      stopHeartbeat();
      const id = room.groupid;
      room = null;
      return { left: id };
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

/* --------------------------------------------------------------- heartbeat */

let heartbeatTimer = null;

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!room) return;
    try {
      await kgTogether('room', 'heartbeat', { room_id: room.groupid, biz: room.biz });
    } catch (e) {
      console.error('[bridge] 心跳失败', e.message);
    }
  }, 25000);
  heartbeatTimer.unref?.();
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/* --------------------------------------------------------------- MCP 协议 */

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
  if (!msg || typeof msg !== 'object' || !msg.method) return fail(msg && msg.id, -32600, 'Invalid Request');
  const id = msg.id;
  const isNotification = id === undefined || id === null;

  if (msg.method === 'initialize') {
    return ok(id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'kugou-together', version: '1.0.0' },
      instructions:
        '这个小号是一个真实登录的酷狗账号，会一直待在「一起听」房间里。用户说想听某首歌 → 先 search_song，再 play_song（立刻切过去）或 order_song（排队）。' +
        '用户说「现在在放什么」「谁在房里」→ room_info / room_members。结束后记得 room_leave。不要连续重复建房，会顶掉旧房间。',
    });
  }
  if (isNotification) return null;
  if (msg.method === 'ping') return ok(id, {});
  if (msg.method === 'tools/list') {
    return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const tool = toolMap.get(name);
    if (!tool) return ok(id, { content: [{ type: 'text', text: `没有这个工具：${name}` }], isError: true });
    try {
      const out = await tool.run(args);
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `调用失败：${e.message}` }], isError: true });
    }
  }
  if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
    return ok(id, msg.method === 'resources/list' ? { resources: [] } : { prompts: [] });
  }
  return fail(id, -32601, `Method not found: ${msg.method}`);
}

/* ------------------------------------------------------------------ routes */

function tokenOk(req) {
  if (!MCP_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.replace(/^Bearer\s+/i, '');
  const url = new URL(req.originalUrl || req.url, 'http://x');
  if (bearer === MCP_TOKEN || url.searchParams.get('token') === MCP_TOKEN) return true;
  // 登录页把自己的 token 写成 cookie，页面里的扫码请求就自动带上
  const raw = String(req.headers.cookie || '');
  return raw.split(/;\s+/).some((p) => p === `kt=${MCP_TOKEN}`);
}

/** 把一组路由插到全局缓存中间件前面（绕过 2 分钟 URL 缓存），但仍在其前面的 body 解析之后 */
function prependRouter(app, router) {
  const Layer = require('express/lib/router/layer');
  const layer = new Layer('/', { sensitive: false, strict: false, end: false }, router);
  layer.route = undefined;
  const stack = app._router && app._router.stack;
  if (!stack) return;
  const cacheIndex = stack.findIndex((l) => l.name === 'cache');
  if (cacheIndex > 0) stack.splice(cacheIndex, 0, layer);
  else stack.unshift(layer);
}

function mount(app) {
  // 注意：KuGouMusicApi 在全局装了 2 分钟 URL 缓存（app.use(cache(...))），
  // 而 MCP 是同一个 URL 上反复 POST 不同 JSON-RPC，会被缓存串成同一个响应。
  // 所以把 MCP / 登录相关路由整体插到最前面，绕过缓存中间件（同时自己解析 body）。
  const router = require('express').Router();
  router.use(require('express').json({ limit: '4mb' }));
  prependRouter(app, router);

  router.use('/kt', (req, res, next) => {
    if (tokenOk(req)) return next();
    res.status(401).type('text/plain; charset=utf-8').send('需要口令：请在地址后面加 ?token=你的MCP_TOKEN');
  });


  router.post('/mcp', async (req, res) => {
    if (!tokenOk(req)) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    const payload = req.body;
    try {
      const batch = Array.isArray(payload);
      const results = batch ? (await Promise.all(payload.map(handleRpc))).filter(Boolean) : [await handleRpc(payload)];
      if (batch) {
        res.json(results.length ? results : []);
        return;
      }
      const one = results[0];
      if (!one) {
        res.status(202).end();
        return;
      }
      const wantsSse = String(req.headers.accept || '').includes('text/event-stream');
      if (wantsSse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.write(`event: message\ndata: ${JSON.stringify(one)}\n\n`);
        res.end();
        return;
      }
      res.json(one);
    } catch (e) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: e.message } });
    }
  });

  router.get('/mcp', (req, res) => {
    // 无状态实现：不接受长连接 SSE
    res.status(405).json({ error: 'use POST /mcp' });
  });

  // 兼容旧版 HTTP+SSE 客户端
  const sessions = new Map();
  router.get('/sse', (req, res) => {
    const sid = crypto.randomUUID();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
    sessions.set(sid, res);
    const keep = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(keep);
      sessions.delete(sid);
    });
  });

  router.post('/message', async (req, res) => {
    const sid = req.query.sessionId;
    const out = sessions.get(sid);
    if (!out) {
      res.status(404).end();
      return;
    }
    const r = await handleRpc(req.body);
    if (r) out.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
    res.status(202).end();
  });

  /** 扫码登录：全部在服务端完成，cookie 直接落进 jar */
  const qrKeyCache = { key: null, at: 0 };
  router.get('/kt/qr/key', async (_req, res) => {
    try {
      const body = await kg('/login/qr/key');
      const key = pick(body.data || {}, ['key', 'qrcode']) || (body.data && body.data.data && body.data.data.qrcode);
      qrKeyCache.key = key;
      qrKeyCache.at = Date.now();
      res.json({ key });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/kt/qr/create', async (req, res) => {
    try {
      const body = await kg('/login/qr/create', { key: req.query.key, qrimg: 'true' });
      const d = body.data || {};
      const img = pick(d, ['qrimg', 'qrcode_img', 'base64']) || (d.data && d.data.qrimg);
      res.json({ qrimg: img });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/kt/qr/check', async (req, res) => {
    try {
      const body = await kg('/login/qr/check', { key: req.query.key });
      const d = body.data || {};
      const status = pick(d, ['status']) ?? (d.data ? d.data.status : 0);
      res.json({ status, userid: jar.userid || null, nickname: pick(d, ['nickname']) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/kt/status', (_req, res) => {
    res.json({ logged_in: loggedIn(), userid: jar.userid || null, in_room: !!room, room_id: room ? room.groupid : null });
  });

  router.get('/healthz', (_req, res) => res.json({ ok: true, logged_in: loggedIn(), in_room: !!room }));

  router.get('/kt/login', (req, res) => {
    if (MCP_TOKEN) res.append('Set-Cookie', `kt=${MCP_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LOGIN_PAGE);
  });
}

const LOGIN_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>酷狗小号登录</title>
<style>
body{margin:0;padding:28px 20px;background:#111;color:#eee;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-align:center}
h1{font-size:20px;margin:0 0 16px}
img{width:260px;height:260px;background:#fff;border-radius:14px;padding:8px}
.card{max-width:420px;margin:0 auto;background:#1b1b1b;border-radius:18px;padding:22px}
.tip{color:#9aa;font-size:13px;margin-top:14px}
.big{font-size:34px;margin:8px 0}
button{margin-top:16px;background:#2a2a2a;color:#ddd;border:0;border-radius:12px;padding:10px 18px;font-size:15px}
</style></head><body>
<div class="card">
<h1>用酷狗概念版扫码登录</h1>
<div id="box"><div class="tip">正在生成二维码…</div></div>
<div class="tip" id="st">二维码 3 分钟内有效</div>
</div>
<script>
let key=null, timer=null;
async function boot(){
  document.getElementById('box').innerHTML='<div class="tip">正在生成二维码…</div>';
  const r=await fetch('/kt/qr/key'); const j=await r.json();
  if(!j.key){ document.getElementById('box').innerHTML='<div class="tip">生成失败：'+(j.error||'未知')+'</div>'; return; }
  key=j.key;
  const r2=await fetch('/kt/qr/create?key='+encodeURIComponent(key)); const j2=await r2.json();
  if(!j2.qrimg){ document.getElementById('box').innerHTML='<div class="tip">二维码生成失败：'+(j2.error||'未知')+'</div>'; return; }
  document.getElementById('box').innerHTML='<img src="'+j2.qrimg+'">';
  clearInterval(timer); timer=setInterval(check,2000);
}
async function check(){
  const r=await fetch('/kt/qr/check?key='+encodeURIComponent(key)); const j=await r.json();
  if(j.status==4){
    clearInterval(timer);
    document.getElementById('box').innerHTML='<div class="big">✅</div><div>已登录，userid '+j.userid+'</div>';
    document.getElementById('st').textContent='可以关掉这个页面，回 Kelivo 说一句「小号进房」';
  } else if(j.status==0){
    clearInterval(timer);
    document.getElementById('st').textContent='二维码过期了';
    boot();
  } else if(j.status==2){
    document.getElementById('st').textContent='在手机上点确认一下';
  }
}
boot();
</script></body></html>`;

/* -------------------------------------------------------------------- main */

(async () => {
  const { startService } = require('./server');
  loadSession();
  if ((process.env.platform || '').toLowerCase() !== 'lite') {
    console.error('[bridge] ⚠️  platform 不是 lite，一起听接口会不可用。请设置 platform=lite 并用概念版扫码登录。');
  }
  const app = await startService();
  mount(app);
  console.log(`[bridge] MCP 已挂载：POST /mcp   扫码登录：GET /kt/login   状态：GET /kt/status`);
  if (!MCP_TOKEN) console.error('[bridge] ⚠️  没设置 MCP_TOKEN，任何拿到地址的人都能用这个小号，建议补上。');
})().catch((e) => {
  console.error('[bridge] 启动失败', e);
  process.exit(1);
});
