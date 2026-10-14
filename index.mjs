import { WebSocketServer } from 'ws'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT) || 9000

const PING_INTERVAL = 30000

// 单条消息上限：SDP / candidate 一般几 KB。ws 默认 100MB，1G 内存的机器几条就能撑爆
const MAX_PAYLOAD = 64 * 1024
// 前面是 nginx stream 转发，所有连接看起来都来自 127.0.0.1，没法按 IP 限，只能限总量
const MAX_CLIENTS = 300
// 每个连接每 10 秒的消息数上限；房间操作会触发全量广播 / 密码校验，单独再限
const RATE_WINDOW = 10000
const RATE_MAX = 1000
const ROOM_OPS_MAX = 20
// 房间列表广播的合并窗口，和单连接发送积压上限
const ROOMS_DEBOUNCE = 200
const MAX_BUFFERED = 1024 * 1024
// 断线后保留身份多久：期间只有带对 token 的客户端才能沿用这个 id
const IDENTITY_TTL = 60 * 60 * 1000
const MAX_IDENTITIES = 10000

// TURN 临时凭据（coturn use-auth-secret / REST API）：密钥只放服务端，按连接下发
const TURN_SECRET = process.env.TURN_SECRET || ''
const TURN_HOST = process.env.TURN_HOST || 'webrtc.web-play.cn'
// coturn 每次 Refresh 都会校验过期时间，有效期要比一次通话长
const TURN_TTL = 24 * 3600
// 定时给在线客户端换新凭据，保证新建连接时手里的凭据至少还剩 18 小时
const ICE_REFRESH = 6 * 3600 * 1000

const ID_RE = /^[\w-]{8,64}$/
const ROOM_RE = /^[\w-]{1,64}$/

const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_PAYLOAD })
// roomid -> { members: Set<id>, name, tips, secret }，密码只留在服务端
const rooms = new Map()
// id -> roomid，同一时间只在一个房间里
const roomOf = new Map()
// id -> ws
const clients = new Map()
// id -> { token, seen }
const identities = new Map()

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function remember(id, token) {
  // 删了再插，Map 的顺序就是最近活跃顺序，超量时从最久没动的开始清
  identities.delete(id)
  identities.set(id, { token, seen: Date.now() })
  if (identities.size <= MAX_IDENTITIES) return
  for (const key of identities.keys()) {
    if (!clients.has(key)) {
      identities.delete(key)
      break
    }
  }
}

// 客户端在 url 上带 ?id=xxx&token=yyy，断线重连沿用同一个 id，对端手里的 toSocketId 才不会失效。
// 服务端没见过的 id（首次连接、服务重启后）直接认领；见过的必须带对 token，
// 否则别人拿房间列表里的 id 连上来就能把原用户顶掉、截走发给他的 offer / answer
function resolveIdentity(req) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams
    const id = params.get('id')
    const token = params.get('token')
    if (id && ID_RE.test(id)) {
      const known = identities.get(id)
      if (!known) return { id, token: randomBytes(24).toString('base64url') }
      if (token && safeEqual(token, known.token)) return { id, token: known.token }
    }
  } catch {}
  return { id: randomBytes(12).toString('base64url'), token: randomBytes(24).toString('base64url') }
}

