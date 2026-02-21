import type { Provider, VmInfo, VmStatus, SshInfo } from '../provider.ts'
import { exec, execOk } from '../exec.ts'
import { createCloudInitISO } from '../cloud-init.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VM_PREFIX = 'agent-swarm-'
const PROJECT_PREFIX = 'project-'
const SWARM_DIR = join(homedir(), '.agent-swarm')
const VMS_DIR = join(SWARM_DIR, 'vms')
const SNAPSHOTS_DIR = join(SWARM_DIR, 'snapshots')

type VMConfig = {
  cpus: number
  memoryMB: number
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

async function waitForIp(vmId: string, timeoutMs = 90_000): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await exec('virsh', ['domifaddr', vmId, '--source', 'lease'])
      // Parse output: lines like " vnet0  52:54:00:xx:xx:xx  ipv4  192.168.122.x/24"
      for (const line of raw.split('\n')) {
        const match = line.match(/ipv4\s+(\d+\.\d+\.\d+\.\d+)/)
        if (match) return match[1]
      }
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

export function createKvmProvider(): Provider {
  return {
    name: 'kvm',

    async available(): Promise<boolean> {
      if (process.platform !== 'linux') return false
      // Check for required tools
      const hasVirsh = await execOk('virsh', ['--version'])
      const hasVirtInstall = await execOk('virt-install', ['--version'])
      const hasQemuImg = await execOk('qemu-img', ['--version'])
      if (!hasVirsh || !hasVirtInstall || !hasQemuImg) return false
      // Check that the default network exists
      return execOk('virsh', ['net-info', 'default'])
    },

    async createVm(task: string, baseImage: string): Promise<VmInfo> {
      const isTaskClone = baseImage.startsWith(VMS_DIR)

      const name = isTaskClone ? vmName(task) : projectVmName(task)
      const dir = isTaskClone ? vmDir(task) : projectVmDir(task)
      mkdirSync(dir, { recursive: true })

      const diskPath = join(dir, 'disk.qcow2')

      if (isTaskClone) {
        // Task clone: create qcow2 backing file (instant, space-efficient)
        console.log('  Creating disk (qcow2 backing file)...')
        await exec('qemu-img', ['create', '-f', 'qcow2', '-b', baseImage, '-F', 'qcow2', diskPath])
      } else {
        // Project VM from base image: copy with reflink if supported
        console.log('  Cloning disk (copy-on-write)...')
        await exec('cp', ['--reflink=auto', baseImage, diskPath])
        // Resize to 20GB
        await exec('qemu-img', ['resize', diskPath, '20G'])
      }

      if (!isTaskClone) {
        console.log('  Creating cloud-init config...')
        await createCloudInitISO(dir, task)
      } else {
        // Copy project's cidata.iso
        const projectDir = join(baseImage, '..')
        const projectCidata = join(projectDir, 'cidata.iso')
        if (existsSync(projectCidata)) {
          await exec('cp', ['--reflink=auto', projectCidata, join(dir, 'cidata.iso')])
        }
      }

      // Write config
      const config: VMConfig = { cpus: 2, memoryMB: 4096 }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))

      // Start VM with virt-install
      console.log('  Starting VM...')
      const virtInstallArgs = [
        '--name', name,
        '--memory', String(config.memoryMB),
        '--vcpus', String(config.cpus),
        '--disk', `path=${diskPath},format=qcow2`,
        '--disk', `path=${join(dir, 'cidata.iso')},device=cdrom`,
        '--os-variant', 'ubuntu24.04',
        '--network', 'network=default',
        '--boot', 'uefi',
        '--import',
        '--noautoconsole',
      ]
      await exec('virt-install', virtInstallArgs)

      // Wait for IP
      console.log('  Waiting for VM to boot and get IP...')
      const ip = await waitForIp(name)

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
      await exec('virsh', ['start', vmId])
      await waitForIp(vmId)
    },

    async stopVm(vmId: string): Promise<void> {
      try {
        await exec('virsh', ['shutdown', vmId])
        // Wait up to 30s for graceful shutdown
        const start = Date.now()
        while (Date.now() - start < 30_000) {
          const state = await exec('virsh', ['domstate', vmId])
          if (state.trim() === 'shut off') return
          await new Promise(r => setTimeout(r, 2000))
        }
      } catch { /* may already be off */ }
      // Force stop if graceful shutdown didn't work
      try {
        await exec('virsh', ['destroy', vmId])
      } catch { /* already off */ }
    },

    async deleteVm(vmId: string): Promise<void> {
      try { await exec('virsh', ['destroy', vmId]) } catch { /* may be off */ }
      try { await exec('virsh', ['undefine', vmId, '--nvram']) } catch { /* may not exist */ }
      const dir = join(VMS_DIR, vmId)
      if (existsSync(dir)) await exec('rm', ['-rf', dir])
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      if (existsSync(snapDir)) await exec('rm', ['-rf', snapDir])
    },

    async sshInfo(vmId: string): Promise<SshInfo> {
      const ip = await waitForIp(vmId, 15_000)
      if (!ip) throw new Error(`Cannot get IP for ${vmId} - is it running?`)
      return { host: ip, port: 22, user: 'worker' }
    },

    async checkpoint(vmId: string, name: string): Promise<void> {
      // Stop VM for consistent snapshot
      try {
        await exec('virsh', ['shutdown', vmId])
        const start = Date.now()
        while (Date.now() - start < 30_000) {
          const state = await exec('virsh', ['domstate', vmId])
          if (state.trim() === 'shut off') break
          await new Promise(r => setTimeout(r, 2000))
        }
      } catch { /* may already be stopped */ }

      const diskPath = join(VMS_DIR, vmId, 'disk.qcow2')
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      mkdirSync(snapDir, { recursive: true })

      // Copy with reflink if supported (btrfs/xfs)
      await exec('cp', ['--reflink=auto', diskPath, join(snapDir, `${name}.qcow2`)])
    },

    async restore(vmId: string, name: string): Promise<void> {
      try {
        await exec('virsh', ['shutdown', vmId])
        const start = Date.now()
        while (Date.now() - start < 30_000) {
          const state = await exec('virsh', ['domstate', vmId])
          if (state.trim() === 'shut off') break
          await new Promise(r => setTimeout(r, 2000))
        }
      } catch { /* may already be stopped */ }

      const diskPath = join(VMS_DIR, vmId, 'disk.qcow2')
      const snapPath = join(SNAPSHOTS_DIR, vmId, `${name}.qcow2`)
      if (!existsSync(snapPath)) throw new Error(`Snapshot '${name}' not found`)

      await exec('rm', ['-f', diskPath])
      await exec('cp', ['--reflink=auto', snapPath, diskPath])
    },

    async listCheckpoints(vmId: string): Promise<string[]> {
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      if (!existsSync(snapDir)) return []
      const out = await exec('ls', [snapDir])
      return out.split('\n').filter(Boolean).map(f => f.replace(/\.qcow2$/, ''))
    },

    async status(vmId: string): Promise<VmStatus> {
      try {
        const state = (await exec('virsh', ['domstate', vmId])).trim()
        if (state === 'running') return 'running'
        if (state === 'shut off') return 'stopped'
        return 'unknown'
      } catch {
        return 'stopped'
      }
    },

    async listVms(): Promise<VmInfo[]> {
      let raw: string
      try {
        raw = await exec('virsh', ['list', '--all', '--name'])
      } catch {
        return []
      }
      const names = raw.split('\n').filter(Boolean)
        .filter(n => n.startsWith(VM_PREFIX) || n.startsWith(PROJECT_PREFIX))

      const results: VmInfo[] = []
      for (const name of names) {
        const state = await exec('virsh', ['domstate', name]).then(s => s.trim()).catch(() => 'unknown')
        let ip: string | null = null
        if (state === 'running') {
          ip = await waitForIp(name, 5000).catch(() => null)
        }
        results.push({
          vmId: name,
          task: name.startsWith(PROJECT_PREFIX)
            ? name.slice(PROJECT_PREFIX.length)
            : name.slice(VM_PREFIX.length),
          ip,
          status: state === 'running' ? 'running' : state === 'shut off' ? 'stopped' : 'unknown',
        })
      }
      return results
    },

    projectDiskPath(name: string): string {
      return join(projectVmDir(name), 'disk.qcow2')
    },
  }
}
