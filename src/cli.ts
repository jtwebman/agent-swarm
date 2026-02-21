#!/usr/bin/env node --experimental-strip-types --no-warnings

import * as registry from './registry.ts'
import { detectProvider, getProvider, listProviders } from './providers/detect.ts'
import { sshInteractive, sshRun, scpTo, scpFrom } from './ssh.ts'
import type { Provider } from './provider.ts'
import { getSecretBackend } from './secrets.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec, execOk } from './exec.ts'
import { spawn as nodeSpawn } from 'node:child_process'

const BASE_IMAGE_DIR = join(homedir(), '.agent-swarm', 'base-images')

function usage(): never {
  console.log(`agent-swarm - Multi-agent dev environments with VM isolation

Usage:
  agent-swarm init-base                           Download and prepare base VM image

  agent-swarm project create <NAME>               Create a project VM from base image
  agent-swarm project list                         List all projects
  agent-swarm project ssh <NAME>                   SSH into a project VM (auto-starts)
  agent-swarm project run <NAME> <command...>      Run a command in a project VM
  agent-swarm project stop <NAME>                  Stop and save project (new task baseline)
  agent-swarm project code <NAME> [path]           Open VS Code remote into project VM
  agent-swarm project delete <NAME>                Delete a project VM and its disk

  agent-swarm create <PROJECT> <TASK>              Create a task VM (cloned from project)
  agent-swarm list                                 List all task VMs
  agent-swarm ssh <TASK>                           SSH into a task VM
  agent-swarm run <TASK> <command...>              Run a command inside a task VM
  agent-swarm stop <TASK>                          Stop a task VM
  agent-swarm start <TASK>                         Start a stopped task VM
  agent-swarm code <TASK> [path]                   Open VS Code remote into task VM
  agent-swarm delete <TASK>                        Delete a task VM

  agent-swarm cp <src> <dest>                      Copy files in/out of a VM
  agent-swarm bulk create <PROJECT> <T1> <T2> ...  Create multiple tasks in parallel
  agent-swarm bulk delete <T1> <T2> ...            Delete multiple tasks in parallel
  agent-swarm bulk delete --project <NAME>         Delete all tasks for a project

  agent-swarm env set <KEY> <VALUE>                Set a global env var (encrypted)
  agent-swarm env set <KEY> <VALUE> --project X    Set a per-project env var override
  agent-swarm env list                             List global env var names
  agent-swarm env list --project X                 List resolved env var names for project
  agent-swarm env rm <KEY>                         Remove a global env var
  agent-swarm env rm <KEY> --project X             Remove a per-project env var

  agent-swarm checkpoint <TASK> [name]             Create a snapshot
  agent-swarm restore <TASK> [name]                Restore a snapshot
  agent-swarm status                               Resource overview
  agent-swarm providers                            List available providers`)
  process.exit(0)
}

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

async function resolveProvider(task?: string): Promise<Provider> {
  if (task) {
    const env = registry.get(task)
    if (env) {
      const p = getProvider(env.provider)
      if (p) return p
      die(`Provider '${env.provider}' not available for task ${task}`)
    }
  }
  const p = await detectProvider()
  if (!p) {
    die(
      'No VM provider found.\n' +
      '  Mac:     Requires Xcode Command Line Tools: xcode-select --install\n' +
      '  Linux:   apt install qemu-kvm libvirt-daemon-system virtinst genisoimage ovmf\n' +
      '  Windows: Enable Hyper-V in Windows Features (Pro/Enterprise)'
    )
  }
  return p
}

async function resolveProviderForProject(name?: string): Promise<Provider> {
  if (name) {
    const proj = registry.getProject(name)
    if (proj) {
      const p = getProvider(proj.provider)
      if (p) return p
      die(`Provider '${proj.provider}' not available for project ${name}`)
    }
  }
  const p = await detectProvider()
  if (!p) {
    die(
      'No VM provider found.\n' +
      '  Mac:     Requires Xcode Command Line Tools: xcode-select --install\n' +
      '  Linux:   apt install qemu-kvm libvirt-daemon-system virtinst genisoimage ovmf\n' +
      '  Windows: Enable Hyper-V in Windows Features (Pro/Enterprise)'
    )
  }
  return p
}

