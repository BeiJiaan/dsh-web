// @vitest-environment jsdom
// test-standards-allow: no-ad-hoc-mock - SDK primitives are contract fakes; actual UI, transport and state run below.
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const create = (React.createElement as (...args: unknown[]) => unknown).bind(React)
  const Button = (props: Record<string, unknown>) => create('button', {
    type: 'button',
    className: props['className'],
    disabled: props['disabled'],
    onClick: props['onClick'],
    'aria-label': props['aria-label'],
    'data-dsh-part': props['data-dsh-part'],
  }, props['icon'], props['children'])
  const Modal = (props: Record<string, unknown>) => {
    React.useEffect(() => {
      if (props['open'] !== true) return undefined
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') (props['onClose'] as () => void)()
      }
      document.addEventListener('keydown', onKey)
      return () => { document.removeEventListener('keydown', onKey) }
    }, [props['open'], props['onClose']])
    if (props['open'] !== true) return null
    return create('div', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props['title'],
      className: props['className'],
    }, props['children'])
  }
  const glyph = (name: string) => (props: Record<string, unknown>) =>
    create('span', { 'data-icon': name, 'aria-hidden': 'true', className: props['className'] })
  return {
    Button,
    Modal,
    IconCloseOutlineRegular: glyph('close'),
    IconCopyOutlineRegular: glyph('copy'),
    IconCheckOutlineRegular: glyph('check'),
    IconRefreshOutlineRegular: glyph('refresh'),
    IconWarningOutlineRegular: glyph('warning'),
  }
})

import { PairEntry } from '../src/client/PairEntry.tsx'
import { en, type RemoteBridgeKey } from '../src/client/locales.ts'
import type { PairTokenOutcome } from '../src/client/pair-token.ts'

const ORIGIN = 'https://pair.example.test'
const TOKEN = 'remote-one-shot'
const URL = 'wss://pair.example.test/ios/v1?token=' + TOKEN
const t: PropsLocale<'remote-bridge'>['t'] = (key, params) => {
  let text: string = en[key as RemoteBridgeKey] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}
