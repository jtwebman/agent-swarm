# Agent Swarm - Cross-Platform Multi-Agent Dev Environments

## The Problem

You want multiple Claude Code agents working on the same project simultaneously, each on a different ticket. But they can't share a single machine - ports conflict, Docker Compose stacks collide, database state bleeds across branches. You need full isolation.

## The Solution

Each ticket gets its own VM with its own Postgres, Redis, services, ports. A CLI tool manages the lifecycle. A pluggable provider abstraction supports different hypervisors per platform, and cloud providers later.

## Workflow

```
agent-swarm create DROP-2100     # new VM boots from base image
ssh into it, git checkout -b DROP-2100-my-feature
work on backend code, run tests, iterate
agent-swarm checkpoint DROP-2100 before-refactor    # save point
if things go wrong: agent-swarm restore DROP-2100 before-refactor
when done: commit, push, open PR
after merge: agent-swarm delete DROP-2100
```

Run 3-6 of these simultaneously. Each fully isolated. No conflicts.

## Architecture

```
agent-swarm CLI (TypeScript, Node 24)
       │
       ├── Provider Interface (abstract)
       │     ├── HyperVProvider    (Windows)
       │     ├── TartProvider      (Mac - Apple Virtualization Framework)
       │     ├── KvmProvider       (Linux - libvirt/virsh)
       │     └── AwsProvider       (future - EC2 spot instances)
       │
       ├── Environment Registry (SQLite via node:sqlite)
       │     └── tracks: ticket → provider, VM ID, IP, status, created_at
       │
       └── Base Image Builder (per-provider golden image setup)
```

## Provider Interface

Every provider implements the same interface:

```typescript
type VmInfo = {
  vmId: string
  ticket: string
  ip: string | null
  status: 'running' | 'stopped' | 'creating'
}

type Provider = {
  name: string
  available: () => Promise<boolean>
  createVm: (ticket: string, baseImage: string) => Promise<VmInfo>
  startVm: (vmId: string) => Promise<void>
  stopVm: (vmId: string) => Promise<void>
  deleteVm: (vmId: string) => Promise<void>
  sshInfo: (vmId: string) => Promise<{ host: string; port: number; user: string }>
  checkpoint: (vmId: string, name: string) => Promise<void>
  restore: (vmId: string, name: string) => Promise<void>
  listCheckpoints: (vmId: string) => Promise<string[]>
  status: (vmId: string) => Promise<VmStatus>
  listVms: () => Promise<VmInfo[]>
}
```

Each provider shells out to the native CLI for its hypervisor:
- **HyperVProvider** → `powershell.exe` with `New-VM`, `Checkpoint-VM`, etc.
- **TartProvider** → `tart clone`, `tart run`, `tart snapshot` (Homebrew install)
- **KvmProvider** → `virsh create`, `virsh snapshot-create`, `virsh domifaddr`
- **AwsProvider** (future) → `aws ec2 run-instances`, AMIs, snapshots

## Ticket Pinning

A ticket is permanently bound to the provider it was created on. The SQLite registry enforces this. No migration between providers. If you create DROP-2100 on Hyper-V, every command for DROP-2100 routes to Hyper-V.

## CLI Commands

```
agent-swarm create <TICKET>              # copy base image, create VM, print SSH info
agent-swarm list                         # all VMs: ticket, provider, IP, status, disk
agent-swarm ssh <TICKET>                 # SSH into the VM
agent-swarm checkpoint <TICKET> [name]   # snapshot (defaults to timestamp)
agent-swarm restore <TICKET> [name]      # revert to snapshot
agent-swarm stop <TICKET>               # stop VM, keep disk
agent-swarm start <TICKET>              # start stopped VM
agent-swarm delete <TICKET>             # stop + remove VM + delete disk
agent-swarm status                       # resource overview (CPU/RAM allocated vs available)
agent-swarm providers                    # list available providers on this machine
agent-swarm init-base                    # build golden base image for detected provider
```

## Environment Registry

SQLite at `~/.agent-swarm/registry.db`:

```sql
CREATE TABLE environment (
  ticket      TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  vm_id       TEXT NOT NULL,
  base_image  TEXT NOT NULL,
  ip          TEXT,
  status      TEXT DEFAULT 'running',
  created_at  TEXT DEFAULT (datetime('now'))
);
```

## Base Image

Each provider has its own image format (VHDX, .tart, qcow2, AMI), but the contents are the same. A shared `setup-base.sh` provisioning script installs:

- Ubuntu Server (no GUI, no Docker)
- Postgres + pgvector (systemd service)
- Redis (systemd service)
- gcloud CLI (for PubSub emulator: `gcloud beta emulators pubsub start`)
- Node.js 24, npm
- Python 3.11+, Poetry
- Rust toolchain
- Git, SSH server (key-based auth)

Target: ~2 vCPU / 4GB RAM per VM. No Docker inside the VMs - all services run natively as systemd units.

## Provider Details

### Windows: Hyper-V
- Free, built into Windows 11 Pro
- Native checkpoints (instant save/restore)
- Differencing disks for fast cloning from base VHDX
- Internal virtual switch for networking
- Controlled via PowerShell cmdlets

### Mac: Tart
- Uses Apple Virtualization Framework (native performance)
- CLI-driven: `tart clone`, `tart run`, `tart snapshot`
- Works on both Apple Silicon and Intel
- OCI registry support for image distribution
- Install via Homebrew

### Linux: KVM/libvirt
- Production-grade, near-native performance
- `virsh` CLI for full lifecycle management
- Internal/external snapshot support
- Cloud-init for provisioning
- Works on any Linux with KVM support

### Future: AWS EC2
- Spot instances for 50-90% cost savings
- AMIs as base images
- EBS snapshots for checkpoints
- Good for teams or when local resources aren't enough

## Project Structure

```
agent-swarm/
├── package.json
├── PLAN.md
├── src/
│   ├── cli.ts                  # arg parsing, command dispatch
│   ├── registry.ts             # SQLite environment registry
│   ├── provider.ts             # Provider type definition
│   ├── providers/
│   │   ├── detect.ts           # auto-detect available provider
│   │   ├── hyperv.ts
│   │   ├── tart.ts
│   │   └── kvm.ts
│   ├── ssh.ts                  # SSH connection helper
│   └── base-image/
│       └── setup-base.sh       # shared provisioning script
└── README.md
```

## Tech Stack

- TypeScript + Node 24 (native TS stripping, no build step)
- node:sqlite for registry
- child_process for shelling out to hypervisor CLIs
- No classes - functional patterns throughout
- Minimal dependencies

## Implementation Order

1. Scaffold project (package.json, CLI entry point)
2. Provider interface + SQLite registry
3. Provider auto-detection
4. First provider (whichever platform you're building on)
5. CLI commands wired up
6. Base image builder (setup-base.sh + provider wrapper)
7. Second and third providers
8. Cloud providers (future)

## Key Decisions

- **No Docker inside VMs** - Postgres, Redis, PubSub emulator run as native services. Lighter weight, fewer layers of abstraction.
- **Ticket pinned to provider** - simplifies everything, no cross-provider state sync needed.
- **Shell out to native CLIs** - don't fight hypervisor APIs, just wrap their well-documented CLIs.
- **Shared provisioning script** - one setup-base.sh works across all providers via cloud-init or SSH provisioning.
- **Personal tool first** - scoped to backend dev workflow, not trying to be a team platform on day one.
