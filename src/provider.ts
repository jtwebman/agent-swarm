export type VmStatus = 'running' | 'stopped' | 'creating' | 'unknown'

export type VmInfo = {
  vmId: string
  ticket: string
  ip: string | null
  status: VmStatus
}

export type SshInfo = {
  host: string
  port: number
  user: string
}

export type Provider = {
  name: string
  available: () => Promise<boolean>
  createVm: (ticket: string, baseImage: string) => Promise<VmInfo>
  startVm: (vmId: string) => Promise<void>
  stopVm: (vmId: string) => Promise<void>
  deleteVm: (vmId: string) => Promise<void>
  sshInfo: (vmId: string) => Promise<SshInfo>
  checkpoint: (vmId: string, name: string) => Promise<void>
  restore: (vmId: string, name: string) => Promise<void>
  listCheckpoints: (vmId: string) => Promise<string[]>
  status: (vmId: string) => Promise<VmStatus>
  listVms: () => Promise<VmInfo[]>
}
