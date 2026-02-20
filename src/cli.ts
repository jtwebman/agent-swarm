#!/usr/bin/env node --experimental-strip-types --no-warnings

import * as registry from './registry.ts'
import { detectProvider, getProvider, listProviders } from './providers/detect.ts'
import { projectDiskPath } from './providers/macos-native.ts'
import { sshInteractive, sshRun, scpTo, scpFrom } from './ssh.ts'
import type { Provider } from './provider.ts'
import { getSecretBackend } from './secrets.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec } from './exec.ts'
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
  agent-swarm project stop <NAME>                  Stop and save project (new ticket baseline)
  agent-swarm project code <NAME> [path]           Open VS Code remote into project VM
  agent-swarm project delete <NAME>                Delete a project VM and its disk

  agent-swarm create <PROJECT> <TICKET>            Create a ticket VM (cloned from project)
  agent-swarm list                                 List all ticket VMs
  agent-swarm ssh <TICKET>                         SSH into a ticket VM
  agent-swarm run <TICKET> <command...>            Run a command inside a ticket VM
  agent-swarm stop <TICKET>                        Stop a ticket VM
  agent-swarm start <TICKET>                       Start a stopped ticket VM
  agent-swarm code <TICKET> [path]                  Open VS Code remote into ticket VM
  agent-swarm delete <TICKET>                      Delete a ticket VM

  agent-swarm cp <src> <dest>                      Copy files in/out of a VM
  agent-swarm bulk create <PROJECT> <T1> <T2> ...  Create multiple tickets in parallel
  agent-swarm bulk delete <T1> <T2> ...            Delete multiple tickets in parallel
  agent-swarm bulk delete --project <NAME>         Delete all tickets for a project

  agent-swarm env set <KEY> <VALUE>                Set a global env var (encrypted)
  agent-swarm env set <KEY> <VALUE> --project X    Set a per-project env var override
  agent-swarm env list                             List global env var names
  agent-swarm env list --project X                 List resolved env var names for project
  agent-swarm env rm <KEY>                         Remove a global env var
  agent-swarm env rm <KEY> --project X             Remove a per-project env var

  agent-swarm checkpoint <TICKET> [name]           Create a snapshot
  agent-swarm restore <TICKET> [name]              Restore a snapshot
  agent-swarm status                               Resource overview
  agent-swarm providers                            List available providers`)
  process.exit(0)
}

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

async function resolveProvider(ticket?: string): Promise<Provider> {
  if (ticket) {
    const env = registry.get(ticket)
    if (env) {
      const p = getProvider(env.provider)
      if (p) return p
      die(`Provider '${env.provider}' not available for ticket ${ticket}`)
    }
  }
  const p = await detectProvider()
  if (!p) {
    die(
      'No VM provider found.\n' +
      '  Mac:     Requires Xcode Command Line Tools: xcode-select --install\n' +
      '  Linux:   apt install libvirt-daemon-system virtinst (future)\n' +
      '  Windows: Enable Hyper-V in Windows Features (future)'
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
      '  Linux:   apt install libvirt-daemon-system virtinst (future)\n' +
      '  Windows: Enable Hyper-V in Windows Features (future)'
    )
  }
  return p
}

function defaultBaseImage(): string {
  const candidates = [
    join(BASE_IMAGE_DIR, 'ubuntu-24.04.img'),
    join(BASE_IMAGE_DIR, 'ubuntu-22.04.img'),
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
  console.log('Stopped. New tickets will clone from this state.')
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

async function cmdCode(ticket: string, remotePath: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)

  // Auto-start if needed
  const actualStatus = await provider.status(env.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting ${ticket}...`)
    await provider.startVm(env.vm_id)
    registry.updateStatus(ticket, 'running')
  }

  const info = await provider.sshInfo(env.vm_id)
  registry.updateIp(ticket, info.host)
  const remote = `ssh-remote+${info.user}@${info.host}`
  console.log(`Opening VS Code: ${info.user}@${info.host}:${remotePath}`)
  nodeSpawn('code', ['--remote', remote, remotePath], { detached: true, stdio: 'ignore' }).unref()
}

async function cmdProjectDelete(name: string) {
  const tickets = registry.list().filter(e => e.project === name)
  if (tickets.length > 0) {
    die(`Project ${name} still has ${tickets.length} ticket(s): ${tickets.map(t => t.ticket).join(', ')}. Delete them first.`)
  }
  const proj = registry.getProject(name)
  if (!proj) die(`No project found: ${name}`)
  const provider = await resolveProviderForProject(name)
  console.log(`Deleting project ${name}...`)
  await provider.deleteVm(proj.vm_id)
  registry.removeProject(name)
  console.log('Deleted.')
}

