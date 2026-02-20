import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { spawn as nodeSpawn } from 'node:child_process'
import type { SshInfo } from './provider.ts'

const CODE_FORWARD_PORT = 19418

/** Start a TCP listener that receives paths and opens VS Code remotely. */
export function startCodeForwarder(info: SshInfo): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let data = ''
      socket.on('data', (chunk) => { data += chunk.toString() })
      socket.on('end', () => {
        const remotePath = data.trim()
        if (!remotePath) return
        const remote = `ssh-remote+${info.user}@${info.host}`
        nodeSpawn('code', ['--remote', remote, remotePath], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
    server.on('error', reject)
  })
}

/** Open an interactive SSH session with code forwarding. Returns when the session ends. */
export function sshInteractive(info: SshInfo): Promise<number> {
  return new Promise(async (resolve) => {
    const server = await startCodeForwarder(info)
    const localPort = (server.address() as import('node:net').AddressInfo).port

    const proc = spawn('ssh', [
      '-A',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-R', `${CODE_FORWARD_PORT}:127.0.0.1:${localPort}`,
      '-p', String(info.port),
      `${info.user}@${info.host}`,
    ], {
      stdio: 'inherit',
    })
    proc.on('close', (code) => {
      server.close()
      resolve(code ?? 1)
    })
  })
}

/** Run a command over SSH and return stdout. */
export function sshExec(info: SshInfo, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(info.port),
      `${info.user}@${info.host}`,
      command,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || `SSH command failed with code ${code}`))
    })
  })
}
