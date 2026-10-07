import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
export async function testCertificate() {
  const directory = await mkdtemp(join(tmpdir(), 'email-tls-'))
  const keyPath = join(directory, 'key.pem'); const certPath = join(directory, 'cert.pem')
  const process = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' })
  if (await process.exited !== 0) throw new Error('Could not generate disposable TLS certificate')
  return { key: await readFile(keyPath), cert: await readFile(certPath), certPath, close: () => rm(directory, { recursive: true, force: true }) }
}
