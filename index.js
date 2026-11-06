/**
 * dsh-rooms — 跨会话协作插件（Host 端）
 *
 * 一个「房间」就是一个独立会话：有职责、有工作目录、有自己的上下文。
 * 房间之间可以派活，也可以回报；面板负责分组、加入状态和回报记录。
 *
 * 设计约束（都是踩过坑才定下来的）：
 * - 消息分两种：room_send 是「发送」，能在同组内发给任何房间；
 *   room_report 是「回报」，只回到给它派活的那个会话，不广播、不兜底。
 * - 谁能派活：和目标同组。工作区里每个会话都是房间，没有「加入」这一步。
 * - 房间名字以工作区里的会话标题为准（每次读面板都重新取），配置里的 title 只是还没标题时的占位。
 * - 状态全部落在 stateDir，配置只描述房间本身。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'rooms';
export const inject = ['agents', 'tools'];

const DEFAULT_API_PREFIX = '/dsh-rooms/api';
const REPORT_KEEP = 50;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function normalizeConfig(raw) {
  const config = raw ?? {};
  const rooms = (Array.isArray(config.rooms) ? config.rooms : [])
    .filter((room) => room && typeof room.id === 'string' && room.id.trim() !== '')
    .map((room) => ({
      id: room.id.trim(),
      // 只是占位名：会话有自己的标题，工作区里显示的是那个
      title: (room.title ?? room.id).toString(),
      description: (room.description ?? '').toString(),
      prompt: (room.prompt ?? '').toString(),
      cwd: (room.cwd ?? '').toString(),
      sessionId: (room.sessionId ?? '').toString(),
      idleTimeoutMinutes: Number.isFinite(Number(room.idleTimeoutMinutes)) ? Number(room.idleTimeoutMinutes) : undefined,
    }));
  return {
    rooms,
    defaultCwd: (config.defaultCwd ?? '').toString(),
    stateDir: (config.stateDir ?? '').toString(),
    apiPrefix: (config.apiPrefix ?? DEFAULT_API_PREFIX).toString(),
    reportHint: (config.reportHint
      ?? '干完用 room_report 工具回报：status 填 done 或 blocked，写清产出路径和自检结果。').toString(),
    // 派出去多少分钟没回报、会话也没在写盘，就提醒派活方；0 = 不提醒
    idleTimeoutMinutes: Number.isFinite(Number(config.idleTimeoutMinutes)) ? Number(config.idleTimeoutMinutes) : 15,
  };
}

/** 参数校验：模型传错字段名时直接说清楚改哪个，而不是悄悄丢掉。 */
const FIELD_HINTS = {
  message: 'task', msg: 'task', content: 'task', prompt: 'task', text: 'task',
  room_id: 'room', roomId: 'room', 房间: 'room', 任务: 'task', 内容: 'task',
};

