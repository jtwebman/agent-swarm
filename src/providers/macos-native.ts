import type { Provider, VmInfo, VmStatus, SshInfo } from '../provider.ts'
import { exec, execOk } from '../exec.ts'
import { createCloudInitISO } from '../cloud-init.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const VM_PREFIX = 'agent-swarm-'
const PROJECT_PREFIX = 'project-'
const SWARM_DIR = join(homedir(), '.agent-swarm')
const VMS_DIR = join(SWARM_DIR, 'vms')
const SNAPSHOTS_DIR = join(SWARM_DIR, 'snapshots')
const BIN_DIR = join(SWARM_DIR, 'bin')
const HELPER_BIN = join(BIN_DIR, 'vm-helper')

// Resolve source paths relative to this module
const MODULE_DIR = import.meta.dirname!
const HELPER_SRC = join(MODULE_DIR, '..', 'vm-helper', 'main.swift')
const ENTITLEMENTS = join(MODULE_DIR, '..', 'vm-helper', 'entitlements.plist')

type VMConfig = {
  cpus: number
  memoryMB: number
  macAddress: string
}

async function ensureHelper(): Promise<void> {
  if (existsSync(HELPER_BIN)) {
    const srcMtime = statSync(HELPER_SRC).mtimeMs
    const binMtime = statSync(HELPER_BIN).mtimeMs
    if (binMtime >= srcMtime) return
  }

  // Check for swiftc
  if (!(await execOk('swiftc', ['--version']))) {
    throw new Error(
      'Swift compiler not found. Install Xcode Command Line Tools:\n  xcode-select --install'
    )
  }

  console.log('Compiling VM helper (first run only)...')
  mkdirSync(BIN_DIR, { recursive: true })
  await exec('swiftc', ['-O', '-framework', 'Virtualization', HELPER_SRC, '-o', HELPER_BIN])
  await exec('codesign', ['--entitlements', ENTITLEMENTS, '--force', '-s', '-', HELPER_BIN])
  console.log('VM helper compiled.')
}

async function vmHelper(...args: string[]): Promise<string> {
  await ensureHelper()
  return exec(HELPER_BIN, args)
}

function vmName(task: string): string {
  return `${VM_PREFIX}${task}`
}

function vmDir(task: string): string {
  return join(VMS_DIR, vmName(task))
}

function projectVmName(name: string): string {
  return `${PROJECT_PREFIX}${name}`
}

function projectVmDir(name: string): string {
  return join(VMS_DIR, projectVmName(name))
}

function generateMacAddress(): string {
  // Generate a locally administered, unicast MAC address
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  bytes[0] = (bytes[0] & 0xfc) | 0x02 // locally administered, unicast
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(':')
}

async function waitForIp(name: string, timeoutMs = 90_000): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const ip = await vmHelper('ip', name)
      if (ip) return ip
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 3000))
  }
  return null
}

async function waitForSsh(ip: string, user: string, timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await exec('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=3',
        '-o', 'BatchMode=yes',
        `${user}@${ip}`, 'true',
      ])
      return true
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 3000))
  }
  return false
}

async function waitForCloudInit(ip: string, user: string, timeoutMs = 600_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await exec('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=3',
        '-o', 'BatchMode=yes',
        `${user}@${ip}`,
        'cloud-init status --wait 2>/dev/null || cat /run/cloud-init/result.json 2>/dev/null || echo pending',
      ])
      if (result.includes('done') || result.includes('result')) return true
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 5000))
  }
  return false
}

