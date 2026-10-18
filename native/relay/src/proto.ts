// NIP-01 wire helpers: inbound message normalization (hand-validated — no
// zod) and outbound frame building. Shares the protocol core with the
// validator CLI via ../../src (event.ts, types.ts).

import type { Event, SubscriptionFilter, Tag } from '../../src/types'

const isHex = (s: string, len: number): boolean => {
  if (s.length !== len) {
    return false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const hex =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
    if (!hex) {
      return false
    }
  }
  return true
}

export const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export const bytesToHex = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, '0')
  }
  return s
}

const isStringArray = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) {
    return false
  }
  const arr = v as unknown[]
  if (typeof arr.length !== 'number') {
    return false
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string') {
      return false
    }
  }
  return true
}

// Throws on malformed input — caller converts to a NOTICE/error reply.
export const toEvent = (input: unknown): Event => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('event must be a JSON object')
  }
  const e = input as { [key: string]: unknown }
  if (typeof e.id !== 'string' || !isHex(e.id, 64)) {
    throw new Error('event.id must be 64 hex chars')
  }
  if (typeof e.pubkey !== 'string' || !isHex(e.pubkey, 64)) {
    throw new Error('event.pubkey must be 64 hex chars')
  }
  if (typeof e.sig !== 'string' || !isHex(e.sig, 128)) {
    throw new Error('event.sig must be 128 hex chars')
  }
  if (typeof e.created_at !== 'number' || !Number.isSafeInteger(e.created_at)) {
    throw new Error('event.created_at must be an integer')
  }
  if (typeof e.kind !== 'number' || !Number.isSafeInteger(e.kind)) {
    throw new Error('event.kind must be an integer')
  }
  if (typeof e.content !== 'string') {
    throw new Error('event.content must be a string')
  }
  const tags = e.tags as unknown[]
  if (typeof tags !== 'object' || tags === null || typeof tags.length !== 'number') {
    throw new Error('event.tags must be an array of string arrays')
  }
  for (let i = 0; i < tags.length; i++) {
    if (!isStringArray(tags[i])) {
      throw new Error('event.tags must be an array of string arrays')
    }
  }
  return {
    id: e.id as string,
    pubkey: e.pubkey as string,
    sig: e.sig as string,
    created_at: e.created_at as number,
    kind: e.kind as number,
    content: e.content as string,
    tags: e.tags as Tag[],
  }
}

// One REQ filter record → SubscriptionFilter. Unknown keys are tolerated;
// single-char keys become #tag criteria (the upstream index-signature shape
// can't be represented, so they're carried in `tags` as [name, criteria]).
export const toFilter = (input: unknown): SubscriptionFilter => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('filter must be a JSON object')
  }
  const f = input as { [key: string]: unknown }
  const rec: { [key: string]: unknown } = {}
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(f, k)

  if (has('ids')) {
    if (!isStringArray(f.ids)) {
      throw new Error('filter.ids must be a string array')
    }
    rec.ids = f.ids as string[]
  }
  if (has('authors')) {
    if (!isStringArray(f.authors)) {
      throw new Error('filter.authors must be a string array')
    }
    rec.authors = f.authors as string[]
  }
  if (has('kinds')) {
    const ks = f.kinds as unknown[]
    if (typeof ks !== 'object' || ks === null || typeof ks.length !== 'number') {
      throw new Error('filter.kinds must be a number array')
    }
    const nums: number[] = []
    for (let i = 0; i < ks.length; i++) {
      if (typeof ks[i] !== 'number') {
        throw new Error('filter.kinds must be a number array')
      }
      nums.push(ks[i] as number)
    }
    rec.kinds = nums
  }
  if (has('since')) {
    if (typeof f.since !== 'number') {
      throw new Error('filter.since must be a number')
    }
    rec.since = f.since as number
  }
  if (has('until')) {
    if (typeof f.until !== 'number') {
      throw new Error('filter.until must be a number')
    }
    rec.until = f.until as number
  }
  if (has('limit')) {
    if (typeof f.limit !== 'number') {
      throw new Error('filter.limit must be a number')
    }
    rec.limit = f.limit as number
  }
  for (const key of Object.keys(f)) {
    if (key.length === 2 && key.charAt(0) === '#') {
      const vals = f[key]
      if (!isStringArray(vals)) {
        throw new Error('filter.' + key + ' must be a string array')
      }
      rec[key] = vals as string[]
    }
  }
  // scriptc records throw on missing-key reads, and both the upstream
  // filter matcher and the query builder read every optional field —
  // normalize absent optionals to inert sentinels (empty arrays, 0 since,
  // max until/limit) instead of leaving keys absent.
  if (!has('ids')) {
    rec.ids = [] as string[]
  }
  if (!has('authors')) {
    rec.authors = [] as string[]
  }
  if (!has('kinds')) {
    rec.kinds = [] as number[]
  }
  if (!has('since')) {
    rec.since = 0
  }
  if (!has('until')) {
    rec.until = Number.MAX_SAFE_INTEGER
  }
  if (!has('limit')) {
    rec.limit = Number.MAX_SAFE_INTEGER
  }
  // Single-char keys (#t, #e, ...) ride the index signature of
  // SubscriptionFilter; the record round-trips through JSON so the typed
  // write stays shape-safe under scriptc.
  return JSON.parse(JSON.stringify(rec)) as SubscriptionFilter
}

// Frame builders — JSON.stringify of plain arrays/records.
export const okFrame = (id: string, accepted: boolean, message: string): string =>
  JSON.stringify(['OK', id, accepted, message])

export const eoseFrame = (subId: string): string => JSON.stringify(['EOSE', subId])

export const eventFrame = (subId: string, event: Event): string =>
  JSON.stringify(['EVENT', subId, event])

export const closedFrame = (subId: string, message: string): string =>
  JSON.stringify(['CLOSED', subId, message])

export const noticeFrame = (message: string): string => JSON.stringify(['NOTICE', message])