function iceServers() {
  const list = [{ urls: `stun:${TURN_HOST}:3478` }]
  if (!TURN_SECRET) return list
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:webrtc-peers`
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64')
  list.push(
    { urls: `turn:${TURN_HOST}:3478`, username, credential },
    { urls: `turns:${TURN_HOST}:5349`, username, credential },
  )
  return list
}

// 对外只给名字、描述和是否有密码
function publicRooms() {
  const out = {}
  for (const [roomid, room] of rooms) {
    out[roomid] = {
      explain: { name: room.name, tips: room.tips, locked: Boolean(room.secret) },
      socketIds: [...room.members].map(id => ({ id })),
    }
  }
  return out
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data })
  for (const ws of clients.values()) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

// 全量房间列表 × 所有客户端，每次进出房都发会按 N² 放大：300 人集中进房实测能把内存撑到 2G。
// 一个窗口内的变动合并成一次；积压太多的连接说明收不过来，跳过这次，下次还是全量
let roomsTimer = null
function broadcastRooms() {
  if (roomsTimer) return
  roomsTimer = setTimeout(() => {
    roomsTimer = null
    const msg = JSON.stringify({ type: 'rooms', data: publicRooms() })
    for (const ws of clients.values()) {
      if (ws.readyState === 1 && ws.bufferedAmount < MAX_BUFFERED) ws.send(msg)
    }
  }, ROOMS_DEBOUNCE)
}

function sendTo(ws, type, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data }))
  }
}

function sendToId(targetId, type, data) {
  const target = clients.get(targetId)
  if (target) sendTo(target, type, data)
}

function secretOk(room, secret) {
  return !room.secret || (typeof secret === 'string' && safeEqual(secret, room.secret))
}

// notify：主动离开时通知房间里剩下的人关掉对应连接，否则对端要等 ICE 超时（几十秒）才发现，期间人数和画面都是旧的。
// 断线不通知：信令断了 P2P 可能还通着，重连 rejoin 后还能接着用
function leaveRoom(id, notify = false) {
  const roomid = roomOf.get(id)
  if (!roomid) return false
  roomOf.delete(id)
  const room = rooms.get(roomid)
  if (!room) return false
  room.members.delete(id)
  if (!room.members.size) rooms.delete(roomid)
  if (notify) {
    for (const member of room.members) sendToId(member, 'peer-leave', { socketid: id })
  }
  return true
}

function enterRoom(id, roomid) {
  if (roomOf.get(id) !== roomid) leaveRoom(id, true)
  rooms.get(roomid).members.add(id)
  roomOf.set(id, roomid)
}

function dropClient(id, ws) {
  // 同一个 id 已经重连上来了，旧连接关闭时不能把新连接踢出房间
  if (clients.get(id) !== ws) return
  clients.delete(id)
  const identity = identities.get(id)
  if (identity) remember(id, identity.token)
  if (leaveRoom(id)) {
    broadcastRooms()
    broadcast('broken', { socketid: id })
  }
}

function heartbeat(ws) {
  ws._alive = true
}

// 超限返回 true；滥用的连接直接断开，正常客户端会自己重连
function overLimit(ws, isRoomOp) {
  const now = Date.now()
  if (now - ws._rateStart > RATE_WINDOW) {
    ws._rateStart = now
    ws._msgCount = 0
    ws._roomOps = 0
  }
  ws._msgCount++
  if (isRoomOp) ws._roomOps++
  return ws._msgCount > RATE_MAX || ws._roomOps > ROOM_OPS_MAX
}

const ROOM_OPS = new Set(['create-room', 'jion', 'rejoin', 'leave', 'check-secret'])

wss.on('connection', (ws, req) => {
  // 没有 error 监听时，超大消息 / 非法帧触发的 error 会让整个进程崩掉
  ws.on('error', () => {})

  if (clients.size >= MAX_CLIENTS) {
    ws.close(1013, 'server busy')
    return
  }

  const { id, token } = resolveIdentity(req)
  const prev = clients.get(id)
  clients.set(id, ws)
  remember(id, token)
  if (prev && prev !== ws) prev.terminate()
  ws._socketId = id
  ws._alive = true
  ws._rateStart = Date.now()
  ws._msgCount = 0
  ws._roomOps = 0

  sendTo(ws, '__connect__', { id, token, iceServers: iceServers() })
  sendTo(ws, 'rooms', publicRooms())

  ws.on('message', (raw) => {
    heartbeat(ws)
    try {
      const msg = JSON.parse(raw.toString())
      const { type, data } = msg

      if (type === 'pong') return

      if (overLimit(ws, ROOM_OPS.has(type))) {
        ws.close(1008, 'rate limit')
        return
      }

      switch (type) {
        case 'create-room': {
          const roomid = data?.roomid
          if (typeof roomid !== 'string' || !ROOM_RE.test(roomid) || rooms.has(roomid)) break
          const explain = data.explain ?? {}
          rooms.set(roomid, {
            members: new Set(),
            name: text(explain.name, 50),
            tips: text(explain.tips, 200),
            secret: text(explain.secret, 100),
          })
          enterRoom(id, roomid)
          broadcastRooms()
          break
        }

        // 输密码的弹窗先问一下对不对；真正进房时还会再校验一次
        case 'check-secret': {
          const room = typeof data?.roomid === 'string' ? rooms.get(data.roomid) : undefined
          sendTo(ws, 'check-secret', { roomid: data?.roomid, ok: Boolean(room) && secretOk(room, data.secret) })
          break
        }

        case 'jion': {
          const roomid = data?.roomid
          const room = typeof roomid === 'string' ? rooms.get(roomid) : undefined
          if (!room) {
            sendTo(ws, 'jion', { roomid, socketIds: null })
            break
          }
          if (!secretOk(room, data?.secret)) {
            sendTo(ws, 'jion', { roomid, socketIds: null, denied: true })
            break
          }
          // 加入的同时把现有成员回给加入者，由它逐个发起连接，不依赖前端可能过期的房间列表
          const socketIds = [...room.members].filter(m => m !== id).map(m => ({ id: m }))
          enterRoom(id, roomid)
          sendTo(ws, 'jion', { roomid, socketIds })
          broadcastRooms()
          break
        }

        case 'rejoin': {
          // 断线重连后恢复成员身份；房间如果已经因为没人被销毁，就按原信息重建
          const roomid = data?.roomid
          if (typeof roomid !== 'string' || !ROOM_RE.test(roomid)) break
          const room = rooms.get(roomid)
          if (!room) {
            if (!data.explain) break
            rooms.set(roomid, {
              members: new Set(),
              name: text(data.explain.name, 50),
              tips: text(data.explain.tips, 200),
              secret: text(data.secret, 100),
            })
          } else if (!secretOk(room, data.secret)) {
            break
          }
          enterRoom(id, roomid)
          broadcastRooms()
          break
        }

        case 'leave':
          if (data && roomOf.get(id) === data && leaveRoom(id, true)) broadcastRooms()
          break

        // 只在同一个房间的成员之间转发，防止绕过房间（和密码）直接呼叫任意用户
        case 'offer':
        case 'answer':
        case 'candidate': {
          const roomid = roomOf.get(id)
          if (!roomid || typeof data?.to !== 'string' || roomOf.get(data.to) !== roomid) break
          sendToId(data.to, type, { ...data, from: id })
          break
        }
      }
    } catch {}
  })

  ws.on('close', () => dropClient(id, ws))
})

wss.on('error', (err) => {
  console.error('signaling server error', err)
  process.exit(1)
})

const pingTimer = setInterval(() => {
  for (const [id, ws] of clients) {
    if (!ws._alive) {
      ws.terminate()
      dropClient(id, ws)
      continue
    }
    ws._alive = false
    sendTo(ws, 'ping')
  }
  const expired = Date.now() - IDENTITY_TTL
  for (const [id, identity] of identities) {
    if (identity.seen > expired) break
    if (!clients.has(id)) identities.delete(id)
  }
}, PING_INTERVAL)

const iceTimer = setInterval(() => {
  if (!TURN_SECRET) return
  for (const ws of clients.values()) sendTo(ws, 'ice', iceServers())
}, ICE_REFRESH)

wss.on('close', () => {
  clearInterval(pingTimer)
  clearInterval(iceTimer)
  clearTimeout(roomsTimer)
})

if (!TURN_SECRET) console.warn('TURN_SECRET 未设置，只下发 STUN')
console.log(`signaling server listening on ws://${HOST}:${PORT}`)