function validate(tool, raw, spec) {
  const where = `room 工具 ${tool}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: 参数必须是对象，收到的是 ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(spec, key));
  if (unknown.length > 0) {
    const hints = unknown
      .map((key) => (Object.hasOwn(FIELD_HINTS, key) ? `「${key}」应写成「${FIELD_HINTS[key]}」` : `「${key}」不是有效参数`))
      .join('；');
    throw new Error(`${where}: ${hints}。有效参数只有: ${Object.keys(spec).join(', ')}`);
  }
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    let value = raw[key];
    const blank = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    if (blank) {
      if (rule.required) throw new Error(`${where}: 缺少必填参数「${key}」`);
      continue;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${where}: 「${key}」必须是字符串`);
      value = value.trim();
      if (rule.min !== undefined && value.length < rule.min) throw new Error(`${where}: 「${key}」太短（至少 ${rule.min} 字）`);
      if (rule.max !== undefined && value.length > rule.max) throw new Error(`${where}: 「${key}」太长（上限 ${rule.max} 字）`);
    } else if (rule.type === 'enum') {
      if (typeof value !== 'string' || !rule.values.includes(value.trim())) {
        throw new Error(`${where}: 「${key}」只能是 ${rule.values.map((v) => `「${v}」`).join(' / ')}`);
      }
      value = value.trim();
    } else if (rule.type === 'array') {
      if (!Array.isArray(value)) throw new Error(`${where}: 「${key}」必须是数组`);
      value = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
      if (rule.max !== undefined && value.length > rule.max) throw new Error(`${where}: 「${key}」最多 ${rule.max} 项`);
    }
    out[key] = value;
  }
  return out;
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger ?? console;
  // cordis 的 logger.info 是访问器，取出来单独调用会丢 this，必须带着 logger 调
  const emit = (level, msg) => {
    const fn = logger[level] ?? logger.log;
    if (typeof fn === 'function') fn.call(logger, `[rooms] ${msg}`);
  };
  const log = (msg) => emit('info', msg);
  const warn = (msg) => emit('warn', msg);

  const stateDir = config.stateDir || path.join(os.homedir(), '.dsh-rooms');
  const statePath = path.join(stateDir, 'state.json');
  const state = readJson(statePath) ?? {};
  state.sessions ??= {}; // roomId -> { sessionId }
  state.reports ??= {}; // roomId -> 最近回报
  state.groups ??= []; // [{ id, title }]
  state.roomGroup ??= {}; // roomId -> groupId（缺省 = 未分组）
  state.senders ??= {}; // roomId -> 上次派活给它的会话 id
  state.settings ??= {}; // 面板配置页改的值
  state.extraRooms ??= []; // 从工作区会话自动登记的房间（不改配置文件）

  const rooms = new Map(config.rooms.map((room) => [room.id, room]));
  syncExtraRooms();
  /** 把自动登记的房间补进房间表；配置里同 id 的优先 */
  function syncExtraRooms() {
    for (const room of state.extraRooms) {
      if (!room?.id || rooms.has(room.id)) continue;
      rooms.set(room.id, {
        id: room.id,
        title: room.title || room.id,
        description: room.description || '',
        prompt: '',
        cwd: room.cwd || '',
        sessionId: room.sessionId || '',
        idleTimeoutMinutes: undefined,
        extra: true,
      });
    }
  }
  const pending = new Map(); // roomId -> 派活时间
  const busyRooms = new Set(); // 正在跑 turn 的房间（不管是派的还是人点的）
  const defaultCwd = config.defaultCwd || process.cwd();
  const persist = () => writeJson(statePath, state);

  const roomSessionId = (roomId) => state.sessions[roomId]?.sessionId ?? rooms.get(roomId)?.sessionId ?? '';
  const roomOfSession = (sessionId) => {
    for (const [id] of rooms) if (roomSessionId(id) === sessionId) return rooms.get(id);
    return undefined;
  };
  /** 工作区里每个会话都是房间：没有的就地登记一间，返回房间 id */
  function ensureRoomForSession(sessionId, title, cwd) {
    const existing = roomOfSession(sessionId);
    if (existing) return existing.id;
    const room = {
      id: `self-${String(sessionId).replace(/^session-/, '').slice(0, 8)}`,
      title: title || sessionId,
      description: '',
      cwd: cwd || '',
      sessionId,
    };
    state.extraRooms.push(room);
    rooms.set(room.id, {
      id: room.id, title: room.title, description: '', prompt: '',
      cwd: room.cwd, sessionId, idleTimeoutMinutes: undefined, extra: true,
    });
    return room.id;
  }
  const groupOf = (roomId) => (state.roomGroup[roomId] && state.groups.some((g) => g.id === state.roomGroup[roomId])
    ? state.roomGroup[roomId]
    : null);
  const groupName = (groupId) => state.groups.find((group) => group.id === groupId)?.title ?? '未分组';
  /** 会话最后一条事件是不是还没收尾的 turn（插件重载后也能认出来） */
  function sessionRunning(roomId) {
    const session = ctx.get?.('sessions')?.get?.(roomSessionId(roomId));
    if (!session) return false;
    try {
      const last = session.snapshotEvents(Number(session.seq) - 1, Number(session.seq))[0];
      return last?.type === 'turn/start' || last?.type === 'step/start';
    } catch {
      return false;
    }
  }

  // 「在干活」包括两种：我们派出去的活还没回报，或者这个会话当前有一轮 turn 在跑。
  // 后者覆盖人在会话里直接开聊的情况，这时候也不许改加入状态、不许换组。
  const isWorking = (roomId) => pending.has(roomId) || busyRooms.has(roomId) || sessionRunning(roomId);
  const idleMinutes = () => (Number.isFinite(Number(state.settings.idleTimeoutMinutes))
    ? Number(state.settings.idleTimeoutMinutes)
    : config.idleTimeoutMinutes);

  // 最近一次读到的会话标题：报错文案也用它，免得面板显示工作区名字、提示却写占位名
  let titleCache = new Map();
  let titleCacheAt = 0;
  const roomLabel = (room) => titleCache.get(roomSessionId(room.id)) || room.title || room.id;

  function effective(room) {
    return {
      ...room,
      groupId: groupOf(room.id),
      idleTimeoutMinutes: room.idleTimeoutMinutes ?? idleMinutes(),
    };
  }

  // ── 会话标题：工作区里显示的名字就是它，面板和提示文案都用这个 ─────────
  async function readTitles(extraIds = []) {
    const query = ctx.get?.('sessionQuery');
    if (!query?.readTitleSnapshots) return new Map();
    const ids = [...new Set([...[...rooms.keys()].map(roomSessionId), ...extraIds].filter(Boolean))];
    if (ids.length === 0) return new Map();
    // 标题不会一秒一变，60 秒内复用缓存：面板 6 秒轮询一次，没必要每次读几十个会话日志
    if (Date.now() - titleCacheAt > 60_000) {
      titleCache = new Map();
      titleCacheAt = Date.now();
    }
    const missing = ids.filter((id) => !titleCache.has(id));
    if (missing.length > 0) {
      try {
        const results = await query.readTitleSnapshots(missing);
        for (const item of results ?? []) {
          if (item?.status !== 'fulfilled') continue;
          const title = item.value?.title?.title;
          if (typeof title === 'string' && title.trim() !== '') titleCache.set(item.sessionId, title.trim());
        }
      } catch (error) {
        warn(`取会话标题失败，先用配置里的占位名: ${error?.message ?? error}`);
      }
    }
    return new Map(ids.map((id) => [id, titleCache.get(id)]).filter(([, title]) => title));
  }

  const nameOf = (room, titles) => titles.get(roomSessionId(room.id)) || roomLabel(room);

  // ── 分组 ──────────────────────────────────────────────────────────────
  function createGroup(title) {
    const trimmed = String(title ?? '').trim();
    if (!trimmed) throw new Error('分组名字不能为空');
    if (state.groups.some((group) => group.title === trimmed)) throw new Error(`已经有叫「${trimmed}」的分组`);
    const group = { id: `g-${randomUUID().slice(0, 8)}`, title: trimmed };
    state.groups.push(group);
    persist();
    return group;
  }

  function renameGroup(groupId, title) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('没有这个分组');
    const trimmed = String(title ?? '').trim();
    if (!trimmed) throw new Error('分组名字不能为空');
    group.title = trimmed;
    persist();
    return group;
  }

  function deleteGroup(groupId) {
    const index = state.groups.findIndex((item) => item.id === groupId);
    if (index < 0) throw new Error('没有这个分组');
    for (const [roomId, current] of Object.entries(state.roomGroup)) {
      if (current === groupId) delete state.roomGroup[roomId];
    }
    state.groups.splice(index, 1);
    persist();
  }

  function moveRoom(roomId, groupId) {
    if (!rooms.has(roomId)) throw new Error(`没有这个房间: ${roomId}`);
    if (isWorking(roomId)) throw new Error(`「${roomLabel(rooms.get(roomId))}」正在干活，不能换组`);
    if (groupId && !state.groups.some((group) => group.id === groupId)) throw new Error('没有这个分组');
    if (groupId) state.roomGroup[roomId] = groupId;
    else delete state.roomGroup[roomId];
    persist();
    return effective(rooms.get(roomId));
  }

  function rememberReport(roomId, report) {
    const list = state.reports[roomId] ?? [];
    list.push({ ...report, ts: Date.now(), read: false });
    state.reports[roomId] = list.slice(-REPORT_KEEP);
    persist();
  }

  // ── 会话：建、恢复、挂预设 ────────────────────────────────────────────
  const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
  const agentOptions = selection
    ? {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    : undefined;

  async function presetSetup() {
    const presets = ctx.get?.('agentPresets');
    if (!presets?.resolve || !presets?.mount) return {};
    try {
      const resolved = await presets.resolve(undefined);
      const presetId = resolved?.id;
      if (!presetId) return {};
      return { setup: async (agentCtx) => { await presets.mount(agentCtx, presetId); } };
    } catch (error) {
      warn(`取预设失败: ${error?.message ?? error}`);
      return {};
    }
  }

  async function ensureRoomAgent(room) {
    const knownId = roomSessionId(room.id);
    const live = knownId ? ctx.agents.get(knownId) : undefined;
    if (live) return live;

    if (knownId) {
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: knownId,
          ...(agentOptions ? { agentOptions } : {}),
          ...(await presetSetup()),
        });
        state.sessions[room.id] = { sessionId: knownId };
        persist();
        log(`房间 ${room.id} 接手会话 ${knownId}`);
        return handle.agent;
      } catch (error) {
        warn(`房间 ${room.id} 恢复 ${knownId} 失败: ${error?.message ?? error}`);
      }
    }

    const sessionId = knownId || randomUUID();
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: room.cwd || defaultCwd },
      ...(agentOptions ? { agentOptions } : {}),
      ...(await presetSetup()),
    });
    state.sessions[room.id] = { sessionId };
    persist();
    log(`房间 ${room.id} 新建会话 ${sessionId}`);
    if (room.prompt) {
      handle.agent.followup({
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: room.prompt }],
        source: { kind: 'user' }, time: Date.now(),
      });
    }
    return handle.agent;
  }

  // ── 派活与回报 ────────────────────────────────────────────────────────
  /**
   * 谁能往哪派活：同组。未分组不是一组，两边都得先归组才能互派。
   * 没有豁免身份——想从某个会话派活，就把它和自己放进同一组。
   */
  function assertCanSend(target, senderId) {
    const targetLabel = roomLabel(target);
    const targetSession = roomSessionId(target.id);
    if (targetSession && archivedIds().has(targetSession)) {
      throw new Error(`「${targetLabel}」已经归档了，先去工作区取消归档再派活`);
    }
    if (!senderId) throw new Error('不知道你是谁：派活必须由会话发起');
    // 每个会话都是房间，没登记的就地补一间，省得让你先调 room_here
    const senderRoom = roomOfSession(senderId)
      ?? rooms.get(ensureRoomForSession(senderId, undefined, defaultCwd));
    const from = groupOf(senderRoom.id);
    const to = groupOf(target.id);
    if (!from) {
      throw new Error(`「${roomLabel(senderRoom)}」还没分组，先把你自己拖进一个房间组`);
    }
    if (!to) {
      throw new Error(`「${targetLabel}」还没分组，先把它拖进「${groupName(from)}」这一组`);
    }
    if (from !== to) {
      throw new Error(`跨组不能派活：「${roomLabel(senderRoom)}」在「${groupName(from)}」，「${targetLabel}」在「${groupName(to)}」`);
    }
    return senderRoom;
  }

  async function sendToRoom(room, task, senderId) {
    assertCanSend(room, senderId);
    state.senders[room.id] = senderId;
    persist();
    const agent = await ensureRoomAgent(room);
    const body = config.reportHint ? `${task}\n\n${config.reportHint}` : task;
    agent.followup({
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' }, time: Date.now(),
    });
    pending.set(room.id, Date.now());
    log(`派活给 ${room.id}（${body.length} 字）`);
  }

  /** 回报只回给派活方；派活方已经没了就只留在面板，不兜底、不硬塞 */
  async function deliverReport(roomId, text) {
    const senderId = state.senders[roomId];
    if (!senderId) {
      log(`房间 ${roomId} 的回报没有派活方记录，只留面板`);
      return;
    }
    if (senderId === roomSessionId(roomId)) return;
    let agent = ctx.agents.get(senderId);
    if (!agent) {
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: senderId });
        agent = handle.agent;
      } catch (error) {
        warn(`派活方 ${senderId} 已经不在了，回报只留面板: ${error?.message ?? error}`);
        return;
      }
    }
    try {
      agent.followup({
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' }, time: Date.now(),
      });
      log(`回报已回给派活方 ${senderId}`);
    } catch (error) {
      warn(`回报投递失败，只留面板: ${error?.message ?? error}`);
    }
  }

  async function cancelRoom(room) {
    const agent = ctx.agents.get(roomSessionId(room.id));
    pending.delete(room.id);
    if (!agent) return false;
    try {
      await agent.cancel({ kind: 'user' });
      return true;
    } catch (error) {
      warn(`叫停失败: ${error?.message ?? error}`);
      return false;
    }
  }

  async function resetRoom(room) {
    const agent = ctx.agents.get(roomSessionId(room.id));
    if (agent) {
      try { await agent.cancel({ kind: 'user' }); } catch { /* 忽略 */ }
    }
    pending.delete(room.id);
    const sessionId = randomUUID();
    state.sessions[room.id] = { sessionId };
    delete state.senders[room.id];
    persist();
    return sessionId;
  }

  // ── 无活动提醒 ────────────────────────────────────────────────────────
  /** 会话落盘文件还在被改，说明它没死，只是慢 */
  function sessionTouchedRecently(sessionId) {
    if (!sessionId) return false;
    const root = path.join(os.homedir(), '.dsh', 'sessions');
    try {
      for (const group of fs.readdirSync(root)) {
        const file = path.join(root, group, sessionId, 'session.v4.jsonl.zstd');
        if (fs.existsSync(file)) return Date.now() - fs.statSync(file).mtimeMs < 3 * 60_000;
      }
    } catch { /* 忽略 */ }
    return false;
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [roomId, startedAt] of [...pending]) {
        const room = rooms.get(roomId);
        const minutes = room ? effective(room).idleTimeoutMinutes : idleMinutes();
        if (!minutes) continue;
        if (now - startedAt <= minutes * 60_000) continue;
        if (sessionTouchedRecently(roomSessionId(roomId))) {
          pending.set(roomId, now);
          continue;
        }
        pending.delete(roomId);
        const text =
          `[房间回报 · ${room ? roomLabel(room) : roomId}]\n状态: 超时\n` +
          `${minutes} 分钟没回音，会话也没在写盘，大概率卡住或崩了。`;
        rememberReport(roomId, { status: 'timeout', summary: text });
        void deliverReport(roomId, text);
        log(`房间 ${roomId} 超过 ${minutes} 分钟没动静，已提醒`);
      }
    }, 5000);
    return () => clearInterval(timer);
  });

  ctx.on('session/event', (session, raw) => {
    try {
      const sid = session?.header?.id ?? session?.id;
      const room = sid ? roomOfSession(sid) : undefined;
      if (!room) return;
      if (raw?.type === 'turn/start') {
        busyRooms.add(room.id);
        return;
      }
      if (raw?.type !== 'turn/end') return;
      busyRooms.delete(room.id);
      const reason = raw?.data?.reason ?? {};
      if (reason?.kind === 'completed') {
        if (!pending.has(room.id)) return;
        pending.delete(room.id);
        const text =
          `[房间回报 · ${roomLabel(room)}]\n状态: 没回报\n这一轮跑完了，但房间没调用 room_report。\n` +
          '去会话里看它干了什么，下次派活记得盯一句「干完用 room_report 回报」。';
        rememberReport(room.id, { status: 'silent', summary: text });
        void deliverReport(room.id, text);
        return;
      }
      if (reason?.kind === 'aborted') {
        pending.delete(room.id);
        return;
      }
      pending.delete(room.id);
      const detail = reason?.error?.message ?? JSON.stringify(reason);
      const text = `[房间回报 · ${roomLabel(room)}]\n状态: 失败\n原因: ${String(detail).slice(0, 400)}`;
      rememberReport(room.id, { status: 'failed', summary: text });
      void deliverReport(room.id, text);
    } catch (error) {
      warn(`监听房间事件出错: ${error?.message ?? error}`);
    }
  });

  // ── 面板数据 ──────────────────────────────────────────────────────────
  /** 工作区里的所有会话，新的在前 */
  async function listSessions() {
    const query = ctx.get?.('sessionQuery');
    if (!query?.listSessions) return [];
    try {
      const records = await query.listSessions();
      return [...records].sort((a, b) => b.header.createdAt - a.header.createdAt);
    } catch (error) {
      warn(`列会话失败: ${error?.message ?? error}`);
      return [];
    }
  }

  /** 工作区里已经归档的会话：界面不摆它们，面板也不摆 */
  function archivedIds() {
    const ids = ctx.get?.('workspaceRegistry')?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids : []);
  }

  async function snapshot() {
    const now = Date.now();
    const archived = archivedIds();
    // 工作区里露脸的会话都算房间：子会话和已归档的不算
    const records = (await listSessions()).filter((record) => (
      record.header.origin !== 'subagent' && !archived.has(record.header.id)
    ));
    const titles = await readTitles(records.map((record) => record.header.id));
    let added = 0;
    for (const record of records) {
      const before = rooms.size;
      ensureRoomForSession(record.header.id, titles.get(record.header.id), record.header.cwd);
      if (rooms.size !== before) added += 1;
    }
    if (added > 0) persist();
    // 卡片只需要三样：谁、在不在干活、属于哪个分组
    const roomEntries = [...rooms.values()]
      .filter((room) => {
        const sessionId = roomSessionId(room.id);
        return !sessionId || !archived.has(sessionId);
      })
      .map((room) => ({
        id: room.id,
        name: nameOf(room, titles),
        groupId: groupOf(room.id),
        running: pending.has(room.id) || busyRooms.has(room.id) || sessionRunning(room.id),
      }));
    return {
      defaultCwd,
      idleTimeoutMinutes: idleMinutes(),
      groups: state.groups.map((group) => ({ ...group })),
      rooms: roomEntries,
    };
  }

  // ── 面板 API ──────────────────────────────────────────────────────────
  // webServer 不保证 apply 时就绪，直接 ctx.get('webServer') 可能拿到 undefined，
  // 路由就会静默不注册（面板全 405）。所以用 ctx.inject 等它起来。
  const routes = {
    list: () => snapshot(),
    createGroup: (payload) => ({ ok: true, group: createGroup(payload.title) }),
    renameGroup: (payload) => ({ ok: true, group: renameGroup(String(payload.group ?? ''), payload.title) }),
    deleteGroup: (payload) => {
      deleteGroup(String(payload.group ?? ''));
      return { ok: true };
    },
    moveRoom: (payload) => ({
      ok: true,
      room: moveRoom(String(payload.room ?? ''), payload.group ? String(payload.group) : null),
    }),
    setConfig: (payload) => {
      const minutes = Number(payload.idleTimeoutMinutes);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error('提醒分钟数要写 0–1440 之间的数字');
      state.settings.idleTimeoutMinutes = minutes;
      persist();
      return { ok: true, idleTimeoutMinutes: idleMinutes() };
    },
  };

  const handler = async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST') return send(405, { ok: false, error: '仅支持 POST' });
    const url = request.url ?? '';
    const method = url.slice(config.apiPrefix.length).replace(/^\/+/, '').split('?')[0];
    const action = routes[method];
    if (!action) return send(404, { ok: false, error: `未知方法: ${method}` });
    let payload = {};
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
        if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) throw new Error('请求体过大');
      }
      const text = Buffer.concat(chunks).toString('utf8');
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      return send(400, { ok: false, error: `请求体不合法: ${error?.message ?? error}` });
    }
    try {
      return send(200, { ok: true, data: await action(payload) });
    } catch (error) {
      return send(200, { ok: false, error: error?.message ?? String(error) });
    }
  };

  const install = (scope) => {
    const server = scope.get?.('webServer') ?? scope.webServer;
    if (!server?.register) return false;
    scope.effect(() => server.register({ kind: 'prefix', path: config.apiPrefix, handler }), 'dsh-rooms: api');
    log(`面板接口就绪 ${config.apiPrefix}`);
    return true;
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => { install(scoped); });
  } else if (!install(ctx)) {
    warn('webServer 还没就绪，面板接口没挂上');
  }

  // ── 工具 ──────────────────────────────────────────────────────────────
  const roomSpec = { room: { type: 'string', required: true, max: 64 } };
  const roomParams = {
    type: 'object',
    properties: { room: { type: 'string', description: '房间 id，见 room_list' } },
    required: ['room'],
    additionalProperties: false,
  };

  ctx.tools.register({
    name: 'room_list',
    description: '看有哪些房间、各自的会话 id、目录、分组和最近一次回报。工作区里每个会话都是一间房。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { detail: { type: 'string' } }, required: ['detail'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.detail }],
    },
    async execute(rawArgs) {
      validate('room_list', rawArgs ?? {}, {});
      const titles = await readTitles();
      const archived = archivedIds();
      const lines = [...rooms.values()]
        .filter((room) => {
          const sid = roomSessionId(room.id);
          return !sid || !archived.has(sid);
        })
        .map((room) => {
          const live = effective(room);
          const sid = roomSessionId(room.id) || '未创建';
          const last = (state.reports[room.id] ?? []).slice(-1)[0];
          const flags = [
            groupName(live.groupId),
            isWorking(room.id) ? '干活中' : '',
            live.idleTimeoutMinutes ? `${live.idleTimeoutMinutes} 分钟没动静就提醒` : '不提醒',
          ].filter(Boolean).join('｜');
          const tail = last ? `｜最近回报 ${last.status}` : '';
          return `${room.id}｜${nameOf(room, titles)}｜会话 ${sid}｜目录 ${room.cwd || defaultCwd}｜${flags}${tail}`;
        });
      return { detail: lines.join('\n') || '还没有房间，先到配置里加' };
    },
  });

  ctx.tools.register({
    name: 'room_send',
    description: '把一件事派给同组的某个房间。房间是独立会话，有自己的职责和目录；派完立刻返回，不等它干完。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id，见 room_list' },
        task: { type: 'string', description: '要它干的事，写清楚交付要求' },
      },
      required: ['room', 'task'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.detail ?? '已派活' }],
    },
    async execute(rawArgs, exec) {
      const args = validate('room_send', rawArgs, {
        room: { type: 'string', required: true, max: 64 },
        task: { type: 'string', required: true, min: 8, max: 20000 },
      });
      const room = rooms.get(args.room);
      if (!room) throw new Error(`没有这个房间: ${args.room}（可用: ${[...rooms.keys()].join(', ') || '无'}）`);
      const senderId = exec?.agent?.id ?? exec?.agent?.session?.header?.id;
      await sendToRoom(room, args.task, senderId);
      return { ok: true, detail: `已派给「${roomLabel(room)}」（${groupName(groupOf(room.id))}）` };
    },
  });

  ctx.tools.register({
    name: 'room_report',
    description: '房间干完活或者卡住时，把结果回报给派活给你的那个会话。只有房间里的会话需要用它。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'blocked', 'progress'], description: 'done 完成 / blocked 卡住需要人 / progress 阶段汇报' },
        summary: { type: 'string', description: '干了什么、结果如何' },
        files: { type: 'array', items: { type: 'string' }, description: '产出文件路径' },
        checks: { type: 'string', description: '自检了哪几项、哪项没过' },
        question: { type: 'string', description: 'status=blocked 时，需要人决定什么' },
      },
      required: ['status', 'summary'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.detail ?? '已回报' }],
    },
    async execute(rawArgs, exec) {
      const args = validate('room_report', rawArgs, {
        status: { type: 'enum', required: true, values: ['done', 'blocked', 'progress'] },
        summary: { type: 'string', required: true, min: 2, max: 8000 },
        files: { type: 'array', max: 20 },
        checks: { type: 'string', max: 2000 },
        question: { type: 'string', max: 2000 },
      });
      const sid = exec?.agent?.id ?? exec?.agent?.session?.header?.id;
      if (!sid) throw new Error('拿不到会话 id，回不了报');
      const room = roomOfSession(sid) ?? rooms.get(ensureRoomForSession(sid, undefined, defaultCwd));
      const text = [
        `[房间回报 · ${roomLabel(room)}]`,
        `状态: ${args.status}`,
        args.summary,
        args.files?.length ? `产出: ${args.files.join(', ')}` : '',
        args.checks ? `自检: ${args.checks}` : '',
        args.question ? `需要主人定: ${args.question}` : '',
      ].filter(Boolean).join('\n');
      pending.delete(room.id);
      rememberReport(room.id, {
        status: args.status,
        summary: args.summary,
        files: args.files ?? [],
        checks: args.checks ?? '',
        question: args.question ?? '',
      });
      void deliverReport(room.id, text);
      log(`收到 ${room.id} 回报（${args.status}）`);
      return { ok: true, detail: '已回报给派活的会话' };
    },
  });

  ctx.tools.register({
    name: 'room_cancel',
    description: '叫停某个房间正在跑的这一轮。不删会话，只是停下来，方便打回或重派。',
    parameters: roomParams,
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.detail ?? '已叫停' }],
    },
    async execute(rawArgs) {
      const args = validate('room_cancel', rawArgs, roomSpec);
      const room = rooms.get(args.room);
      if (!room) throw new Error(`没有这个房间: ${args.room}`);
      const ok = await cancelRoom(room);
      return { ok, detail: ok ? `已叫停「${roomLabel(room)}」` : `「${roomLabel(room)}」没在跑` };
    },
  });

  ctx.tools.register({
    name: 'room_reset',
    description: '把某个房间的会话重开（上下文爆了、跑歪了时用）。旧会话留着，新的从空白开始。',
    parameters: roomParams,
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.detail ?? '已重开' }],
    },
    async execute(rawArgs) {
      const args = validate('room_reset', rawArgs, roomSpec);
      const room = rooms.get(args.room);
      if (!room) throw new Error(`没有这个房间: ${args.room}`);
      const sessionId = await resetRoom(room);
      return { ok: true, detail: `「${roomLabel(room)}」已重开，新会话 ${sessionId}` };
    },
  });

  ctx.tools.register({
    name: 'room_here',
    description: '确认当前会话自己的房间 id 并顺便归组。工作区里每个会话都是房间，这个工具只用来查 id、补个分组。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '分组 id，见 room_list；留空就保持原样' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.detail ?? '好' }],
    },
    async execute(rawArgs, exec) {
      const args = validate('room_here', rawArgs, { group: { type: 'string', max: 64 } });
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.header?.id;
      if (!sessionId) throw new Error('拿不到当前会话 id');
      const titles = await readTitles([sessionId]).catch(() => new Map());
      const roomId = ensureRoomForSession(
        sessionId,
        titles.get(sessionId) || ctx.get?.('sessions')?.get?.(sessionId)?.header?.title,
        ctx.get?.('sessions')?.get?.(sessionId)?.header?.cwd || defaultCwd,
      );
      persist();
      let detail = `你是「${roomLabel(rooms.get(roomId))}」（id ${roomId}），当前分组：${groupName(groupOf(roomId))}`;
      if (args.group) {
        const group = moveRoom(roomId, args.group);
        detail = `你是「${roomLabel(rooms.get(roomId))}」（id ${roomId}），已归到「${groupName(group.groupId)}」`;
      }
      return { ok: true, detail };
    },
  });

  log(`房间工具已注册（${rooms.size} 个房间，状态目录 ${stateDir}）`);
}
