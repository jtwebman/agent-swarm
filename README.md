# agent-swarm

Isolated VM environments for running multiple AI coding agents in parallel. Each agent gets its own full Linux VM — no port conflicts, no shared state, no interference.

## Why

When running multiple Claude Code agents (or any AI coding agents) on the same codebase, they step on each other: conflicting ports, overlapping file edits, shared databases. Agent Swarm solves this by giving each work ticket its own VM, cloned instantly from a pre-configured project template.

## How it works

```
┌─────────────┐     APFS clone      ┌──────────────┐
│  Project VM  │ ──────────────────> │  Ticket VM   │
│  (template)  │     (instant)       │  DROP-2100   │
│              │                     │              │
│  docker      │ ──────────────────> │  docker      │
│  postgres    │                     │  postgres    │
│  node        │ ──────────────────> │  node        │
│  your repo   │                     │  your repo   │
└─────────────┘                     └──────────────┘
                                          │
                                    ┌──────────────┐
                                    │  Ticket VM   │
                                    │  DROP-2101   │
                                    │  ...         │
                                    └──────────────┘
```

1. **Set up once**: Create a project VM, install all your dependencies
2. **Clone instantly**: Each ticket gets an APFS copy-on-write clone (uses almost no disk space)
3. **Work in isolation**: Every agent has its own filesystem, network, and processes
4. **Clean up**: Delete ticket VMs when done, project template stays untouched

## Requirements

- **macOS** (Apple Silicon or Intel) with Xcode Command Line Tools
- **Node.js 24+** (uses native TypeScript stripping and built-in SQLite)

```bash
xcode-select --install
```

## Install

```bash
git clone https://github.com/jtwebman/agent-swarm.git
cd agent-swarm
npm link
```

## Quick start

```bash
# Download Ubuntu base image (~600MB)
agent-swarm init-base

# Create a project VM (boots Ubuntu, installs your tools)
agent-swarm project create myapp

# SSH in and set up your dev environment
agent-swarm project ssh myapp
# Inside VM: clone repo, install deps, start services, etc.

# Stop the project (saves it as the template for tickets)
agent-swarm project stop myapp

# Create ticket VMs (instant APFS clone)
agent-swarm create myapp TICKET-100
agent-swarm create myapp TICKET-101

# SSH into a ticket — full isolated copy of your project
agent-swarm ssh TICKET-100

# Open VS Code connected to the VM
agent-swarm code TICKET-100

# Checkpoint before risky changes
agent-swarm checkpoint TICKET-100 before-refactor

# Restore if things go wrong
agent-swarm restore TICKET-100 before-refactor

# Clean up when done
agent-swarm delete TICKET-100
```

## Commands

### Base image

| Command | Description |
|---------|-------------|
| `agent-swarm init-base` | Download and prepare Ubuntu 24.04 cloud image |

### Projects (VM templates)

| Command | Description |
|---------|-------------|
| `agent-swarm project create <NAME>` | Create a project VM from base image |
| `agent-swarm project list` | List all projects |
| `agent-swarm project ssh <NAME>` | SSH into project (auto-starts if stopped) |
| `agent-swarm project stop <NAME>` | Stop and save as new ticket baseline |
| `agent-swarm project code <NAME> [path]` | Open VS Code remote into project VM |
| `agent-swarm project delete <NAME>` | Delete project VM and disk |

### Tickets (isolated work environments)

| Command | Description |
|---------|-------------|
| `agent-swarm create <PROJECT> <TICKET>` | Create ticket VM cloned from project |
| `agent-swarm list` | List all ticket VMs |
| `agent-swarm ssh <TICKET>` | SSH into ticket VM |
| `agent-swarm code <TICKET> [path]` | Open VS Code remote into ticket VM |
| `agent-swarm start <TICKET>` | Start a stopped ticket VM |
| `agent-swarm stop <TICKET>` | Stop a ticket VM |
| `agent-swarm delete <TICKET>` | Delete a ticket VM |

### Snapshots

| Command | Description |
|---------|-------------|
| `agent-swarm checkpoint <TICKET> [name]` | Create a snapshot |
| `agent-swarm restore <TICKET> [name]` | Restore from snapshot |

### Status

| Command | Description |
|---------|-------------|
| `agent-swarm status` | Resource overview |
| `agent-swarm providers` | List available VM providers |

## VM setup customization

On first project creation, a setup script is generated at `~/.agent-swarm/setup.sh`. This runs inside each new project VM after the base user is created. Edit it to customize what gets installed:

```bash
# Default installs: Docker, Docker Compose, build-essential, curl, wget, git,
# zsh + Oh My Zsh, Node.js LTS (via nvm), and Claude Code CLI
cat ~/.agent-swarm/setup.sh
```

Changes to `setup.sh` take effect on the next `agent-swarm project create`.

## Features

- **Instant cloning**: APFS copy-on-write means ticket VMs are created in seconds and use minimal disk space
- **Zero dependencies**: Uses macOS Virtualization.framework directly — no Docker, no Vagrant, no QEMU
- **SSH agent forwarding**: Git push/pull works inside VMs using your host SSH keys
- **VS Code integration**: `code .` inside an SSH session opens VS Code on your Mac connected to the VM
- **Snapshots**: Checkpoint and restore ticket VMs at any point
- **Customizable setup**: Edit `~/.agent-swarm/setup.sh` to control what's pre-installed
- **Clean process model**: All commands exit cleanly — no background terminals needed

## Architecture

```
src/
  cli.ts                    # CLI entry point and command routing
  provider.ts               # Provider interface (VM abstraction)
  registry.ts               # SQLite registry for projects and tickets
  ssh.ts                    # SSH sessions with agent forwarding and code forwarding
  exec.ts                   # Command execution utilities
  providers/
    detect.ts               # Auto-detect available providers
    macos-native.ts         # macOS Virtualization.framework provider
  vm-helper/
    main.swift              # Swift helper for VM lifecycle management
    entitlements.plist      # Code signing entitlements
```

The Swift VM helper is compiled automatically on first run and cached at `~/.agent-swarm/bin/vm-helper`.

**Storage layout:**
```
~/.agent-swarm/
  base-images/              # Downloaded OS images
  vms/
    project-<name>/         # Project VM disks
    agent-swarm-<ticket>/   # Ticket VM disks
  snapshots/                # Checkpoint snapshots
  bin/                      # Compiled VM helper
  setup.sh                  # VM setup customization script
  registry.db               # SQLite database
```

## Future providers

The provider interface is designed to support additional backends:

- **Linux (KVM/libvirt)** — for Linux hosts
- **Windows (Hyper-V)** — for Windows hosts
- **Cloud (AWS EC2, GCP)** — for remote VMs

## License

GPLv3 — see [LICENSE](LICENSE).
