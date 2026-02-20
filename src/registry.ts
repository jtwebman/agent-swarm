import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type ProjectRow = {
  name: string
  provider: string
  vm_id: string
  base_image: string
  ip: string | null
  status: string
  created_at: string
}

export type EnvironmentRow = {
  ticket: string
  project: string
  provider: string
  vm_id: string
  base_image: string
  ip: string | null
  status: string
  created_at: string
}

const DB_DIR = join(homedir(), '.agent-swarm')
const DB_PATH = join(DB_DIR, 'registry.db')

let db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(DB_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      name        TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      vm_id       TEXT NOT NULL,
      base_image  TEXT NOT NULL,
      ip          TEXT,
      status      TEXT DEFAULT 'running',
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS environment (
      ticket      TEXT PRIMARY KEY,
      project     TEXT NOT NULL DEFAULT '' REFERENCES project(name),
      provider    TEXT NOT NULL,
      vm_id       TEXT NOT NULL,
      base_image  TEXT NOT NULL,
      ip          TEXT,
      status      TEXT DEFAULT 'running',
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_var (
      name    TEXT NOT NULL,
      scope   TEXT NOT NULL DEFAULT '',
      value   TEXT NOT NULL,
      PRIMARY KEY (name, scope)
    )
  `)
  // Migrate: add project column if missing from existing DB
  const cols = db.prepare("PRAGMA table_info(environment)").all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'project')) {
    db.exec("ALTER TABLE environment ADD COLUMN project TEXT NOT NULL DEFAULT '' REFERENCES project(name)")
  }
  return db
}

// --- Project CRUD ---

export function registerProject(row: Omit<ProjectRow, 'created_at'>): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO project (name, provider, vm_id, base_image, ip, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.name, row.provider, row.vm_id, row.base_image, row.ip, row.status)
}

export function getProject(name: string): ProjectRow | undefined {
  const d = getDb()
  return d.prepare('SELECT * FROM project WHERE name = ?').get(name) as ProjectRow | undefined
}

export function listProjects(): ProjectRow[] {
  const d = getDb()
  return d.prepare('SELECT * FROM project ORDER BY created_at DESC').all() as ProjectRow[]
}

export function updateProjectStatus(name: string, status: string): void {
  const d = getDb()
  d.prepare('UPDATE project SET status = ? WHERE name = ?').run(status, name)
}

export function updateProjectIp(name: string, ip: string): void {
  const d = getDb()
  d.prepare('UPDATE project SET ip = ? WHERE name = ?').run(ip, name)
}

export function removeProject(name: string): void {
  const d = getDb()
  d.prepare('DELETE FROM project WHERE name = ?').run(name)
}

// --- Environment (ticket) CRUD ---

export function register(row: Omit<EnvironmentRow, 'created_at'>): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO environment (ticket, project, provider, vm_id, base_image, ip, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.ticket, row.project, row.provider, row.vm_id, row.base_image, row.ip, row.status)
}

export function get(ticket: string): EnvironmentRow | undefined {
  const d = getDb()
  return d.prepare('SELECT * FROM environment WHERE ticket = ?').get(ticket) as EnvironmentRow | undefined
}

export function list(): EnvironmentRow[] {
  const d = getDb()
  return d.prepare('SELECT * FROM environment ORDER BY created_at DESC').all() as EnvironmentRow[]
}

export function updateStatus(ticket: string, status: string): void {
  const d = getDb()
  d.prepare('UPDATE environment SET status = ? WHERE ticket = ?').run(status, ticket)
}

export function updateIp(ticket: string, ip: string): void {
  const d = getDb()
  d.prepare('UPDATE environment SET ip = ? WHERE ticket = ?').run(ip, ticket)
}

export function remove(ticket: string): void {
  const d = getDb()
  d.prepare('DELETE FROM environment WHERE ticket = ?').run(ticket)
}

// --- Env var CRUD ---

export function setEnvVar(name: string, scope: string, encryptedValue: string): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO env_var (name, scope, value) VALUES (?, ?, ?)
    ON CONFLICT(name, scope) DO UPDATE SET value = excluded.value
  `).run(name, scope, encryptedValue)
}

export function getEnvVar(name: string, scope: string): string | undefined {
  const d = getDb()
  const row = d.prepare('SELECT value FROM env_var WHERE name = ? AND scope = ?').get(name, scope) as { value: string } | undefined
  return row?.value
}

export function removeEnvVar(name: string, scope: string): void {
  const d = getDb()
  d.prepare('DELETE FROM env_var WHERE name = ? AND scope = ?').run(name, scope)
}

export function listEnvVars(scope?: string): Array<{ name: string; scope: string }> {
  const d = getDb()
  if (scope !== undefined) {
    return d.prepare('SELECT name, scope FROM env_var WHERE scope = ? ORDER BY name').all(scope) as Array<{ name: string; scope: string }>
  }
  return d.prepare('SELECT name, scope FROM env_var ORDER BY scope, name').all() as Array<{ name: string; scope: string }>
}

export function listEnvVarsByScope(scope: string): Array<{ name: string; value: string }> {
  const d = getDb()
  return d.prepare('SELECT name, value FROM env_var WHERE scope = ? ORDER BY name').all(scope) as Array<{ name: string; value: string }>
}
