# agent-swarm

Isolated VM environments for running multiple AI coding agents in parallel. Each agent gets its own full Linux VM — no port conflicts, no shared state, no interference.

## Why

When running multiple Claude Code agents (or any AI coding agents) on the same codebase, they step on each other: conflicting ports, overlapping file edits, shared databases. Agent Swarm solves this by giving each task its own VM, cloned instantly from a pre-configured project template.

## How it works

```
┌─────────────┐    instant clone     ┌──────────────┐
│  Project VM  │ ──────────────────> │   Task VM    │
│  (template)  │                     │  fix-login   │
│              │                     │              │
│  docker      │ ──────────────────> │  docker      │
│  postgres    │                     │  postgres    │
│  node        │ ──────────────────> │  node        │
│  your repo   │                     │  your repo   │
└─────────────┘                     └──────────────┘
                                          │
                                    ┌──────────────┐
                                    │   Task VM    │
                                    │  add-tests   │
                                    │  ...         │
                                    └──────────────┘
```

1. **Set up once**: Create a project VM, install all your dependencies
2. **Clone instantly**: Each task gets a copy-on-write clone (APFS on macOS, qcow2 backing files on Linux, differencing VHDs on Windows)
3. **Work in isolation**: Every agent has its own filesystem, network, and processes
4. **Clean up**: Delete task VMs when done, project template stays untouched

## Requirements

- **Node.js 24+** (uses native TypeScript stripping and built-in SQLite)
- One of the following VM platforms:

### macOS

- Apple Silicon or Intel
- Xcode Command Line Tools

```bash
xcode-select --install
```

### Linux

- KVM-capable CPU (most modern x86_64 and ARM processors)
- libvirt, QEMU, virt-install, genisoimage, OVMF (UEFI firmware)

```bash
sudo apt install qemu-kvm libvirt-daemon-system virtinst genisoimage ovmf
sudo usermod -aG libvirt $USER
# Log out and back in for group change to take effect
```

For encrypted env vars, install libsecret:

```bash
sudo apt install libsecret-tools
```

### Windows