// --- Ticket commands ---

async function cmdCreate(projectName: string, ticket: string) {
  if (registry.get(ticket)) die(`Ticket ${ticket} already exists`)
  const proj = registry.getProject(projectName)
  if (!proj) die(`Project ${projectName} not found. Create it with: agent-swarm project create ${projectName}`)
  if (proj.status === 'running') {
    const provider = await resolveProviderForProject(projectName)
    console.log(`Stopping project ${projectName} for clean clone...`)
    await provider.stopVm(proj.vm_id)
    registry.updateProjectStatus(projectName, 'stopped')
  }

  const diskPath = projectDiskPath(projectName)
  if (!existsSync(diskPath)) die(`Project disk not found: ${diskPath}`)

  const provider = await resolveProvider()
  console.log(`Creating ticket VM for ${ticket} (cloned from project ${projectName})...`)
  const vm = await provider.createVm(ticket, diskPath)
  registry.register({
    ticket,
    project: projectName,
    provider: provider.name,
    vm_id: vm.vmId,
    base_image: proj.base_image,
    ip: vm.ip,
    status: vm.status,
  })
  console.log(`\nVM created: ${vm.vmId}`)
  if (vm.ip) console.log(`IP: ${vm.ip}`)
  console.log(`SSH: agent-swarm ssh ${ticket}`)
}

async function cmdList() {
  const envs = registry.list()
  if (envs.length === 0) {
    console.log('No ticket environments. Create one with: agent-swarm create <PROJECT> <TICKET>')
    return
  }
  console.log('TICKET'.padEnd(20) + 'PROJECT'.padEnd(15) + 'PROVIDER'.padEnd(15) + 'IP'.padEnd(18) + 'STATUS'.padEnd(12) + 'CREATED')
  console.log('-'.repeat(100))
  for (const env of envs) {
    console.log(
      env.ticket.padEnd(20) +
      env.project.padEnd(15) +
      env.provider.padEnd(15) +
      (env.ip ?? '-').padEnd(18) +
      env.status.padEnd(12) +
      env.created_at
    )
  }
}

async function cmdSsh(ticket: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)
  const info = await provider.sshInfo(env.vm_id)
  const envVars = await getSecretBackend().resolve(env.project || '')
  console.log(`Connecting to ${ticket} (${info.user}@${info.host}:${info.port})...`)
  const code = await sshInteractive(info, envVars)
  process.exit(code)
}

async function cmdStop(ticket: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)
  console.log(`Stopping ${ticket}...`)
  await provider.stopVm(env.vm_id)
  registry.updateStatus(ticket, 'stopped')
  console.log('Stopped.')
}

async function cmdStart(ticket: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)
  console.log(`Starting ${ticket}...`)
  await provider.startVm(env.vm_id)
  registry.updateStatus(ticket, 'running')
  try {
    const info = await provider.sshInfo(env.vm_id)
    registry.updateIp(ticket, info.host)
    console.log(`Running. IP: ${info.host}`)
  } catch {
    console.log('Running. (IP not yet available)')
  }
}

async function cmdDelete(ticket: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)
  console.log(`Deleting ${ticket}...`)
  await provider.deleteVm(env.vm_id)
  registry.remove(ticket)
  console.log('Deleted.')
}

async function cmdRun(ticket: string, command: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)

  const actualStatus = await provider.status(env.vm_id)
  if (actualStatus !== 'running') {
    console.log(`Starting ${ticket}...`)
    await provider.startVm(env.vm_id)
    registry.updateStatus(ticket, 'running')
  }

  const info = await provider.sshInfo(env.vm_id)
  registry.updateIp(ticket, info.host)
  const envVars = await getSecretBackend().resolve(env.project || '')
  const code = await sshRun(info, command, envVars)
  if (code !== 0) process.exit(code)
}

