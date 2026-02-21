import { exec } from './exec.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SWARM_DIR = join(homedir(), '.agent-swarm')
const SETUP_SCRIPT = join(SWARM_DIR, 'setup.sh')

export const DEFAULT_SETUP = `#!/bin/bash
# Agent Swarm VM Setup Script
# Edit this file to customize what gets installed in new project VMs.
# Runs as root during first boot. The 'worker' user already exists.

set -e

# --- System packages ---
apt-get update
apt-get install -y \\
  ca-certificates curl wget git zsh unzip build-essential

# --- Docker (official repo) ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo "\$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
systemctl start docker
usermod -aG docker worker

# --- Default shell to zsh ---
chsh -s /bin/zsh worker

# --- Oh My Zsh ---
su - worker -c 'sh -c "\$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended'

# --- nvm + Node.js LTS ---
su - worker -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
su - worker -c 'export NVM_DIR="\$HOME/.nvm" && . "\$NVM_DIR/nvm.sh" && nvm install --lts'

# --- Claude Code CLI ---
su - worker -c 'export NVM_DIR="\$HOME/.nvm" && . "\$NVM_DIR/nvm.sh" && npm install -g @anthropic-ai/claude-code'
`

export function findSshPubKey(): string {
  const candidates = ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub']
  for (const name of candidates) {
    const p = join(homedir(), '.ssh', name)
    if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  }
  return ''
}

export function ensureSetupScript(): string {
  if (!existsSync(SETUP_SCRIPT)) {
    mkdirSync(SWARM_DIR, { recursive: true })
    writeFileSync(SETUP_SCRIPT, DEFAULT_SETUP)
    console.log(`Created default setup script: ${SETUP_SCRIPT}`)
    console.log('Edit it to customize what gets installed in new VMs.')
  }
  return readFileSync(SETUP_SCRIPT, 'utf8')
}

async function createIsoFromDir(tmpDir: string, isoPath: string): Promise<void> {
  const platform = process.platform

  if (platform === 'darwin') {
    await exec('hdiutil', [
      'makehybrid', '-iso', '-joliet',
      '-default-volume-name', 'cidata',
      '-o', isoPath,
      tmpDir,
    ])
    // hdiutil may add .cdr extension — rename if needed
    const cdrPath = isoPath + '.cdr'
    if (existsSync(cdrPath) && !existsSync(isoPath)) {
      const { renameSync } = await import('node:fs')
      renameSync(cdrPath, isoPath)
    }
  } else if (platform === 'linux') {
    // Try genisoimage first, fall back to mkisofs
    const useGeniso = await import('./exec.ts').then(m => m.execOk('which', ['genisoimage']))
    const cmd = useGeniso ? 'genisoimage' : 'mkisofs'
    await exec(cmd, [
      '-output', isoPath,
      '-volid', 'cidata',
      '-joliet', '-rock',
      tmpDir,
    ])
  } else if (platform === 'win32') {
    // Windows ADK's oscdimg
    await exec('oscdimg.exe', [
      '-j1',           // Joliet
      '-lcidata',      // Volume label
      tmpDir,
      isoPath,
    ])
  } else {
    throw new Error(`Unsupported platform for ISO creation: ${platform}`)
  }
}

export async function createCloudInitISO(dir: string, instanceId: string): Promise<void> {
  const tmpDir = join(dir, 'cidata-tmp')
  mkdirSync(tmpDir, { recursive: true })

  const sshKey = findSshPubKey()

  writeFileSync(
    join(tmpDir, 'meta-data'),
    `instance-id: ${instanceId}\nlocal-hostname: ${instanceId}\n`
  )

  let userData = `#cloud-config
password: admin
chpasswd:
  expire: false
ssh_pwauth: true
`
  if (sshKey) {
    userData += `ssh_authorized_keys:
  - ${sshKey}
`
  }
  // Read the user-customizable setup script from host
  const setupScript = ensureSetupScript()
  // Indent content for YAML block scalar
  const setupIndented = setupScript.split('\n').map(l => `      ${l}`).join('\n')

  userData += `write_files:
  - path: /usr/local/bin/code
    permissions: "0755"
    content: |
      #!/bin/bash
      path="\${1:-.}"
      [[ "\$path" != /* ]] && path="\$PWD/\$path"
      echo "\$path" | nc -q0 127.0.0.1 19418 2>/dev/null || echo "code forwarding not available (connect via agent-swarm ssh)"
  - path: /opt/agent-swarm/setup.sh
    permissions: "0755"
    content: |
${setupIndented}
runcmd:
  # Create worker user
  - useradd -m -s /bin/bash -G sudo,adm worker
  - "echo 'worker ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/worker"
  - chmod 440 /etc/sudoers.d/worker
  - mkdir -p /home/worker/.ssh
  - cp /home/ubuntu/.ssh/authorized_keys /home/worker/.ssh/authorized_keys
  - chown -R worker:worker /home/worker/.ssh
  - chmod 700 /home/worker/.ssh
  - chmod 600 /home/worker/.ssh/authorized_keys
  - "echo 'worker:worker' | chpasswd"
  # Run user-customizable setup script
  - /opt/agent-swarm/setup.sh
`
  writeFileSync(join(tmpDir, 'user-data'), userData)

  await createIsoFromDir(tmpDir, join(dir, 'cidata.iso'))

  // Clean up temp dir
  await exec('rm', ['-rf', tmpDir])
}