export function createMacNativeProvider(): Provider {
  return {
    name: 'macos-native',

    async available(): Promise<boolean> {
      if (process.platform !== 'darwin') return false
      return execOk('swiftc', ['--version'])
    },

    async createVm(task: string, baseImage: string): Promise<VmInfo> {
      // Determine if this is a task clone (source is a project disk inside VMS_DIR)
      const isTaskClone = baseImage.startsWith(VMS_DIR)

      const name = isTaskClone ? vmName(task) : projectVmName(task)
      const dir = isTaskClone ? vmDir(task) : projectVmDir(task)
      mkdirSync(dir, { recursive: true })

      // Clone base image using APFS copy-on-write (instant)
      const diskPath = join(dir, 'disk.img')
      console.log('  Cloning disk (APFS copy-on-write)...')
      await exec('cp', ['-c', baseImage, diskPath])

      if (!isTaskClone) {
        // Project VM from base image: resize disk and create cloud-init
        const desiredSize = 20 * 1024 * 1024 * 1024
        const fd = openSync(diskPath, 'r+')
        const currentSize = statSync(diskPath).size
        if (currentSize < desiredSize) {
          ftruncateSync(fd, desiredSize)
        }
        closeSync(fd)

        console.log('  Creating cloud-init config...')
        await createCloudInitISO(dir, task)
      } else {
        // Task clone: copy the project's cidata.iso for network config
        const projectDir = join(baseImage, '..')
        const projectCidata = join(projectDir, 'cidata.iso')
        if (existsSync(projectCidata)) {
          await exec('cp', ['-c', projectCidata, join(dir, 'cidata.iso')])
        }
      }

      // Create VM config — for task clones, reuse the project's MAC address
      // so the guest network config (netplan) matches the interface
      let macAddress: string
      if (isTaskClone) {
        const projectConfigPath = join(baseImage, '..', 'config.json')
        const projectConfig: VMConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'))
        macAddress = projectConfig.macAddress
      } else {
        macAddress = generateMacAddress()
      }
      const config: VMConfig = { cpus: 2, memoryMB: 4096, macAddress }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))

      // Start the VM
      console.log('  Starting VM...')
      await ensureHelper()
      const proc = spawn(HELPER_BIN, ['run', name], {
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()

      // Wait for IP
      console.log('  Waiting for VM to boot and get IP...')
      const ip = await waitForIp(name)

      // Wait for SSH to become reachable (cloud-init may still be creating the user)
      if (ip) {
        console.log('  Waiting for SSH...')
        await waitForSsh(ip, 'worker')

        if (!isTaskClone) {
          console.log('  Waiting for setup to complete (this may take a few minutes)...')
          await waitForCloudInit(ip, 'worker')
        }
      }

      return { vmId: name, task, ip, status: 'running' }
    },

    async startVm(vmId: string): Promise<void> {
      await ensureHelper()
      const proc = spawn(HELPER_BIN, ['run', vmId], {
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()
      await waitForIp(vmId)
    },

    async stopVm(vmId: string): Promise<void> {
      await vmHelper('stop', vmId)
    },

    async deleteVm(vmId: string): Promise<void> {
      try { await vmHelper('stop', vmId) } catch { /* may already be stopped */ }
      const dir = join(VMS_DIR, vmId)
      if (existsSync(dir)) await exec('rm', ['-rf', dir])
      // Also clean up snapshots
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      if (existsSync(snapDir)) await exec('rm', ['-rf', snapDir])
    },

    async sshInfo(vmId: string): Promise<SshInfo> {
      const ip = (await vmHelper('ip', vmId)).trim()
      if (!ip) throw new Error(`Cannot get IP for ${vmId} - is it running?`)
      return { host: ip, port: 22, user: 'worker' }
    },

    async checkpoint(vmId: string, name: string): Promise<void> {
      // Stop VM for consistent snapshot
      try { await vmHelper('stop', vmId) } catch { /* may already be stopped */ }

      const diskPath = join(VMS_DIR, vmId, 'disk.img')
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      mkdirSync(snapDir, { recursive: true })

      // APFS copy-on-write clone (instant, space-efficient)
      await exec('cp', ['-c', diskPath, join(snapDir, `${name}.img`)])
    },

    async restore(vmId: string, name: string): Promise<void> {
      try { await vmHelper('stop', vmId) } catch { /* may already be stopped */ }

      const diskPath = join(VMS_DIR, vmId, 'disk.img')
      const snapPath = join(SNAPSHOTS_DIR, vmId, `${name}.img`)
      if (!existsSync(snapPath)) throw new Error(`Snapshot '${name}' not found`)

      await exec('rm', ['-f', diskPath])
      await exec('cp', ['-c', snapPath, diskPath])
    },

    async listCheckpoints(vmId: string): Promise<string[]> {
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      if (!existsSync(snapDir)) return []
      const out = await exec('ls', [snapDir])
      return out.split('\n').filter(Boolean).map(f => f.replace(/\.img$/, ''))
    },

    async status(vmId: string): Promise<VmStatus> {
      const pidPath = join(VMS_DIR, vmId, 'pid')
      if (!existsSync(pidPath)) return 'stopped'
      // Check if PID is alive
      try {
        const pid = readFileSync(pidPath, 'utf8').trim()
        process.kill(parseInt(pid), 0) // signal 0 = check if alive
        return 'running'
      } catch {
        return 'stopped'
      }
    },

    async listVms(): Promise<VmInfo[]> {
      const raw = await vmHelper('list')
      const vms: Array<{ name: string; status: string; ip: string | null }> = JSON.parse(raw)
      return vms
        .filter(v => v.name.startsWith(VM_PREFIX) || v.name.startsWith(PROJECT_PREFIX))
        .map(v => ({
          vmId: v.name,
          task: v.name.startsWith(PROJECT_PREFIX)
            ? v.name.slice(PROJECT_PREFIX.length)
            : v.name.slice(VM_PREFIX.length),
          ip: v.ip,
          status: (v.status as VmStatus) || 'unknown',
        }))
    },

    projectDiskPath(name: string): string {
      return join(projectVmDir(name), 'disk.img')
    },
  }
}