async function cmdCp(src: string, dest: string) {
  // Detect direction: TICKET:/path or just local path
  const srcMatch = src.match(/^([^:]+):(.+)$/)
  const destMatch = dest.match(/^([^:]+):(.+)$/)

  if (srcMatch && destMatch) die('Cannot copy between two VMs directly. Copy to local first.')
  if (!srcMatch && !destMatch) die('One of src or dest must be a VM path (TICKET:/path)')

  if (srcMatch) {
    // VM -> local
    const [, ticket, remotePath] = srcMatch
    const env = registry.get(ticket)
    if (!env) die(`No environment found for ticket ${ticket}`)
    const provider = await resolveProvider(ticket)

    const actualStatus = await provider.status(env.vm_id)
    if (actualStatus !== 'running') {
      console.log(`Starting ${ticket}...`)
      await provider.startVm(env.vm_id)
      registry.updateStatus(ticket, 'running')
    }

    const info = await provider.sshInfo(env.vm_id)
    registry.updateIp(ticket, info.host)
    await scpFrom(info, remotePath, dest)
  } else {
    // local -> VM
    const [, ticket, remotePath] = destMatch!
    const env = registry.get(ticket)
    if (!env) die(`No environment found for ticket ${ticket}`)
    const provider = await resolveProvider(ticket)

    const actualStatus = await provider.status(env.vm_id)
    if (actualStatus !== 'running') {
      console.log(`Starting ${ticket}...`)
      await provider.startVm(env.vm_id)
      registry.updateStatus(ticket, 'running')
    }

    const info = await provider.sshInfo(env.vm_id)
    registry.updateIp(ticket, info.host)
    await scpTo(info, src, remotePath)
  }
}

