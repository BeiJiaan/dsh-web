import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ writeClipboard: vi.fn() }))
vi.mock('../src/client/PairEntry.tsx', () => ({ PairEntry: vi.fn() }))
vi.mock('../src/client/toolview-slot.ts', () => ({ registerPresentToolview: vi.fn() }))
import { apply } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

describe('aggregate-compatible pairing dictionaries', () => {
  it('uses its own dictionary namespace even if the aggregate already registered the upstream bridge copy', () => {
    const dictionaries = new Map<string, unknown>([['remote-bridge', { zh: { 'entry.label': 'upstream' } }]])
    const registrations: { name: string; locale: string; id: string }[] = []
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      locale: { register: (namespace: string, value: unknown) => {
        if (dictionaries.has(namespace)) throw new Error('Already registered')
        dictionaries.set(namespace, value)
        return () => dictionaries.delete(namespace)
      } },
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (registration: { name: string; locale: string; id: string }) => { registrations.push(registration); return () => {} },
      },
    }
    apply(ctx as unknown as Context)
    expect(registrations).toEqual([expect.objectContaining({ name: 'sidebar.footer.action', id: 'remote-bridge', locale: 'remote-bridge-pairing' })])
    expect(dictionaries.get('remote-bridge-pairing')).toMatchObject({ zh: { 'entry.label': zh['entry.label'], 'mode.remote': zh['mode.remote'] } })
    expect(dictionaries.get('remote-bridge')).toEqual({ zh: { 'entry.label': 'upstream' } })
  })
})
