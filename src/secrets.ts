import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as registry from './registry.ts'

// --- Interfaces ---

export interface KeyProvider {
  getOrCreateKey(): Promise<Buffer>
}

export interface SecretBackend {
  get(name: string, project?: string): Promise<string | undefined>
  set(name: string, value: string, project?: string): Promise<void>
  remove(name: string, project?: string): Promise<void>
  list(project?: string): Promise<Array<{ name: string; scope: string }>>

  /** Resolve env vars for a project: global merged with project overrides */
  resolve(project: string): Promise<Record<string, string>>
}

// --- MacKeychainKeyProvider ---

const KEYCHAIN_SERVICE = 'agent-swarm'
const KEYCHAIN_ACCOUNT = 'master-key'

export class MacKeychainKeyProvider implements KeyProvider {
  private cached: Buffer | null = null

  async getOrCreateKey(): Promise<Buffer> {
    if (this.cached) return this.cached

    // Try to retrieve existing key
    try {
      const hex = execFileSync('security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w',
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      this.cached = Buffer.from(hex, 'hex')
      return this.cached
    } catch {
      // Key doesn't exist yet — generate and store
    }

    const key = randomBytes(32)
    const hex = key.toString('hex')
    execFileSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', KEYCHAIN_ACCOUNT,
      '-w', hex,
      '-U', // update if exists (race condition guard)
    ], { stdio: 'ignore' })

    this.cached = key
    return this.cached
  }
}

// --- LibsecretKeyProvider (Linux) ---

const LIBSECRET_SERVICE = 'agent-swarm'
const LIBSECRET_ACCOUNT = 'master-key'

export class LibsecretKeyProvider implements KeyProvider {
  private cached: Buffer | null = null

  async getOrCreateKey(): Promise<Buffer> {
    if (this.cached) return this.cached

    // Try to retrieve existing key
    try {
      const hex = execFileSync('secret-tool', [
        'lookup', 'service', LIBSECRET_SERVICE, 'account', LIBSECRET_ACCOUNT,
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (hex) {
        this.cached = Buffer.from(hex, 'hex')
        return this.cached
      }
    } catch {
      // Key doesn't exist yet — generate and store
    }

    const key = randomBytes(32)
    const hex = key.toString('hex')
    // Pipe hex via stdin to avoid leaking the key in `ps` output
    spawnSync('secret-tool', [
      'store', '--label=agent-swarm',
      'service', LIBSECRET_SERVICE,
      'account', LIBSECRET_ACCOUNT,
    ], { input: hex, stdio: ['pipe', 'ignore', 'ignore'] })

    this.cached = key
    return this.cached
  }
}

// --- WindowsCredentialKeyProvider (Windows DPAPI) ---

export class WindowsCredentialKeyProvider implements KeyProvider {
  private cached: Buffer | null = null
  private keyFilePath: string

  constructor() {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    this.keyFilePath = join(appData, 'agent-swarm', 'master.key')
  }

  async getOrCreateKey(): Promise<Buffer> {
    if (this.cached) return this.cached

    if (existsSync(this.keyFilePath)) {
      // Read DPAPI-encrypted key file and decrypt
      try {
        const hex = execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `$encrypted = [IO.File]::ReadAllBytes('${this.keyFilePath}'); ` +
          `$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
          `[BitConverter]::ToString($decrypted).Replace('-', '')`,
        ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        this.cached = Buffer.from(hex, 'hex')
        return this.cached
      } catch {
        // Corrupted file — regenerate
      }
    }

    const key = randomBytes(32)
    const hex = key.toString('hex')

    // Encrypt with DPAPI and write to file
    const dir = join(this.keyFilePath, '..')
    mkdirSync(dir, { recursive: true })
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Security; ` +
      `$bytes = [byte[]]@(${Array.from(key).join(',')}); ` +
      `$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      `[IO.File]::WriteAllBytes('${this.keyFilePath}', $encrypted)`,
    ], { stdio: 'ignore' })

    this.cached = key
    return this.cached
  }
}

// --- Platform-aware KeyProvider factory ---

function createKeyProvider(): KeyProvider {
  switch (process.platform) {
    case 'darwin':
      return new MacKeychainKeyProvider()
    case 'linux':
      return new LibsecretKeyProvider()
    case 'win32':
      return new WindowsCredentialKeyProvider()
    default:
      throw new Error(`Unsupported platform for key storage: ${process.platform}`)
  }
}

// --- Encryption helpers ---

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: base64(iv + ciphertext + authTag)
  return Buffer.concat([iv, encrypted, authTag]).toString('base64')
}

function decrypt(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, 'base64')
  const iv = buf.subarray(0, 12)
  const authTag = buf.subarray(buf.length - 16)
  const ciphertext = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf-8')
}

// --- SqliteSecretBackend ---

export class SqliteSecretBackend implements SecretBackend {
  private keyProvider: KeyProvider

  constructor(keyProvider: KeyProvider) {
    this.keyProvider = keyProvider
  }

  async get(name: string, project?: string): Promise<string | undefined> {
    const scope = project ?? ''
    const row = registry.getEnvVar(name, scope)
    if (!row) return undefined
    const key = await this.keyProvider.getOrCreateKey()
    return decrypt(row, key)
  }

  async set(name: string, value: string, project?: string): Promise<void> {
    const scope = project ?? ''
    const key = await this.keyProvider.getOrCreateKey()
    const encrypted = encrypt(value, key)
    registry.setEnvVar(name, scope, encrypted)
  }

  async remove(name: string, project?: string): Promise<void> {
    const scope = project ?? ''
    registry.removeEnvVar(name, scope)
  }

  async list(project?: string): Promise<Array<{ name: string; scope: string }>> {
    const scope = project ?? undefined
    return registry.listEnvVars(scope)
  }

  async resolve(project: string): Promise<Record<string, string>> {
    const key = await this.keyProvider.getOrCreateKey()
    const env: Record<string, string> = {}

    // Load global vars first
    const globalVars = registry.listEnvVarsByScope('')
    for (const row of globalVars) {
      env[row.name] = decrypt(row.value, key)
    }

    // Override with project-specific vars
    if (project) {
      const projectVars = registry.listEnvVarsByScope(project)
      for (const row of projectVars) {
        env[row.name] = decrypt(row.value, key)
      }
    }

    return env
  }
}

// --- Factory ---

let backendInstance: SecretBackend | null = null

export function getSecretBackend(): SecretBackend {
  if (!backendInstance) {
    backendInstance = new SqliteSecretBackend(createKeyProvider())
  }
  return backendInstance
}