- Windows 10/11 Pro or Enterprise with Hyper-V enabled
- `qemu-img` for base image conversion (install [QEMU for Windows](https://qemu.weilnetz.de/w64/))

```powershell
# Enable Hyper-V (run as Administrator, requires reboot)
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
```

For cloud-init ISO creation, install Windows ADK (provides `oscdimg.exe`).

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

# Stop the project (saves it as the template for tasks)
agent-swarm project stop myapp

# Create task VMs (instant clone from project)
agent-swarm create myapp fix-login
agent-swarm create myapp add-tests

# SSH into a task — full isolated copy of your project
agent-swarm ssh fix-login

# Open VS Code connected to the VM
agent-swarm code fix-login

# Checkpoint before risky changes
agent-swarm checkpoint fix-login before-refactor

# Restore if things go wrong
agent-swarm restore fix-login before-refactor

# Clean up when done
agent-swarm delete fix-login
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
| `agent-swarm project stop <NAME>` | Stop and save as new task baseline |
| `agent-swarm project run <NAME> <command...>` | Run a command in a project VM |
| `agent-swarm project code <NAME> [path]` | Open VS Code remote into project VM |
| `agent-swarm project delete <NAME>` | Delete project VM and disk |

### Tasks (isolated work environments)

| Command | Description |
|---------|-------------|
| `agent-swarm create <PROJECT> <TASK>` | Create task VM cloned from project |
| `agent-swarm list` | List all task VMs |
| `agent-swarm ssh <TASK>` | SSH into task VM |
| `agent-swarm run <TASK> <command...>` | Run a command inside a task VM |
| `agent-swarm code <TASK> [path]` | Open VS Code remote into task VM |
| `agent-swarm start <TASK>` | Start a stopped task VM |
| `agent-swarm stop <TASK>` | Stop a task VM |
| `agent-swarm delete <TASK>` | Delete a task VM |

### File transfer

| Command | Description |
|---------|-------------|
| `agent-swarm cp ./file TASK:/path` | Copy a file into a VM |
| `agent-swarm cp TASK:/path ./file` | Copy a file from a VM |

### Bulk operations

| Command | Description |
|---------|-------------|
| `agent-swarm bulk create <PROJECT> <T1> <T2> ...` | Create multiple tasks in parallel |
| `agent-swarm bulk delete <T1> <T2> ...` | Delete multiple tasks in parallel |
| `agent-swarm bulk delete --project <NAME>` | Delete all tasks for a project |

### Environment variables

| Command | Description |
|---------|-------------|
| `agent-swarm env set <KEY> <VALUE>` | Set a global env var (encrypted) |
| `agent-swarm env set <KEY> <VALUE> --project <NAME>` | Set a per-project override |
| `agent-swarm env list` | List global env var names |
| `agent-swarm env list --project <NAME>` | List resolved env var names for project |
| `agent-swarm env rm <KEY>` | Remove a global env var |
| `agent-swarm env rm <KEY> --project <NAME>` | Remove a per-project override |

### Snapshots

| Command | Description |
|---------|-------------|
| `agent-swarm checkpoint <TASK> [name]` | Create a snapshot |
| `agent-swarm restore <TASK> [name]` | Restore from snapshot |

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

## Git SSH access inside VMs

Agent Swarm forwards your host's SSH agent into VMs so git push/pull over SSH works without copying keys. For this to work, your key must be loaded in the agent:

```bash
# Check if your key is loaded
ssh-add -l

# If empty, add your key
ssh-add ~/.ssh/id_ed25519

# On macOS, to persist across reboots, add to Keychain
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

Then connect (or reconnect) to the VM:

```bash
agent-swarm project ssh myapp

# Inside the VM, git SSH operations use your host key
git clone git@github.com:you/repo.git
git push origin main
```

If you see `Permission denied (publickey)`, exit the VM and verify `ssh-add -l` shows your key on the host, then reconnect.

## Running agents in parallel

The `run` and `bulk` commands are designed for orchestrating multiple AI agents:

```bash
# Create 3 task VMs in parallel
agent-swarm bulk create myapp fix-login add-tests update-docs

# Run agents in each VM (from separate terminals or scripts)
agent-swarm run fix-login claude --print "fix the login bug"
agent-swarm run add-tests claude --print "add unit tests for auth"
agent-swarm run update-docs claude --print "update the API docs"

# Copy results back
agent-swarm cp fix-login:/home/worker/project/results.json ./results-login.json

# Clean up all task VMs for the project
agent-swarm bulk delete --project myapp
```

## Encrypted environment variables

Env vars are stored encrypted (AES-256-GCM) in the local SQLite registry. The encryption key is stored in your platform's secure store (macOS Keychain, Linux libsecret/GNOME Keyring, or Windows DPAPI). They're automatically injected into all `run`, `project run`, `ssh`, and `project ssh` sessions.

```bash
# Set a global env var (available in all projects)
agent-swarm env set ANTHROPIC_API_KEY sk-ant-...
agent-swarm env set GITHUB_TOKEN ghp_...

# Set a per-project override
agent-swarm env set ANTHROPIC_API_KEY sk-different --project myapp

# List env var names (values are never shown)
agent-swarm env list
agent-swarm env list --project myapp

# Remove an env var
agent-swarm env rm GITHUB_TOKEN
agent-swarm env rm ANTHROPIC_API_KEY --project myapp
```

Per-project vars override global vars. Values are encrypted at rest — `sqlite3 ~/.agent-swarm/registry.db "select * from env_var"` shows only encrypted ciphertext.

The secret storage uses a pluggable backend interface (`SecretBackend`), making it possible to swap in Vault, 1Password, AWS Secrets Manager, or other providers in the future.

## Features

- **Instant cloning**: Copy-on-write clones (APFS, qcow2 backing files, differencing VHDs) mean task VMs are created in seconds
- **Cross-platform**: macOS (Virtualization.framework), Linux (KVM/libvirt), Windows (Hyper-V)
- **SSH agent forwarding**: Git push/pull works inside VMs using your host SSH keys
- **VS Code integration**: `code .` inside an SSH session opens VS Code on your Mac connected to the VM
- **Snapshots**: Checkpoint and restore task VMs at any point
- **Customizable setup**: Edit `~/.agent-swarm/setup.sh` to control what's pre-installed
- **Clean process model**: All commands exit cleanly — no background terminals needed

## Architecture

```
src/
  cli.ts                    # CLI entry point and command routing
  provider.ts               # Provider interface (VM abstraction)
  registry.ts               # SQLite registry for projects, tasks, and env vars
  secrets.ts                # Encrypted env var storage (cross-platform key providers)
  cloud-init.ts             # Shared cloud-init ISO creation (macOS/Linux/Windows)
  ssh.ts                    # SSH sessions with agent forwarding and code forwarding
  exec.ts                   # Command execution utilities
  providers/
    detect.ts               # Auto-detect available providers
    macos-native.ts         # macOS Virtualization.framework provider
    kvm.ts                  # Linux KVM/libvirt provider
    hyperv.ts               # Windows Hyper-V provider
  vm-helper/
    main.swift              # Swift helper for VM lifecycle management (macOS)
    entitlements.plist      # Code signing entitlements
```

The Swift VM helper is compiled automatically on first run and cached at `~/.agent-swarm/bin/vm-helper`.

**Storage layout:**
```
~/.agent-swarm/
  base-images/              # Downloaded OS images
  vms/
    project-<name>/         # Project VM disks
    agent-swarm-<task>/     # Task VM disks
  snapshots/                # Checkpoint snapshots
  bin/                      # Compiled VM helper
  setup.sh                  # VM setup customization script
  registry.db               # SQLite database
```

## Providers

Three VM providers are included:

- **macOS** — Virtualization.framework (zero external dependencies)
- **Linux** — KVM/libvirt (virsh, virt-install, qemu-img)
- **Windows** — Hyper-V (PowerShell cmdlets)

The provider interface supports additional backends. Future options:

- **Cloud (AWS EC2, GCP)** — for remote VMs

## License

GPLv3 — see [LICENSE](LICENSE).
