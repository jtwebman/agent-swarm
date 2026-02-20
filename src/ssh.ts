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
export function sshInteractive(info: SshInfo, env?: Record<string, string>): Promise<number> {
  return new Promise(async (resolve) => {
    const server = await startCodeForwarder(info)
    const localPort = (server.address() as import('node:net').AddressInfo).port

    const sshArgs = [
      '-A',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-R', `${CODE_FORWARD_PORT}:127.0.0.1:${localPort}`,
      '-p', String(info.port),
      `${info.user}@${info.host}`,
    ]

    // When env vars are provided, export them then start a login shell
    if (env && Object.keys(env).length > 0) {
      const exports = Object.entries(env)
        .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
        .join(' && ')
      sshArgs.push(exports + ' && exec $SHELL -l')
    }

    const proc = spawn('ssh', sshArgs, {
      stdio: 'inherit',
    })
    proc.on('close', (code) => {
      server.close()
      resolve(code ?? 1)
    })
  })
}

/** Run a command over SSH and return stdout. */
export function sshExec(info: SshInfo, command: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrappedCommand = env && Object.keys(env).length > 0
      ? Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`).join(' && ') + ' && ' + command
      : command
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(info.port),
      `${info.user}@${info.host}`,
      wrappedCommand,
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

/** Run a command over SSH, streaming stdout/stderr to the console. Returns exit code. */
export function sshRun(info: SshInfo, command: string, env?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const wrappedCommand = env && Object.keys(env).length > 0
      ? Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`).join(' && ') + ' && ' + command
      : command
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(info.port),
      `${info.user}@${info.host}`,
      wrappedCommand,
    ], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

const sshOpts = (info: SshInfo) => [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR',
  '-P', String(info.port),
]

/** Copy a local file into a VM. */
export function scpTo(info: SshInfo, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('scp', [
      ...sshOpts(info),
      localPath,
      `${info.user}@${info.host}:${remotePath}`,
    ], { stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`scp to VM failed with code ${code}`))
    })
  })
}

/** Copy a file from a VM to the local machine. */
export function scpFrom(info: SshInfo, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('scp', [
      ...sshOpts(info),
      `${info.user}@${info.host}:${remotePath}`,
      localPath,
    ], { stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`scp from VM failed with code ${code}`))
    })
  })
}