async function cmdBulkCreate(projectName: string, tickets: string[]) {
  const proj = registry.getProject(projectName)
  if (!proj) die(`Project ${projectName} not found. Create it with: agent-swarm project create ${projectName}`)

  // Stop project once for clean cloning
  if (proj.status === 'running') {
    const provider = await resolveProviderForProject(projectName)
    console.log(`Stopping project ${projectName} for clean clone...`)
    await provider.stopVm(proj.vm_id)
    registry.updateProjectStatus(projectName, 'stopped')
  }

  const diskPath = projectDiskPath(projectName)
  if (!existsSync(diskPath)) die(`Project disk not found: ${diskPath}`)

  console.log(`Creating ${tickets.length} ticket VMs in parallel...`)
  const results = await Promise.allSettled(
    tickets.map(async (ticket) => {
      if (registry.get(ticket)) throw new Error(`Ticket ${ticket} already exists`)
      const provider = await resolveProvider()
      const vm = await provider.createVm(ticket, diskPath)
      registry.register({
        ticket,
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

  for (let i = 0; i < tickets.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      console.log(`  ${tickets[i]}: created (${result.value.vmId})`)
    } else {
      console.error(`  ${tickets[i]}: FAILED - ${result.reason?.message ?? result.reason}`)
    }
  }

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`\n${succeeded} created, ${failed} failed`)
}

async function cmdBulkDelete(tickets: string[]) {
  console.log(`Deleting ${tickets.length} ticket VMs in parallel...`)
  const results = await Promise.allSettled(
    tickets.map(async (ticket) => {
      const env = registry.get(ticket)
      if (!env) throw new Error(`No environment found for ticket ${ticket}`)
      const provider = await resolveProvider(ticket)
      await provider.deleteVm(env.vm_id)
      registry.remove(ticket)
    })
  )

  for (let i = 0; i < tickets.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      console.log(`  ${tickets[i]}: deleted`)
    } else {
      console.error(`  ${tickets[i]}: FAILED - ${result.reason?.message ?? result.reason}`)
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
  console.log(`Tickets:  ${envs.length} total (${running} running, ${stopped} stopped)`)

  const providers = await listProviders()
  console.log('\nProviders:')
  for (const p of providers) {
    console.log(`  ${p.name}: ${p.available ? 'available' : 'not available'}`)
  }

  const baseImg = defaultBaseImage()
  console.log(`\nBase image: ${baseImg || 'not found (run agent-swarm init-base)'}`)
}

async function cmdCheckpoint(ticket: string, name?: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)
  const snapshotName = name ?? new Date().toISOString().replace(/[:.]/g, '-')
  console.log(`Creating checkpoint '${snapshotName}' for ${ticket}...`)
  await provider.checkpoint(env.vm_id, snapshotName)
  console.log('Checkpoint created.')
}

async function cmdRestore(ticket: string, name?: string) {
  const env = registry.get(ticket)
  if (!env) die(`No environment found for ticket ${ticket}`)
  const provider = await resolveProvider(ticket)
  if (!name) {
    const checkpoints = await provider.listCheckpoints(env.vm_id)
    if (checkpoints.length === 0) die(`No checkpoints found for ${ticket}`)
    name = checkpoints[checkpoints.length - 1]
    console.log(`Restoring latest checkpoint: ${name}`)
  }
  console.log(`Restoring ${ticket} to '${name}'...`)
  await provider.restore(env.vm_id, name!)
  registry.updateStatus(ticket, 'stopped')
  console.log('Restored. Start with: agent-swarm start ' + ticket)
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
    console.log('  Linux:   apt install libvirt-daemon-system virtinst (future)')
  }
}

async function cmdInitBase() {
  mkdirSync(BASE_IMAGE_DIR, { recursive: true })

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const imageUrl = `https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-${arch}.img`
  const qcow2Path = join(BASE_IMAGE_DIR, `ubuntu-24.04-${arch}.qcow2`)
  const rawPath = join(BASE_IMAGE_DIR, 'ubuntu-24.04.img')

  if (existsSync(rawPath)) {
    console.log(`Base image already exists: ${rawPath}`)
    console.log('Delete it first if you want to re-download.')
    return
  }

  // Download using curl (built into macOS)
  console.log(`Downloading Ubuntu 24.04 cloud image (${arch})...`)
  console.log(`  ${imageUrl}`)
  await exec('curl', ['-L', '--progress-bar', '-o', qcow2Path, imageUrl])

  // Convert qcow2 to raw using our Swift helper
  const helperBin = join(homedir(), '.agent-swarm', 'bin', 'vm-helper')
  if (!existsSync(helperBin)) {
    // Trigger compilation via provider detection
    const provider = await detectProvider()
    if (!provider) die('No provider available to compile VM helper')
  }

  console.log('Converting qcow2 to raw disk image...')
  await exec(helperBin, ['convert-qcow2', qcow2Path, rawPath])

  // Clean up qcow2
  await exec('rm', ['-f', qcow2Path])

  console.log(`\nBase image ready: ${rawPath}`)
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
      const ticket = args[2]
      if (!projectName || !ticket) die('Usage: agent-swarm create <PROJECT> <TICKET>')
      await cmdCreate(projectName, ticket)
      break
    }
    case 'list':
      await cmdList()
      break
    case 'ssh':
      if (!args[1]) die('Usage: agent-swarm ssh <TICKET>')
      await cmdSsh(args[1])
      break
    case 'run':
      if (!args[1] || args.length < 3) die('Usage: agent-swarm run <TICKET> <command...>')
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
          const bulkTickets = args.slice(3)
          if (!bulkProject || bulkTickets.length === 0) die('Usage: agent-swarm bulk create <PROJECT> <T1> <T2> ...')
          await cmdBulkCreate(bulkProject, bulkTickets)
          break
        }
        case 'delete': {
          if (args[2] === '--project') {
            const projName = args[3]
            if (!projName) die('Usage: agent-swarm bulk delete --project <NAME>')
            const tickets = registry.list().filter(e => e.project === projName)
            if (tickets.length === 0) die(`No tickets found for project ${projName}`)
            await cmdBulkDelete(tickets.map(t => t.ticket))
          } else {
            const bulkTickets = args.slice(2)
            if (bulkTickets.length === 0) die('Usage: agent-swarm bulk delete <T1> <T2> ...')
            await cmdBulkDelete(bulkTickets)
          }
          break
        }
        default:
          die(`Unknown bulk subcommand: ${bulkCmd}. Use 'create' or 'delete'.`)
      }
      break
    }
    case 'stop':
      if (!args[1]) die('Usage: agent-swarm stop <TICKET>')
      await cmdStop(args[1])
      break
    case 'start':
      if (!args[1]) die('Usage: agent-swarm start <TICKET>')
      await cmdStart(args[1])
      break
    case 'code':
      if (!args[1]) die('Usage: agent-swarm code <TICKET> [path]')
      await cmdCode(args[1], args[2] ?? '/home/worker')
      break
    case 'delete':
      if (!args[1]) die('Usage: agent-swarm delete <TICKET>')
      await cmdDelete(args[1])
      break
    case 'status':
      await cmdStatus()
      break
    case 'checkpoint': {
      if (!args[1]) die('Usage: agent-swarm checkpoint <TICKET> [name]')
      await cmdCheckpoint(args[1], args[2])
      break
    }
    case 'restore': {
      if (!args[1]) die('Usage: agent-swarm restore <TICKET> [name]')
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
