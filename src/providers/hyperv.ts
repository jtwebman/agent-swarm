import type { Provider, VmInfo, VmStatus, SshInfo } from '../provider.ts'
import { exec, execOk } from '../exec.ts'
import { createCloudInitISO } from '../cloud-init.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VM_PREFIX = 'agent-swarm-'
const PROJECT_PREFIX = 'project-'
const SWARM_DIR = join(homedir(), '.agent-swarm')
const VMS_DIR = join(SWARM_DIR, 'vms')
const SNAPSHOTS_DIR = join(SWARM_DIR, 'snapshots')

// NAT switch configuration
const SWITCH_NAME = 'AgentSwarmNAT'
const NAT_NAME = 'AgentSwarmNet'
const NAT_SUBNET = '172.28.0.0/24'
const NAT_GATEWAY = '172.28.0.1'
const NAT_PREFIX_LENGTH = 24

type VMConfig = {
  cpus: number
  memoryMB: number
}

/** Run a PowerShell command and return stdout. */
async function ps(script: string): Promise<string> {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
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

async function ensureNatSwitch(): Promise<void> {
  // Check if our switch already exists
  const exists = await ps(
    `Get-VMSwitch -Name '${SWITCH_NAME}' -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`
  )
  if (exists.trim() !== '0') return

  console.log('  Creating Hyper-V NAT switch (one-time setup)...')
  await ps(`New-VMSwitch -SwitchName '${SWITCH_NAME}' -SwitchType Internal`)
  // Get the interface index of the new switch
  const ifIndex = await ps(
    `(Get-NetAdapter | Where-Object { $_.Name -like '*${SWITCH_NAME}*' }).ifIndex`
  )
  await ps(
    `New-NetIPAddress -IPAddress '${NAT_GATEWAY}' -PrefixLength ${NAT_PREFIX_LENGTH} -InterfaceIndex ${ifIndex.trim()}`
  )
  await ps(
    `New-NetNat -Name '${NAT_NAME}' -InternalIPInterfaceAddressPrefix '${NAT_SUBNET}'`
  )
}

async function getVmIp(vmId: string, timeoutMs = 90_000): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await ps(
        `(Get-VMNetworkAdapter -VMName '${vmId}').IPAddresses | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | Select-Object -First 1`
      )
      const ip = raw.trim()
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

export function createHypervProvider(): Provider {
  return {
    name: 'hyperv',

    async available(): Promise<boolean> {
      if (process.platform !== 'win32') return false
      try {
        await ps('Get-Command Get-VM -ErrorAction Stop')
        return true
      } catch {
        return false
      }
    },

    async createVm(task: string, baseImage: string): Promise<VmInfo> {
      const isTaskClone = baseImage.startsWith(VMS_DIR)

      const name = isTaskClone ? vmName(task) : projectVmName(task)
      const dir = isTaskClone ? vmDir(task) : projectVmDir(task)
      mkdirSync(dir, { recursive: true })

      const diskPath = join(dir, 'disk.vhdx')

      // Ensure NAT switch exists
      await ensureNatSwitch()

      if (isTaskClone) {
        // Task clone: create differencing disk (instant, space-efficient)
        console.log('  Creating disk (differencing VHDX)...')
        await ps(`New-VHD -Path '${diskPath}' -ParentPath '${baseImage}' -Differencing`)
      } else {
        // Project VM from base image: copy the disk
        console.log('  Copying base disk...')
        await ps(`Copy-Item -Path '${baseImage}' -Destination '${diskPath}'`)
        // Resize to 20GB
        await ps(`Resize-VHD -Path '${diskPath}' -SizeBytes 21474836480`)
      }

      if (!isTaskClone) {
        console.log('  Creating cloud-init config...')
        await createCloudInitISO(dir, task)
      } else {
        // Copy project's cidata.iso
        const projectDir = join(baseImage, '..')
        const projectCidata = join(projectDir, 'cidata.iso')
        if (existsSync(projectCidata)) {
          await ps(`Copy-Item -Path '${projectCidata}' -Destination '${join(dir, 'cidata.iso')}'`)
        }
      }

      // Write config
      const config: VMConfig = { cpus: 2, memoryMB: 4096 }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))

      // Create and configure VM
      console.log('  Creating Hyper-V VM...')
      await ps(`New-VM -Name '${name}' -MemoryStartupBytes ${config.memoryMB * 1024 * 1024} -VHDPath '${diskPath}' -Generation 2 -SwitchName '${SWITCH_NAME}'`)
      await ps(`Set-VM -Name '${name}' -ProcessorCount ${config.cpus}`)
      // Disable Secure Boot for Linux
      await ps(`Set-VMFirmware -VMName '${name}' -EnableSecureBoot Off`)
      // Attach cloud-init ISO
      const cidataPath = join(dir, 'cidata.iso')
      if (existsSync(cidataPath)) {
        await ps(`Add-VMDvdDrive -VMName '${name}' -Path '${cidataPath}'`)
      }

      // Start VM
      console.log('  Starting VM...')
      await ps(`Start-VM -Name '${name}'`)

      // Wait for IP
      console.log('  Waiting for VM to boot and get IP...')
      const ip = await getVmIp(name)

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
      await ps(`Start-VM -Name '${vmId}'`)
      await getVmIp(vmId)
    },

    async stopVm(vmId: string): Promise<void> {
      await ps(`Stop-VM -Name '${vmId}' -Force`)
    },

    async deleteVm(vmId: string): Promise<void> {
      try { await ps(`Stop-VM -Name '${vmId}' -TurnOff -Force -ErrorAction SilentlyContinue`) } catch { /* may be off */ }
      try { await ps(`Remove-VM -Name '${vmId}' -Force -ErrorAction SilentlyContinue`) } catch { /* may not exist */ }
      const dir = join(VMS_DIR, vmId)
      if (existsSync(dir)) await ps(`Remove-Item -Path '${dir}' -Recurse -Force`)
      const snapDir = join(SNAPSHOTS_DIR, vmId)
      if (existsSync(snapDir)) await ps(`Remove-Item -Path '${snapDir}' -Recurse -Force`)
    },

    async sshInfo(vmId: string): Promise<SshInfo> {
      const ip = await getVmIp(vmId, 15_000)
      if (!ip) throw new Error(`Cannot get IP for ${vmId} - is it running?`)
      return { host: ip, port: 22, user: 'worker' }
    },

    async checkpoint(vmId: string, name: string): Promise<void> {
      await ps(`Checkpoint-VM -Name '${vmId}' -SnapshotName '${name}'`)
    },

    async restore(vmId: string, name: string): Promise<void> {
      await ps(`Restore-VMCheckpoint -VMName '${vmId}' -Name '${name}' -Confirm:$false`)
    },

    async listCheckpoints(vmId: string): Promise<string[]> {
      try {
        const raw = await ps(
          `Get-VMCheckpoint -VMName '${vmId}' | Select-Object -ExpandProperty Name`
        )
        return raw.split('\n').map(s => s.trim()).filter(Boolean)
      } catch {
        return []
      }
    },

    async status(vmId: string): Promise<VmStatus> {
      try {
        const state = (await ps(`(Get-VM -Name '${vmId}').State`)).trim()
        if (state === 'Running') return 'running'
        if (state === 'Off') return 'stopped'
        return 'unknown'
      } catch {
        return 'stopped'
      }
    },

    async listVms(): Promise<VmInfo[]> {
      let raw: string
      try {
        raw = await ps(
          `Get-VM | Where-Object { $_.Name -like '${VM_PREFIX}*' -or $_.Name -like '${PROJECT_PREFIX}*' } | Select-Object Name, State | ConvertTo-Json -Compress`
        )
      } catch {
        return []
      }

      if (!raw.trim()) return []

      // PowerShell returns single object (not array) for one result
      let vms: Array<{ Name: string; State: number }>
      const parsed = JSON.parse(raw)
      vms = Array.isArray(parsed) ? parsed : [parsed]

      const results: VmInfo[] = []
      for (const vm of vms) {
        // Hyper-V State: 2 = Running, 3 = Off
        const isRunning = vm.State === 2
        let ip: string | null = null
        if (isRunning) {
          ip = await getVmIp(vm.Name, 5000).catch(() => null)
        }
        results.push({
          vmId: vm.Name,
          task: vm.Name.startsWith(PROJECT_PREFIX)
            ? vm.Name.slice(PROJECT_PREFIX.length)
            : vm.Name.slice(VM_PREFIX.length),
          ip,
          status: isRunning ? 'running' : 'stopped',
        })
      }
      return results
    },

    projectDiskPath(name: string): string {
      return join(projectVmDir(name), 'disk.vhdx')
    },
  }
}
