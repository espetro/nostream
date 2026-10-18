// Relay session logic: NIP-01 EVENT/REQ/CLOSE handling on top of the
// vendored @chttp/ws WsHandler seam, plus in-process fanout to matching
// subscriptions (the Redis broadcast replacement — single process only,
// see README "Excluded").

import type { Event, SubscriptionFilter } from '../../src/types'
import {
  isEventIdValid,
  isEventMatchingFilter,
  isEventSignatureValid,
} from '../../src/event'
import {
  closedFrame,
  eoseFrame,
  eventFrame,
  noticeFrame,
  okFrame,
  toEvent,
  toFilter,
} from './proto'
import { isEphemeralKind, SqliteEventStore } from './store'
import type { WsConn } from '../.vendor/ws/index.ts'
import { WsHandler } from '../.vendor/ws/index.ts'

class Sub {
  id: string
  filters: SubscriptionFilter[]

  constructor(id: string, filters: SubscriptionFilter[]) {
    this.id = id
    this.filters = filters
  }
}

export class ConnState {
  conn: WsConn
  subs: Sub[]

  constructor(conn: WsConn) {
    this.conn = conn
    this.subs = []
  }
}

export interface RelayLimits {
  maxSubsPerConn: number
  maxFiltersPerReq: number
  defaultLimit: number
  maxLimit: number
  maxEventContentBytes: number
}

class VerifyItem {
  conn: WsConn
  event: Event

  constructor(conn: WsConn, event: Event) {
    this.conn = conn
    this.event = event
  }
}

// Sig verification costs ~2ms/event inline — ~94% of measured ingest time
// (9k ev/s unverified ceiling vs ~540 ev/s verified). Modes:
//   'sync'       — verify before OK/store (upstream semantics)
//   'optimistic' — store verified=0 + OK immediately; a bounded queue drains
//                  after each frame; REQ only serves verified=1 rows; failures
//                  tombstone the event and quarantine its pubkey.
//   'sample'     — like optimistic but only RELAY_VERIFY_RATE fraction of
//                  events queue for verification; unsampled are stored
//                  verified=1 directly (documented honesty tradeoff).
export class RelayHandler extends WsHandler {
  _store: SqliteEventStore
  _limits: RelayLimits
  _conns: ConnState[] = []
  _skipSigVerify: boolean
  _verifyMode: string
  _verifyRate: number
  _verifyQueue: VerifyItem[] = []
  _badPubkeys: string[] = []

  constructor(
    store: SqliteEventStore,
    limits: RelayLimits,
    skipSigVerify: boolean,
    verifyMode: string,
    verifyRate: number,
  ) {
    super()
    this._store = store
    this._limits = limits
    this._skipSigVerify = skipSigVerify
    this._verifyMode = verifyMode
    this._verifyRate = verifyRate
  }

  _stateOf(c: WsConn): ConnState | null {
    for (let i = 0; i < this._conns.length; i++) {
      if (this._conns[i].conn === c) {
        return this._conns[i]
      }
    }
    return null
  }

  open(c: WsConn): void {
    this._conns.push(new ConnState(c))
  }

  close(c: WsConn, _code: number, _reason: string): void {
    for (let i = 0; i < this._conns.length; i++) {
      if (this._conns[i].conn === c) {
        this._conns.splice(i, 1)
        return
      }
    }
  }

  _removeSub(state: ConnState, subId: string): boolean {
    for (let i = 0; i < state.subs.length; i++) {
      if (state.subs[i].id === subId) {
        state.subs.splice(i, 1)
        return true
      }
    }
    return false
  }