function defaultBaseImage(): string {
  const candidates = [
    join(BASE_IMAGE_DIR, 'ubuntu-24.04.img'),
    join(BASE_IMAGE_DIR, 'ubuntu-24.04.qcow2'),
    join(BASE_IMAGE_DIR, 'ubuntu-24.04.vhdx'),
    join(BASE_IMAGE_DIR, 'ubuntu-22.04.img'),
    join(BASE_IMAGE_DIR, 'ubuntu-22.04.qcow2'),
    join(BASE_IMAGE_DIR, 'ubuntu-22.04.vhdx'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return ''
}

// --- Project commands ---

async function cmdProjectCreate(name: string) {
  if (registry.getProject(name)) die(`Project ${name} already exists`)
  const baseImage = defaultBaseImage()
  if (!baseImage) die('No base image found. Run `agent-swarm init-base` first.')

  const provider = await resolveProviderForProject()
  console.log(`Creating project VM for ${name} using ${provider.name}...`)
  console.log(`Base image: ${baseImage}`)
  const vm = await provider.createVm(name, baseImage)
  registry.registerProject({
    name,
    provider: provider.name,
    vm_id: vm.vmId,
    base_image: baseImage,
    ip: vm.ip,
    status: vm.status,
  })
  console.log(`\nProject VM created: ${vm.vmId}`)
  if (vm.ip) console.log(`IP: ${vm.ip}`)
  console.log(`SSH: agent-swarm project ssh ${name}`)
}

async function cmdProjectList() {
  const projects = registry.listProjects()
  if (projects.length === 0) {
    console.log('No projects. Create one with: agent-swarm project create <NAME>')
    return
  }
  console.log('PROJECT'.padEnd(20) + 'PROVIDER'.padEnd(15) + 'IP'.padEnd(18) + 'STATUS'.padEnd(12) + 'CREATED')
  console.log('-'.repeat(85))
  for (const proj of projects) {
    console.log(
      proj.name.padEnd(20) +
      proj.provider.padEnd(15) +
      (proj.ip ?? '-').padEnd(18) +
      proj.status.padEnd(12) +
      proj.created_at
    )
  }
}

async function cmdProjectSsh(name: string) {
  const proj = registry.getProject(name)
  if (!proj) die(`No project found: ${name}`)
  const provider = await resolveProviderForProject(name)

  // Check actual VM state and auto-start if needed
  const actualStatus = await provider.status(proj.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting project ${name}...`)
    await provider.startVm(proj.vm_id)
    registry.updateProjectStatus(name, 'running')
  }

  // Wait for SSH to become reachable
  let info = await provider.sshInfo(proj.vm_id)
  registry.updateProjectIp(name, info.host)
  const env = await getSecretBackend().resolve(name)
  console.log(`Connecting to project ${name} (${info.user}@${info.host}:${info.port})...`)
  const code = await sshInteractive(info, env)
  process.exit(code)
}

async function cmdProjectRun(name: string, command: string) {
  const proj = registry.getProject(name)
  if (!proj) die(`No project found: ${name}`)
  const provider = await resolveProviderForProject(name)

  const actualStatus = await provider.status(proj.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting project ${name}...`)
    await provider.startVm(proj.vm_id)
    registry.updateProjectStatus(name, 'running')
  }

  const info = await provider.sshInfo(proj.vm_id)
  registry.updateProjectIp(name, info.host)
  const env = await getSecretBackend().resolve(name)
  const code = await sshRun(info, command, env)
  if (code !== 0) process.exit(code)
}

async function cmdProjectStop(name: string) {
  const proj = registry.getProject(name)
  if (!proj) die(`No project found: ${name}`)
  const provider = await resolveProviderForProject(name)
  console.log(`Stopping project ${name}...`)
  await provider.stopVm(proj.vm_id)
  registry.updateProjectStatus(name, 'stopped')
  console.log('Stopped. New tasks will clone from this state.')
}

async function cmdProjectCode(name: string, remotePath: string) {
  const proj = registry.getProject(name)
  if (!proj) die(`No project found: ${name}`)
  const provider = await resolveProviderForProject(name)

  // Auto-start if needed
  const actualStatus = await provider.status(proj.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting project ${name}...`)
    await provider.startVm(proj.vm_id)
    registry.updateProjectStatus(name, 'running')
  }

  const info = await provider.sshInfo(proj.vm_id)
  registry.updateProjectIp(name, info.host)
  const remote = `ssh-remote+${info.user}@${info.host}`
  console.log(`Opening VS Code: ${info.user}@${info.host}:${remotePath}`)
  nodeSpawn('code', ['--remote', remote, remotePath], { detached: true, stdio: 'ignore' }).unref()
}

async function cmdCode(task: string, remotePath: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)

  // Auto-start if needed
  const actualStatus = await provider.status(env.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting ${task}...`)
    await provider.startVm(env.vm_id)
    registry.updateStatus(task, 'running')
  }

  const info = await provider.sshInfo(env.vm_id)
  registry.updateIp(task, info.host)
  const remote = `ssh-remote+${info.user}@${info.host}`
  console.log(`Opening VS Code: ${info.user}@${info.host}:${remotePath}`)
  nodeSpawn('code', ['--remote', remote, remotePath], { detached: true, stdio: 'ignore' }).unref()
}

