import type { Provider } from '../provider.ts'
import { createMacNativeProvider } from './macos-native.ts'
import { createKvmProvider } from './kvm.ts'
import { createHypervProvider } from './hyperv.ts'

type ProviderFactory = () => Provider

const providers: ProviderFactory[] = [
  createMacNativeProvider,
  createKvmProvider,
  createHypervProvider,
]

/** Detect the first available provider on this machine. */
export async function detectProvider(): Promise<Provider | null> {
  for (const factory of providers) {
    const provider = factory()
    if (await provider.available()) return provider
  }
  return null
}

/** Get a provider by name. */
export function getProvider(name: string): Provider | null {
  const map: Record<string, ProviderFactory> = {
    'macos-native': createMacNativeProvider,
    'kvm': createKvmProvider,
    'hyperv': createHypervProvider,
  }
  const factory = map[name]
  return factory ? factory() : null
}

/** List all known providers and their availability. */
export async function listProviders(): Promise<Array<{ name: string; available: boolean }>> {
  const results: Array<{ name: string; available: boolean }> = []
  for (const factory of providers) {
    const p = factory()
    results.push({ name: p.name, available: await p.available() })
  }
  return results
}
