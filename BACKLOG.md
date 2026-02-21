# Agent Swarm Backlog

## Phase 1: Foundation
- [x] Scaffold project (package.json, bin entry point, Node 24 native TS)
- [x] Provider type definition
- [x] SQLite environment registry (create, read, update, delete)
- [x] CLI argument parsing and command dispatch
- [x] Provider auto-detection (check what's available on this machine)

## Phase 2: First Provider (macOS Native - Virtualization.framework)
- [x] Swift VM helper using Apple Virtualization.framework (zero dependencies)
- [x] Auto-compile Swift helper on first run (swiftc + codesign built into macOS)
- [x] `create` command - APFS clone base image, cloud-init ISO, boot VM, wait for IP, register
- [x] `list` command - show all VMs with task, provider, IP, status
- [x] `ssh` command - connect to VM by task name
- [x] `stop` / `start` commands
- [x] `delete` command - stop VM, remove disk, deregister
- [x] `status` command - resource usage overview
- [x] `providers` command - list what's available

## Phase 3: Snapshots
- [x] `checkpoint` command - APFS copy-on-write clone (instant)
- [x] `restore` command - revert to snapshot
- [x] `listCheckpoints` - show available snapshots for a task
- [x] Default checkpoint name to timestamp when not provided

## Phase 4: Base Image
- [x] `init-base` command - download Ubuntu cloud image, qcow2-to-raw conversion
- [x] Built-in qcow2 converter in Swift helper (no qemu-img needed)
- [x] Cloud-init ISO creation with hdiutil (built into macOS)
- [ ] Write setup-base.sh provisioning script (cloud-init user-data)
- [ ] Postgres + pgvector installation and systemd config
- [ ] Redis installation and systemd config
- [ ] gcloud CLI installation (for PubSub emulator)
- [ ] Node.js 24, Python 3.11+, Poetry, Rust toolchain
- [ ] VM startup script (ensure services running, pull latest, show status)

## Phase 5: Additional Providers
- [x] Hyper-V provider (PowerShell cmdlets, differencing disks, internal switch)
- [x] KVM/virsh provider (libvirt, cloud-init, qcow2)

## Phase 6: Developer Experience
- [x] Helpful error messages when provider not available (install instructions)
- [ ] Progress indicators for long operations (image copy, VM boot)
- [ ] Config file (~/.agent-swarm/config.json) for base image paths, default resources
- [ ] Configurable vCPU/RAM per VM (default 2/4GB)
- [ ] Tab completion for task names

## Phase 7: Multi-Agent Orchestration
- [x] `agent-swarm run <TICKET> <command>` - run a command inside a VM via SSH
- [x] `agent-swarm project run <NAME> <command>` - run a command in a project VM
- [x] `agent-swarm bulk create <PROJECT> TICKET-1 TICKET-2 ...` - spin up multiple at once
- [x] `agent-swarm bulk delete` - tear down tasks in parallel (by name or `--project`)
- [x] Parallel VM creation with `Promise.allSettled()`
- [x] `agent-swarm cp` - copy files in/out of VMs via scp
- [x] Environment variable forwarding (`~/.agent-swarm/env` config)
- [x] Encrypted env var storage (AES-256-GCM, macOS Keychain key)
- [x] Global and per-project env var scoping
- [x] Env vars forwarded into SSH interactive sessions
- [ ] Resource limit checks (don't oversubscribe host CPU/RAM)

## Phase 8: Cloud Providers
- [ ] AWS EC2 provider (spot instances, AMIs, EBS snapshots)
- [ ] GCP Compute Engine provider (preemptible VMs, machine images)
- [ ] Auto-stop idle VMs (cost savings for cloud)
- [ ] Estimated cost display for cloud VMs

## Phase 9: Secret Backend Plugins
- [ ] Config file for selecting secret backend (`~/.agent-swarm/config.json`)
- [ ] HashiCorp Vault backend
- [ ] 1Password backend (via CLI)
- [ ] AWS Secrets Manager backend
- [x] Linux `libsecret` KeyProvider (for Linux Keychain equivalent)
- [x] Windows DPAPI KeyProvider

## Future Ideas
- [ ] Web dashboard showing all running VMs and their status
- [ ] Integration with Claude Code hooks (auto-create VM on session start?)
- [ ] Git integration - auto-create branch matching task name
- [ ] PR creation from inside VM
- [ ] Shared base image registry (team members pull same golden image)
- [ ] VM templates per project (Drops backend, Drops ML, generic Node, etc.)
- [ ] Metrics: how long each VM has been running, disk usage trends
- [ ] Auto-checkpoint before destructive operations
- [ ] Export/import VMs for sharing or backup
