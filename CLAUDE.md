# Agent Swarm — CLAUDE.md Snippet

> **Copy this section into your project's CLAUDE.md** so Claude Code knows how to use agent-swarm for isolated VM workflows.

---

## Agent Swarm (VM-Isolated Development)

This project uses [agent-swarm](https://github.com/jtwebman/agent-swarm) to run AI coding agents in isolated Linux VMs. Each task gets its own full VM — no port conflicts, no shared state.

### One-Time Setup

```bash
# Download Ubuntu base image (~600MB)
agent-swarm init-base

# Create and configure the project VM template
agent-swarm project create <PROJECT>
agent-swarm project ssh <PROJECT>
# Inside VM: clone repo, install deps, run DB migrations, start services
# Exit when setup is complete

# Stop the project (saves as the template for all task VMs)
agent-swarm project stop <PROJECT>
```

### Per-Task Workflow

```bash
# Create a task VM (instant clone from project template)
agent-swarm create <PROJECT> <TASK>

# SSH into the task VM
agent-swarm ssh <TASK>

# Run a command inside the VM
agent-swarm run <TASK> <command...>

# Checkpoint before risky changes
agent-swarm checkpoint <TASK> [name]

# Restore if things go wrong
agent-swarm restore <TASK> [name]

# Delete when done
agent-swarm delete <TASK>
```

### Bulk Operations (Parallel Agents)

```bash
# Create multiple task VMs in parallel
agent-swarm bulk create <PROJECT> fix-login add-tests update-docs

# Run agents in each VM
agent-swarm run fix-login claude --print "fix the login bug"
agent-swarm run add-tests claude --print "add unit tests for auth"
agent-swarm run update-docs claude --print "update the API docs"

# Delete all tasks for a project
agent-swarm bulk delete --project <PROJECT>
```

### Environment Variables

```bash
# Set encrypted env vars (injected into all SSH/run sessions)
agent-swarm env set ANTHROPIC_API_KEY sk-ant-...
agent-swarm env set GITHUB_TOKEN ghp_...

# Per-project override
agent-swarm env set DATABASE_URL postgres://... --project <PROJECT>

# List env var names
agent-swarm env list [--project <PROJECT>]

# Remove
agent-swarm env rm <KEY> [--project <PROJECT>]
```

### File Transfer

```bash
# Copy file into VM
agent-swarm cp ./local-file.txt TASK:/home/worker/file.txt

# Copy file from VM
agent-swarm cp TASK:/home/worker/results.json ./results.json
```

### Key Commands Reference

| Command | Description |
|---------|-------------|
| `agent-swarm init-base` | Download and prepare base VM image |
| `agent-swarm project create <NAME>` | Create project VM from base image |
| `agent-swarm project ssh <NAME>` | SSH into project (auto-starts) |
| `agent-swarm project stop <NAME>` | Stop and save as task baseline |
| `agent-swarm project delete <NAME>` | Delete project VM |
| `agent-swarm create <PROJECT> <TASK>` | Create task VM (cloned from project) |
| `agent-swarm ssh <TASK>` | SSH into task VM |
| `agent-swarm run <TASK> <cmd...>` | Run command in task VM |
| `agent-swarm start <TASK>` | Start stopped task VM |
| `agent-swarm stop <TASK>` | Stop task VM |
| `agent-swarm delete <TASK>` | Delete task VM |
| `agent-swarm cp <src> <dest>` | Copy files in/out of VM |
| `agent-swarm bulk create <P> <T...>` | Create multiple tasks in parallel |
| `agent-swarm bulk delete <T...>` | Delete multiple tasks in parallel |
| `agent-swarm checkpoint <T> [name]` | Create snapshot |
| `agent-swarm restore <T> [name]` | Restore snapshot |
| `agent-swarm env set <K> <V>` | Set encrypted env var |
| `agent-swarm env list` | List env var names |
| `agent-swarm status` | Resource overview |
| `agent-swarm providers` | List available VM providers |
