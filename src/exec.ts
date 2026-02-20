import { execFile } from 'node:child_process'

/** Run a command and return stdout. Rejects on non-zero exit. */
export function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr.trim() || stdout.trim() || err.message
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${msg}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

/** Run a command, return true if it exits 0. */
export async function execOk(cmd: string, args: string[]): Promise<boolean> {
  try {
    await exec(cmd, args)
    return true
  } catch {
    return false
  }
}