async function cmdProjectDelete(name: string) {
  const tasks = registry.list().filter(e => e.project === name)
  if (tasks.length > 0) {
    die(`Project ${name} still has ${tasks.length} task(s): ${tasks.map(t => t.task).join(', ')}. Delete them first.`)
  }
  const proj = registry.getProject(name)
  if (!proj) die(`No project found: ${name}`)
  const provider = await resolveProviderForProject(name)
  console.log(`Deleting project ${name}...`)
  await provider.deleteVm(proj.vm_id)
  registry.removeProject(name)
  console.log('Deleted.')
}

// --- Task commands ---

async function cmdCreate(projectName: string, task: string) {
  if (registry.get(task)) die(`Task ${task} already exists`)
  const proj = registry.getProject(projectName)
  if (!proj) die(`Project ${projectName} not found. Create it with: agent-swarm project create ${projectName}`)
  if (proj.status === 'running') {
    const provider = await resolveProviderForProject(projectName)
    console.log(`Stopping project ${projectName} for clean clone...`)
    await provider.stopVm(proj.vm_id)
    registry.updateProjectStatus(projectName, 'stopped')
  }

  const provider = await resolveProvider()
  const diskPath = provider.projectDiskPath(projectName)
  if (!existsSync(diskPath)) die(`Project disk not found: ${diskPath}`)

  console.log(`Creating task VM for ${task} (cloned from project ${projectName})...`)
  const vm = await provider.createVm(task, diskPath)
  registry.register({
    task,
    project: projectName,
    provider: provider.name,
    vm_id: vm.vmId,
    base_image: proj.base_image,
    ip: vm.ip,
    status: vm.status,
  })
  console.log(`\nVM created: ${vm.vmId}`)
  if (vm.ip) console.log(`IP: ${vm.ip}`)
  console.log(`SSH: agent-swarm ssh ${task}`)
}

async function cmdList() {
  const envs = registry.list()
  if (envs.length === 0) {
    console.log('No task environments. Create one with: agent-swarm create <PROJECT> <TASK>')
    return
  }
  console.log('TASK'.padEnd(20) + 'PROJECT'.padEnd(15) + 'PROVIDER'.padEnd(15) + 'IP'.padEnd(18) + 'STATUS'.padEnd(12) + 'CREATED')
  console.log('-'.repeat(100))
  for (const env of envs) {
    console.log(
      env.task.padEnd(20) +
      env.project.padEnd(15) +
      env.provider.padEnd(15) +
      (env.ip ?? '-').padEnd(18) +
      env.status.padEnd(12) +
      env.created_at
    )
  }
}

async function cmdSsh(task: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)
  const info = await provider.sshInfo(env.vm_id)
  const envVars = await getSecretBackend().resolve(env.project || '')
  console.log(`Connecting to ${task} (${info.user}@${info.host}:${info.port})...`)
  const code = await sshInteractive(info, envVars)
  process.exit(code)
}

async function cmdStop(task: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)
  console.log(`Stopping ${task}...`)
  await provider.stopVm(env.vm_id)
  registry.updateStatus(task, 'stopped')
  console.log('Stopped.')
}

async function cmdStart(task: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)
  console.log(`Starting ${task}...`)
  await provider.startVm(env.vm_id)
  registry.updateStatus(task, 'running')
  try {
    const info = await provider.sshInfo(env.vm_id)
    registry.updateIp(task, info.host)
    console.log(`Running. IP: ${info.host}`)
  } catch {
    console.log('Running. (IP not yet available)')
  }
}

