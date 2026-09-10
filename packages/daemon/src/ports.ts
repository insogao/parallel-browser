import net from 'node:net'

/** Get a free TCP port on 127.0.0.1. Tries `preferred` once, then falls back to an ephemeral port. */
export function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, isPreferred: boolean) => {
      const srv = net.createServer()
      srv.once('error', (err: NodeJS.ErrnoException) => {
        if (isPreferred && err.code === 'EADDRINUSE') tryListen(0, false)
        else reject(err)
      })
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo
        srv.close(() => resolve(addr.port))
      })
    }
    tryListen(preferred ?? 0, preferred != null)
  })
}