function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body } }
function ticket() { return response({ token: TOKEN, expiresAt: Date.now() + 30_000, origin: ORIGIN, originSource: 'configured', pairingUrl: URL, url: 'legacy ignored' }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })) }) }
const tab = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('tab', { name })) }) }
const qr = () => document.querySelector('[data-dsh-part="qr"]')?.getAttribute('data-dsh-qr-value')
async function open() {
  const read = vi.fn(async (): Promise<PairTokenOutcome> => ({ kind: 'forbidden' }))
  const copy = vi.fn(async () => true)
  render(<PairEntry wide read={read} copy={copy} t={t} />)
  await click(en['entry.label'])
  await tab(en['mode.remote'])
  return { read, copy }
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('owner remote pairing', () => {
  it('opens metadata only, then explicitly posts the approved origin and encodes the App JSON contract', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ enabled: true, trustedOrigins: [ORIGIN] })).mockImplementation(() => Promise.resolve(ticket()))
    vi.stubGlobal('fetch', fetch)
    const { read, copy } = await open()
    expect(read).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('remote-bridge/pair/remote-info')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    expect(screen.getByLabelText(en['remote.addressLabel']).getAttribute('value')).toBe(ORIGIN)
    expect(qr()).toBeUndefined()
    expect(screen.getByText(en['remote.ready'])).toBeTruthy()
    await click(en['remote.generate'])
    expect(fetch.mock.calls[1]).toEqual(['remote-bridge/pair/remote-token', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN }) })])
    expect(qr()).toBe(JSON.stringify({ token: TOKEN, url: URL }))
    expect(document.body.textContent).not.toContain(TOKEN)
    await click(en['action.copy'])
    expect(copy).toHaveBeenCalledWith(JSON.stringify({ token: TOKEN, url: URL }))
  })

  it('rejects unapproved input without issuing or claiming address trust, and clears the previous code', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ enabled: true, trustedOrigins: [ORIGIN] })).mockImplementation(() => Promise.resolve(ticket()))
    vi.stubGlobal('fetch', fetch)
    await open()
    await click(en['remote.generate'])
    fireEvent.change(screen.getByLabelText(en['remote.addressLabel']), { target: { value: 'https://not-approved.test' } })
    expect(screen.getByRole('button', { name: en['remote.generate'] }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en['remote.unknownOrigin'])).toBeTruthy()
    expect(screen.queryByText('Server-approved address:', { exact: false })).toBeNull()
    expect(qr()).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('expires after thirty seconds and never refreshes automatically', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(response({ enabled: true, trustedOrigins: [ORIGIN] })).mockImplementation(() => Promise.resolve(ticket()))
    vi.stubGlobal('fetch', fetch)
    await open()
    await click(en['remote.generate'])
    await act(async () => { vi.advanceTimersByTime(31_000) })
    expect(screen.getByText(en['pair.expired'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['action.copy'] }).hasAttribute('disabled')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['tab', 'input', 'close'] as const)('ignores an in-flight ticket after %s and does not restore it', async (change) => {
    const pending = deferred<ReturnType<typeof response>>()
    const fetch = vi.fn().mockResolvedValueOnce(response({ enabled: true, trustedOrigins: [ORIGIN] })).mockReturnValueOnce(pending.promise).mockResolvedValue(response({ enabled: true, trustedOrigins: [ORIGIN] }))
    vi.stubGlobal('fetch', fetch)
    await open()
    await click(en['remote.generate'])
    const signal = fetch.mock.calls[1]?.[1].signal as AbortSignal
    if (change === 'tab') await tab(en['mode.local'])
    if (change === 'input') fireEvent.change(screen.getByLabelText(en['remote.addressLabel']), { target: { value: ORIGIN + '/' } })
    if (change === 'close') await click(en['action.close'])
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(ticket()) })
    expect(qr() ?? '').not.toContain(TOKEN)
    if (change === 'tab') await tab(en['mode.remote'])
    if (change === 'close') { await click(en['entry.label']); await tab(en['mode.remote']) }
    expect(qr() ?? '').not.toContain(TOKEN)
  })

  it('keeps local mode behavior and ignores a local result after switching remote', async () => {
    const pending = deferred<PairTokenOutcome>()
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ kind: 'ok', token: 'local-fresh', expiresAt: Date.now() + 30_000, origin: null, originSource: null, pairingUrl: null })
    const fetch = vi.fn().mockResolvedValue(response({ enabled: true, trustedOrigins: [ORIGIN] }))
    vi.stubGlobal('fetch', fetch)
    render(<PairEntry wide read={read} copy={async () => true} t={t} />)
    await click(en['entry.label'])
    expect(fetch).not.toHaveBeenCalled()
    await tab(en['mode.remote'])
    await act(async () => { pending.resolve({ kind: 'ok', token: 'local-stale', expiresAt: Date.now() + 30_000, origin: null, originSource: null, pairingUrl: null }) })
    expect(qr()).toBeUndefined()
    await tab(en['mode.local'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(qr()).toBe('local-fresh')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('ignores stale metadata after changing tabs', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(response({ enabled: true, trustedOrigins: [ORIGIN] }))
    vi.stubGlobal('fetch', fetch)
    await open()
    expect(screen.queryByText(en['remote.ownerVerified'])).toBeNull()
    await tab(en['mode.local'])
    await act(async () => { pending.resolve(response({ enabled: true, trustedOrigins: ['https://stale.test'] })) })
    await tab(en['mode.remote'])
    expect(screen.getByLabelText(en['remote.addressLabel']).getAttribute('value')).toBe(ORIGIN)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    [401, { error: 'forbidden' }, 'remote.unauthorized'],
    [403, { error: 'forbidden' }, 'remote.forbidden'],
    [403, { enabled: false, trustedOrigins: [] }, 'remote.disabled'],
    [200, { enabled: true, trustedOrigins: ['http://unsafe.test'] }, 'remote.failed'],
  ] as const)('presents actionable metadata gate errors (%s)', async (status, body, key) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body, status)))
    await open()
    expect(screen.getByRole('alert').textContent).toBe(en[key])
    expect(screen.queryByText(en['remote.ownerVerified'])).toBeNull()
    expect(qr()).toBeUndefined()
  })
})
