import { WebSocketServer } from 'ws'

const PING_INTERVAL = 30000
const PONG_TIMEOUT = 60000

const wss = new WebSocketServer({ port: 9000 })
const rooms = {}
const clients = new Map()

let idCounter = 0
function nextId() {
  return String(++idCounter)
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data })
  for (const ws of clients.values()) {
    if (ws.readyState === 1) ws.send(msg)
  }
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

function leave(roomid, socketid) {
  const room = rooms[roomid]
  if (!room || !room.socketIds) return false
  const index = room.socketIds.findIndex(val => val.id === socketid)
  if (index === -1) return false
  room.socketIds.splice(index, 1)
  if (!room.socketIds.length) {
    delete rooms[roomid]
  }
  return true
}

function heartbeat(ws) {
  ws._alive = true
}

wss.on('connection', (ws) => {
  const id = nextId()
  clients.set(id, ws)
  ws._socketId = id
  ws._alive = true

  sendTo(ws, '__connect__', { id })
  sendTo(ws, 'rooms', rooms)

  ws.on('message', (raw) => {
    heartbeat(ws)
    try {
      const msg = JSON.parse(raw.toString())
      const { type, data } = msg

      if (type === 'pong') return

      switch (type) {
        case 'create-room':
          rooms[data.roomid] = {
            socketIds: [{ id }],
            explain: data.explain,
          }
          broadcast('rooms', rooms)
          break

        case 'jion':
          const room = rooms[data]
          if (!room || !room.socketIds) return
          if (room.socketIds.find(val => val.id === id)) return
          room.socketIds.push({ id })
          broadcast('rooms', rooms)
          break

        case 'leave':
          leave(data, id)
          broadcast('rooms', rooms)
          break

        case 'offer':
          sendToId(data.to, 'offer', { ...data, from: id })
          break

        case 'answer':
          sendToId(data.to, 'answer', { ...data, from: id })
          break

        case 'candidate':
          sendToId(data.to, 'candidate', { ...data, from: id })
          break
      }
    } catch {}
  })

  ws.on('close', () => {
    clients.delete(id)
    const keys = Object.keys(rooms)
    let broken = false
    for (const key of keys) {
      if (leave(key, id)) {
        broken = true
        if (!rooms[key]) {
          broadcast('rooms', rooms)
        }
      }
    }
    if (broken) {
      broadcast('broken', { socketid: id })
    }
  })
})

const pingTimer = setInterval(() => {
  for (const [id, ws] of clients) {
    if (!ws._alive) {
      ws.terminate()
      clients.delete(id)
      const keys = Object.keys(rooms)
      let broken = false
      for (const key of keys) {
        if (leave(key, id)) {
          broken = true
          if (!rooms[key]) {
            broadcast('rooms', rooms)
          }
        }
      }
      if (broken) {
        broadcast('broken', { socketid: id })
      }
      continue
    }
    ws._alive = false
    ws.send(JSON.stringify({ type: 'ping' }))
  }
}, PING_INTERVAL)

wss.on('close', () => {
  clearInterval(pingTimer)
})

console.log('signaling server listening on ws://0.0.0.0:9000')