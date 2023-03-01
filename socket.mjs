

const rooms = {} //'uuid-key':{data} [{name:'xxx',  tips: 'xxx', videos:['id','id']}]

const leave = function(roomid, socketid) {
  const room = rooms[roomid]
  if (!room||!room.socketIds) return false
  console.log(room.socketIds)
  let index = room.socketIds.findIndex(val => val.id === socketid)
  if (index === -1) return false
  room.socketIds.splice(index, 1)

  if (!room.socketIds.length) {
    delete rooms[roomid]
  }
  return true
}


export default ({ socket, io }) => {
  socket.emit('rooms', rooms)

  socket.on('disconnect', function() {
    console.log('disconnect', socket.id)
    const keys = Object.keys(rooms)

    const broken = keys.some(it => {
      let haveLeave = leave(it, socket.id)
      if (!haveLeave) return false

      // 房间被删除
      if (!rooms[it]) {
        io.emit('rooms', rooms)
      }
      return true
    })

    if (broken) {
      io.emit('broken', { socketid: socket.id })
    }
  })

  socket.on('jion', roomid => {
    const room = rooms[roomid]
    if(!room || !room.socketIds) return // 掉线后
    const find = room.socketIds.find(val => val.id === socket.id)
    if (find) return
    room.socketIds.push({ id: socket.id })
    io.emit('rooms', rooms)
  })

  socket.on('create-room', ({ roomid, explain }) => {
    rooms[roomid] = {
      socketIds: [{ id: socket.id }],
      explain
    }

    io.emit('rooms', rooms)
  })

  socket.on('offer', data => {
    socket.to(data.to).emit('offer', data)
  })

  socket.on('answer', data => {
    socket.to(data.to).emit('answer', data)
  })

  socket.on('candidate', data => {
    socket.to(data.to).emit('candidate', data)
  })

  socket.on('leave', roomid => {
    leave(roomid, socket.id)
    io.emit('rooms', rooms)
  })
}