  message(c: WsConn, data: string): void {
    // Opportunistic drain: every inbound frame advances the deferred-verify
    // queue a little, so optimistic mode keeps pace under load and catches
    // up in the gaps between messages.
    this._drainVerify(4)
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (_e) {
      c.send(noticeFrame('invalid: could not parse message'))
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      c.send(noticeFrame('invalid: message must be a JSON array'))
      return
    }
    const msg = parsed as unknown[]
    if (typeof msg.length !== 'number' || msg.length < 2 || typeof msg[0] !== 'string') {
      c.send(noticeFrame('invalid: message must be a JSON array [type, ...]'))
      return
    }
    const kind = msg[0] as string
    try {
      if (kind === 'EVENT') {
        this._onEvent(c, msg)
        return
      }
      if (kind === 'REQ') {
        this._onReq(c, msg)
        return
      }
      if (kind === 'CLOSE') {
        this._onClose(c, msg)
        return
      }
    } catch (e) {
      const err = e as Error
      // Upstream treats internal handler faults as connection-fatal; we
      // surface them as NOTICE so the socket stays diagnosable.
      c.send(noticeFrame('error: internal ' + err.message))
      return
    }
    c.send(noticeFrame('unsupported: unknown message type ' + kind))
  }

  _onEvent(c: WsConn, msg: unknown[]): void {
    let event: Event | null = null
    try {
      event = toEvent(msg[1])
    } catch (e) {
      const err = e as Error
      let id = ''
      if (
        typeof msg[1] === 'object' &&
        msg[1] !== null &&
        typeof (msg[1] as { [k: string]: unknown }).id === 'string'
      ) {
        id = (msg[1] as { [k: string]: unknown }).id as string
      }
      c.send(okFrame(id, false, 'invalid: ' + err.message))
      return
    }
    const ev = event as Event
    if (ev.content.length > this._limits.maxEventContentBytes) {
      c.send(okFrame(ev.id, false, 'invalid: content too large'))
      return
    }
    if (!isEventIdValid(ev)) {
      c.send(okFrame(ev.id, false, 'invalid: id does not match event hash'))
      return
    }
    // Ephemeral events are never stored, so there's nothing to gate — they
    // always verify synchronously (they're rare by construction).
    if (isEphemeralKind(ev.kind)) {
      if (!this._skipSigVerify && !isEventSignatureValid(ev)) {
        c.send(okFrame(ev.id, false, 'invalid: signature verification failed'))
        return
      }
      this._fanout(ev)
      c.send(okFrame(ev.id, true, ''))
      return
    }
    // Quarantined pubkeys always verify synchronously — a bad actor can't
    // dodge re-checks by spamming while optimistic.
    const syncRequired = this._isBadPubkey(ev.pubkey)
    let verified = 1
    if (this._verifyMode === 'sync' || syncRequired) {
      if (!this._skipSigVerify && !isEventSignatureValid(ev)) {
        if (this._verifyMode !== 'sync') {
          this._quarantine(ev.pubkey)
        }
        c.send(okFrame(ev.id, false, 'invalid: signature verification failed'))
        return
      }
    } else if (this._verifyMode === 'sample' && Math.random() >= this._verifyRate) {
      // Unsampled: stored verified directly. Honesty note in README —
      // unsampled invalid sigs can enter the servable set.
      verified = 1
    } else {
      verified = 0
    }
    const res = this._store.saveEvent(ev, verified)
    if (res.duplicate) {
      c.send(okFrame(ev.id, true, 'duplicate:'))
      return
    }
    if (res.stale) {
      c.send(okFrame(ev.id, true, 'stale:'))
      return
    }
    if (verified === 0) {
      // Backpressure: if the queue is full, degrade to sync verification
      // inline rather than growing memory unboundedly.
      if (this._verifyQueue.length >= 4096) {
        if (!isEventSignatureValid(ev)) {
          this._store.setVerified(ev.id, -1)
          this._quarantine(ev.pubkey)
          c.send(okFrame(ev.id, false, 'invalid: signature verification failed'))
          return
        }
        this._store.setVerified(ev.id, 1)
        this._fanout(ev)
        c.send(okFrame(ev.id, true, ''))
        return
      }
      this._verifyQueue.push(new VerifyItem(c, ev))
      c.send(okFrame(ev.id, true, 'optimistic: pending signature verification'))
      return
    }
    this._fanout(ev)
    c.send(okFrame(ev.id, true, ''))
  }

