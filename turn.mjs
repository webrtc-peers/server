import Turn from 'node-turn'
const server = new Turn({
    authMech: 'long-term',
    credentials: {
      '60566123@qq.com': "g468291375"
    }
})
server.start()