async function cmdDelete(task: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)
  console.log(`Deleting ${task}...`)
  await provider.deleteVm(env.vm_id)
  registry.remove(task)
  console.log('Deleted.')
}

async function cmdRun(task: string, command: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)

  const actualStatus = await provider.status(env.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting ${task}...`)
    await provider.startVm(env.vm_id)
    registry.updateStatus(task, 'running')
  }

  const info = await provider.sshInfo(env.vm_id)
  registry.updateIp(task, info.host)
  const envVars = await getSecretBackend().resolve(env.project || '')
  const code = await sshRun(info, command, envVars)
  if (code !== 0) process.exit(code)
}

async function cmdCp(src: string, dest: string) {
  // Detect direction: TASK:/path or just local path
  const srcMatch = src.match(/^([^:]+):(.+)$/)
  const destMatch = dest.match(/^([^:]+):(.+)$/)

  if (srcMatch && destMatch) die('Cannot copy between two VMs directly. Copy to local first.')
  if (!srcMatch && !destMatch) die('One of src or dest must be a VM path (TASK:/path)')

  if (srcMatch) {
    // VM -> local
    const [, task, remotePath] = srcMatch
    const env = registry.get(task)
    if (!env) die(`No environment found for task ${task}`)
    const provider = await resolveProvider(task)

    const actualStatus = await provider.status(env.vm_id)
    if (actualStatus !== 'running') {
      console.log(`Starting ${task}...`)
      await provider.startVm(env.vm_id)
      registry.updateStatus(task, 'running')
    }

    const info = await provider.sshInfo(env.vm_id)
    registry.updateIp(task, info.host)
    await scpFrom(info, remotePath, dest)
  } else {
    // local -> VM
    const [, task, remotePath] = destMatch!
    const env = registry.get(task)
    if (!env) die(`No environment found for task ${task}`)
    const provider = await resolveProvider(task)

    const actualStatus = await provider.status(env.vm_id)
    if (actualStatus !== 'running') {
      console.log(`Starting ${task}...`)
      await provider.startVm(env.vm_id)
      registry.updateStatus(task, 'running')
    }

    const info = await provider.sshInfo(env.vm_id)
    registry.updateIp(task, info.host)
    await scpTo(info, src, remotePath)
  }
}

async function cmdBulkCreate(projectName: string, tasks: string[]) {
  const proj = registry.getProject(projectName)
  if (!proj) die(`Project ${projectName} not found. Create it with: agent-swarm project create ${projectName}`)

  // Stop project once for clean cloning
  if (proj.status === 'running') {
    const provider = await resolveProviderForProject(projectName)
    console.log(`Stopping project ${projectName} for clean clone...`)
    await provider.stopVm(proj.vm_id)
    registry.updateProjectStatus(projectName, 'stopped')
  }

  // Resolve provider to get the correct disk path for this platform
  const resolvedProvider = await resolveProvider()
  const diskPath = resolvedProvider.projectDiskPath(projectName)
  if (!existsSync(diskPath)) die(`Project disk not found: ${diskPath}`)

  console.log(`Creating ${tasks.length} task VMs in parallel...`)
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      if (registry.get(task)) throw new Error(`Task ${task} already exists`)
      const provider = await resolveProvider()
      const vm = await provider.createVm(task, diskPath)
      registry.register({
        task,
        project: projectName,
        provider: provider.name,
        vm_id: vm.vmId,
        base_image: proj.base_image,
        ip: vm.ip,
        status: vm.status,
      })
      return vm
    })
  )

  for (let i = 0; i < tasks.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      console.log(`  ${tasks[i]}: created (${result.value.vmId})`)
    } else {
      console.error(`  ${tasks[i]}: FAILED - ${result.reason?.message ?? result.reason}`)
    }
  }

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`\n${succeeded} created, ${failed} failed`)
}

async function cmdBulkDelete(tasks: string[]) {
  console.log(`Deleting ${tasks.length} task VMs in parallel...`)
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const env = registry.get(task)
      if (!env) throw new Error(`No environment found for task ${task}`)
      const provider = await resolveProvider(task)
      await provider.deleteVm(env.vm_id)
      registry.remove(task)
    })
  )

  for (let i = 0; i < tasks.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      console.log(`  ${tasks[i]}: deleted`)
    } else {
      console.error(`  ${tasks[i]}: FAILED - ${result.reason?.message ?? result.reason}`)
    }
  }

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`\n${succeeded} deleted, ${failed} failed`)
}

async function cmdStatus() {
  const projects = registry.listProjects()
  const envs = registry.list()
  const running = envs.filter(e => e.status === 'running').length
  const stopped = envs.filter(e => e.status !== 'running').length
  console.log(`Projects: ${projects.length}`)
  console.log(`Tasks:    ${envs.length} total (${running} running, ${stopped} stopped)`)

  const providers = await listProviders()
  console.log('\nProviders:')
  for (const p of providers) {
    console.log(`  ${p.name}: ${p.available ? 'available' : 'not available'}`)
  }

  const baseImg = defaultBaseImage()
  console.log(`\nBase image: ${baseImg || 'not found (run agent-swarm init-base)'}`)
}

async function cmdCheckpoint(task: string, name?: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)
  const snapshotName = name ?? new Date().toISOString().replace(/[:.]/g, '-')
  console.log(`Creating checkpoint '${snapshotName}' for ${task}...`)
  await provider.checkpoint(env.vm_id, snapshotName)
  console.log('Checkpoint created.')
}

async function cmdRestore(task: string, name?: string) {
  const env = registry.get(task)
  if (!env) die(`No environment found for task ${task}`)
  const provider = await resolveProvider(task)
  if (!name) {
    const checkpoints = await provider.listCheckpoints(env.vm_id)
    if (checkpoints.length === 0) die(`No checkpoints found for ${task}`)
    name = checkpoints[checkpoints.length - 1]
    console.log(`Restoring latest checkpoint: ${name}`)
  }
  console.log(`Restoring ${task} to '${name}'...`)
  await provider.restore(env.vm_id, name!)
  registry.updateStatus(task, 'stopped')
  console.log('Restored. Start with: agent-swarm start ' + task)
}

async function cmdProviders() {
  const providers = await listProviders()
  console.log('PROVIDER'.padEnd(20) + 'STATUS')
  console.log('-'.repeat(40))
  for (const p of providers) {
    console.log(p.name.padEnd(20) + (p.available ? 'available' : 'not available'))
  }
  if (!providers.some(p => p.available)) {
    console.log('\nNo providers available.')
    console.log('  Mac:     Xcode Command Line Tools needed: xcode-select --install')
    console.log('  Linux:   apt install qemu-kvm libvirt-daemon-system virtinst genisoimage ovmf')
    console.log('  Windows: Enable Hyper-V in Windows Features (Pro/Enterprise)')
  }
}

async function cmdInitBase() {
  mkdirSync(BASE_IMAGE_DIR, { recursive: true })

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const imageUrl = `https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-${arch}.img`
  const qcow2Path = join(BASE_IMAGE_DIR, `ubuntu-24.04-${arch}.qcow2`)

  if (process.platform === 'darwin') {
    // macOS: download qcow2, convert to raw .img via Swift helper
    const rawPath = join(BASE_IMAGE_DIR, 'ubuntu-24.04.img')

    if (existsSync(rawPath)) {
      console.log(`Base image already exists: ${rawPath}`)
      console.log('Delete it first if you want to re-download.')
      return
    }

    console.log(`Downloading Ubuntu 24.04 cloud image (${arch})...`)
    console.log(`  ${imageUrl}`)
    await exec('curl', ['-L', '--progress-bar', '-o', qcow2Path, imageUrl])

    // Convert qcow2 to raw using our Swift helper
    const helperBin = join(homedir(), '.agent-swarm', 'bin', 'vm-helper')
    if (!existsSync(helperBin)) {
      const provider = await detectProvider()
      if (!provider) die('No provider available to compile VM helper')
    }

    console.log('Converting qcow2 to raw disk image...')
    await exec(helperBin, ['convert-qcow2', qcow2Path, rawPath])

    // Clean up qcow2
    await exec('rm', ['-f', qcow2Path])

    console.log(`\nBase image ready: ${rawPath}`)
  } else if (process.platform === 'linux') {
    // Linux: download qcow2, keep as-is (native QEMU format)
    const finalPath = join(BASE_IMAGE_DIR, 'ubuntu-24.04.qcow2')

    if (existsSync(finalPath)) {
      console.log(`Base image already exists: ${finalPath}`)
      console.log('Delete it first if you want to re-download.')
      return
    }

    console.log(`Downloading Ubuntu 24.04 cloud image (${arch})...`)
    console.log(`  ${imageUrl}`)
    await exec('curl', ['-L', '--progress-bar', '-o', qcow2Path, imageUrl])

    // The cloud image is already qcow2 — just rename to final path
    if (qcow2Path !== finalPath) {
      const { renameSync } = await import('node:fs')
      renameSync(qcow2Path, finalPath)
    }

    console.log(`\nBase image ready: ${finalPath}`)
  } else if (process.platform === 'win32') {
    // Windows: download qcow2, convert to vhdx via qemu-img
    const vhdxPath = join(BASE_IMAGE_DIR, 'ubuntu-24.04.vhdx')

    if (existsSync(vhdxPath)) {
      console.log(`Base image already exists: ${vhdxPath}`)
      console.log('Delete it first if you want to re-download.')
      return
    }

    if (!(await execOk('qemu-img', ['--version']))) {
      die('qemu-img not found. Install QEMU for Windows to convert cloud images.')
    }

    console.log(`Downloading Ubuntu 24.04 cloud image (${arch})...`)
    console.log(`  ${imageUrl}`)
    await exec('curl', ['-L', '--progress-bar', '-o', qcow2Path, imageUrl])

    console.log('Converting qcow2 to VHDX...')
    await exec('qemu-img', ['convert', '-f', 'qcow2', '-O', 'vhdx', '-o', 'subformat=dynamic', qcow2Path, vhdxPath])

    // Clean up qcow2
    await exec('powershell.exe', ['-NoProfile', '-Command', `Remove-Item -Path '${qcow2Path}' -Force`])

    console.log(`\nBase image ready: ${vhdxPath}`)
  } else {
    die(`Unsupported platform: ${process.platform}`)
  }

  console.log('Create a project with: agent-swarm project create <NAME>')
}

// --- Env commands ---

function parseProjectFlag(args: string[]): string | undefined {
  const idx = args.indexOf('--project')
  if (idx === -1) return undefined
  return args[idx + 1]
}

async function cmdEnvSet(key: string, value: string, project?: string) {
  const backend = getSecretBackend()
  await backend.set(key, value, project)
  const scope = project ? ` (project: ${project})` : ' (global)'
  console.log(`Set ${key}${scope}`)
}

async function cmdEnvList(project?: string) {
  const backend = getSecretBackend()
  if (project) {
    // Show resolved names for this project (global + overrides)
    const resolved = await backend.resolve(project)
    const names = Object.keys(resolved).sort()
    if (names.length === 0) {
      console.log(`No env vars configured for project ${project}.`)
      return
    }
    console.log(`Env vars for project ${project} (resolved):`)
    for (const name of names) {
      console.log(`  ${name}`)
    }
  } else {
    // Show global vars
    const vars = await backend.list('')
    if (vars.length === 0) {
      console.log('No global env vars configured. Set one with: agent-swarm env set <KEY> <VALUE>')
      return
    }
    console.log('Global env vars:')
    for (const v of vars) {
      console.log(`  ${v.name}`)
    }
  }
}

async function cmdEnvRm(key: string, project?: string) {
  const backend = getSecretBackend()
  await backend.remove(key, project)
  const scope = project ? ` (project: ${project})` : ' (global)'
  console.log(`Removed ${key}${scope}`)
}

// --- Main ---

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') usage()

try {
  switch (command) {
    case 'project': {
      const subcommand = args[1]
      const name = args[2]
      switch (subcommand) {
        case 'create':
          if (!name) die('Usage: agent-swarm project create <NAME>')
          await cmdProjectCreate(name)
          break
        case 'list':
          await cmdProjectList()
          break
        case 'ssh':
          if (!name) die('Usage: agent-swarm project ssh <NAME>')
          await cmdProjectSsh(name)
          break
        case 'run':
          if (!name || args.length < 4) die('Usage: agent-swarm project run <NAME> <command...>')
          await cmdProjectRun(name, args.slice(3).join(' '))
          break
        case 'stop':
          if (!name) die('Usage: agent-swarm project stop <NAME>')
          await cmdProjectStop(name)
          break
        case 'code':
          if (!name) die('Usage: agent-swarm project code <NAME> [path]')
          await cmdProjectCode(name, args[3] ?? '/home/worker')
          break
        case 'delete':
          if (!name) die('Usage: agent-swarm project delete <NAME>')
          await cmdProjectDelete(name)
          break
        default:
          die(`Unknown project subcommand: ${subcommand}. Run 'agent-swarm --help' for usage.`)
      }
      break
    }
    case 'env': {
      const envCmd = args[1]
      const project = parseProjectFlag(args)
      switch (envCmd) {
        case 'set': {
          const key = args[2]
          const value = args[3]
          if (!key || !value) die('Usage: agent-swarm env set <KEY> <VALUE> [--project <NAME>]')
          await cmdEnvSet(key, value, project)
          break
        }
        case 'list':
          await cmdEnvList(project)
          break
        case 'rm': {
          const key = args[2]
          if (!key) die('Usage: agent-swarm env rm <KEY> [--project <NAME>]')
          await cmdEnvRm(key, project)
          break
        }
        default:
          die(`Unknown env subcommand: ${envCmd}. Use 'set', 'list', or 'rm'.`)
      }
      break
    }
    case 'create': {
      const projectName = args[1]
      const task = args[2]
      if (!projectName || !task) die('Usage: agent-swarm create <PROJECT> <TASK>')
      await cmdCreate(projectName, task)
      break
    }
    case 'list':
      await cmdList()
      break
    case 'ssh':
      if (!args[1]) die('Usage: agent-swarm ssh <TASK>')
      await cmdSsh(args[1])
      break
    case 'run':
      if (!args[1] || args.length < 3) die('Usage: agent-swarm run <TASK> <command...>')
      await cmdRun(args[1], args.slice(2).join(' '))
      break
    case 'cp':
      if (!args[1] || !args[2]) die('Usage: agent-swarm cp <src> <dest>')
      await cmdCp(args[1], args[2])
      break
    case 'bulk': {
      const bulkCmd = args[1]
      switch (bulkCmd) {
        case 'create': {
          const bulkProject = args[2]
          const bulkTasks = args.slice(3)
          if (!bulkProject || bulkTasks.length === 0) die('Usage: agent-swarm bulk create <PROJECT> <T1> <T2> ...')
          await cmdBulkCreate(bulkProject, bulkTasks)
          break
        }
        case 'delete': {
          if (args[2] === '--project') {
            const projName = args[3]
            if (!projName) die('Usage: agent-swarm bulk delete --project <NAME>')
            const tasks = registry.list().filter(e => e.project === projName)
            if (tasks.length === 0) die(`No tasks found for project ${projName}`)
            await cmdBulkDelete(tasks.map(t => t.task))
          } else {
            const bulkTasks = args.slice(2)
            if (bulkTasks.length === 0) die('Usage: agent-swarm bulk delete <T1> <T2> ...')
            await cmdBulkDelete(bulkTasks)
          }
          break
        }
        default:
          die(`Unknown bulk subcommand: ${bulkCmd}. Use 'create' or 'delete'.`)
      }
      break
    }
    case 'stop':
      if (!args[1]) die('Usage: agent-swarm stop <TASK>')
      await cmdStop(args[1])
      break
    case 'start':
      if (!args[1]) die('Usage: agent-swarm start <TASK>')
      await cmdStart(args[1])
      break
    case 'code':
      if (!args[1]) die('Usage: agent-swarm code <TASK> [path]')
      await cmdCode(args[1], args[2] ?? '/home/worker')
      break
    case 'delete':
      if (!args[1]) die('Usage: agent-swarm delete <TASK>')
      await cmdDelete(args[1])
      break
    case 'status':
      await cmdStatus()
      break
    case 'checkpoint': {
      if (!args[1]) die('Usage: agent-swarm checkpoint <TASK> [name]')
      await cmdCheckpoint(args[1], args[2])
      break
    }
    case 'restore': {
      if (!args[1]) die('Usage: agent-swarm restore <TASK> [name]')
      await cmdRestore(args[1], args[2])
      break
    }
    case 'providers':
      await cmdProviders()
      break
    case 'init-base':
      await cmdInitBase()
      break
    default:
      die(`Unknown command: ${command}. Run 'agent-swarm --help' for usage.`)
  }
  process.exit(0)
} catch (err) {
  die(err instanceof Error ? err.message : String(err))
}