  _isBadPubkey(pubkey: string): boolean {
    for (let i = 0; i < this._badPubkeys.length; i++) {
      if (this._badPubkeys[i] === pubkey) {
        return true
      }
    }
    return false
  }

  _quarantine(pubkey: string): void {
    if (!this._isBadPubkey(pubkey)) {
      this._badPubkeys.push(pubkey)
      this._store.quarantinePubkey(pubkey)
    }
  }

  _drainVerify(budget: number): void {
    let n = 0
    while (n < budget && this._verifyQueue.length > 0) {
      const item = this._verifyQueue.shift() as VerifyItem
      n++
      if (isEventSignatureValid(item.event)) {
        this._store.setVerified(item.event.id, 1)
        if (item.conn.isOpen()) {
          this._fanout(item.event)
        }
      } else {
        this._store.setVerified(item.event.id, -1)
        this._quarantine(item.event.pubkey)
        if (item.conn.isOpen()) {
          item.conn.send(
            noticeFrame(
              'warning: event ' + item.event.id + ' failed signature verification and was retracted',
            ),
          )
        }
      }
    }
  }

  _onReq(c: WsConn, msg: unknown[]): void {
    const state = this._stateOf(c)
    if (state === null) {
      return
    }
    if (typeof msg[1] !== 'string' || msg[1].length === 0 || msg[1].length > 64) {
      c.send(closedFrame('', 'invalid: subscription id must be 1-64 chars'))
      return
    }
    const subId = msg[1] as string
    const nFilters = msg.length - 2
    if (nFilters < 1) {
      c.send(closedFrame(subId, 'invalid: REQ needs at least one filter'))
      return
    }
    if (nFilters > this._limits.maxFiltersPerReq) {
      c.send(closedFrame(subId, 'invalid: too many filters in REQ'))
      return
    }
    const filters: SubscriptionFilter[] = []
    try {
      for (let i = 2; i < msg.length; i++) {
        filters.push(toFilter(msg[i]))
      }
    } catch (e) {
      const err = e as Error
      c.send(closedFrame(subId, 'invalid: ' + err.message))
      return
    }
    this._removeSub(state, subId)
    if (state.subs.length >= this._limits.maxSubsPerConn) {
      c.send(closedFrame(subId, 'error: max subscriptions reached'))
      return
    }
    state.subs.push(new Sub(subId, filters))
    const events = this._store.query(filters, this._limits.defaultLimit)
    for (let i = events.length - 1; i >= 0; i--) {
      // Stored order is DESC by created_at; relay events oldest-first like
      // upstream so subscribers see chronological replay.
      c.send(eventFrame(subId, events[i]))
    }
    c.send(eoseFrame(subId))
  }

  _onClose(c: WsConn, msg: unknown[]): void {
    const state = this._stateOf(c)
    if (state === null) {
      return
    }
    if (typeof msg[1] !== 'string') {
      return
    }
    this._removeSub(state, msg[1] as string)
  }

  stats(): { connections: number; subscriptions: number } {
    let subs = 0
    for (let i = 0; i < this._conns.length; i++) {
      subs += this._conns[i].subs.length
    }
    return { connections: this._conns.length, subscriptions: subs }
  }

  _fanout(event: Event): void {
    for (let i = 0; i < this._conns.length; i++) {
      const state = this._conns[i]
      if (!state.conn.isOpen()) {
        continue
      }
      for (let j = 0; j < state.subs.length; j++) {
        const sub = state.subs[j]
        for (let k = 0; k < sub.filters.length; k++) {
          if (isEventMatchingFilter(sub.filters[k])(event)) {
            state.conn.send(eventFrame(sub.id, event))
            break
          }
        }
      }
    }
  }
}
