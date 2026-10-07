import { createServer, type Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
export async function imapFixture(options: { tls?: { key: Buffer; cert: Buffer }; idle?: boolean } = {}) {
  const messages: { uid: number; raw: Buffer }[] = []
  const sockets = new Set<Socket>()
  const commands: string[] = []
  let validity = 1
  const idleTags = new Map<Socket, string>()
  const connect = (socket: Socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    socket.write('* OK Fixture ready\r\n')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString()
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        commands.push(line)
        if (line === 'DONE') { const tag = idleTags.get(socket); idleTags.delete(socket); socket.write(`${tag} OK idle ended\r\n`); continue }
        const [tag, cmd, ...args] = line.split(' ')
        const command = cmd?.toUpperCase()
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN${options.idle ? ' IDLE' : ''}\r\n`)
        else if (command === 'IDLE') { idleTags.set(socket, tag); socket.write('+ idling\r\n'); continue }
        else if (command === 'LIST' || command === 'LSUB') socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n')
        else if (command === 'SELECT' || command === 'EXAMINE') {
          socket.write(`* FLAGS (\\Seen)\r\n* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${validity}] valid\r\n* OK [UIDNEXT ${(messages.at(-1)?.uid || 0) + 1}] next\r\n`)
        } else if (command === 'NOOP') socket.write(`* ${messages.length} EXISTS\r\n`)
        else if (command === 'UID' && args[0]?.toUpperCase() === 'FETCH') {
          const range = args[1]; const from = Number(range.split(':')[0]); const to = range.includes(':') ? Infinity : from
          for (let i = 0; i < messages.length; i++) {
            const message = messages[i]
            if (message.uid < from || message.uid > to) continue
            if (/BODY/i.test(line)) {
              socket.write(`* ${i + 1} FETCH (UID ${message.uid} BODY[] {${message.raw.length}}\r\n`)
              socket.write(message.raw); socket.write(')\r\n')
            } else socket.write(`* ${i + 1} FETCH (UID ${message.uid} RFC822.SIZE ${message.raw.length})\r\n`)
          }
        } else if (command === 'LOGOUT') { socket.end('* BYE Logout\r\n' + `${tag} OK logout\r\n`); continue }
        else if (!['LOGIN', 'AUTHENTICATE', 'CHECK', 'CLOSE'].includes(command)) { socket.write(`${tag} BAD Unsupported fixture command\r\n`); continue }
        socket.write(`${tag} OK completed\r\n`)
      }
    })
  }
  const server = options.tls ? createTlsServer(options.tls, connect) : createServer(connect)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port, commands,
    append(raw: string) { const uid = (messages.at(-1)?.uid || 0) + 1; messages.push({ uid, raw: Buffer.from(raw) }); for (const socket of idleTags.keys()) socket.write(`* ${messages.length} EXISTS\r\n`) },
    reset() { validity++; for (const socket of sockets) socket.destroy() },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
