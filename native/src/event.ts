// Ported from src/utils/event.ts — the NIP-01 event-id/hash, schnorr signature
// check, and filter matcher. Only the functions the validator CLI needs; the
// repository-boundary helpers (toNostrEvent, broadcastEvent, signing) are
// intentionally left out — they pull in Buffer/Date row shapes, `cluster` and
// `process.send`, none of which scriptc can lower (see native/README.md).

import type { Event, SubscriptionFilter, Tag, UnidentifiedEvent } from './types'
import { isGenericTagQuery, isGeohashPrefixCriterion, stripGeohashPrefixWildcard } from './filter'
import { sha256 } from './sha256'
import { schnorrVerify } from './schnorr'

export const serializeEvent = (event: UnidentifiedEvent): (number | string | Tag[])[] => [
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
]

export const getEventHash = (event: UnidentifiedEvent): string => {
  const id = sha256(Buffer.from(JSON.stringify(serializeEvent(event))))

  return Buffer.from(id).toString('hex')
}

export const isEventIdValid = (event: Event): boolean => {
  return event.id === getEventHash(event)
}

// Signature verification uses the vendored pure-BigInt BIP-340 check —
// @noble/secp256k1 is deliberately not imported anywhere in this unit, so the
// binary is 100% static (no quickjs island). noble's async schnorr.verify
// fails island marshalling ("expected boolean, got object" — verified), and
// verifySync can't be fed a sha256Sync function across the boundary (SC1090).
export const isEventSignatureValid = (event: Event): boolean => {
  return schnorrVerify(event.sig, event.id, event.pubkey)
}

export const isEventMatchingFilter =
  (filter: SubscriptionFilter) =>
  (event: Event): boolean => {
    const startsWith = (input: string) => (prefix: string) => input.startsWith(prefix)
    const isMatchingGenericTagCriterion =
      (key: string, criterion: string) =>
      (tag: Tag): boolean => {
        const tagName = key[1]
        if (tag[0] !== tagName) {
          return false
        }

        if (isGeohashPrefixCriterion(key, criterion)) {
          return tag[1].startsWith(stripGeohashPrefixWildcard(criterion))
        }

        return tag[1] === criterion
      }

    // NIP-01: Basic protocol flow description

    if (Array.isArray(filter.ids) && !filter.ids.some(startsWith(event.id))) {
      return false
    }

    if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
      return false
    }

    if (typeof filter.since === 'number' && event.created_at < filter.since) {
      return false
    }

    if (typeof filter.until === 'number' && event.created_at > filter.until) {
      return false
    }

    if (Array.isArray(filter.authors)) {
      if (!filter.authors.some(startsWith(event.pubkey))) {
        return false
      }
    }

    // NIP-12: Support generic tag queries

    if (
      Object.entries(filter)
        .filter(([key, criteria]) => isGenericTagQuery(key) && Array.isArray(criteria))
        .some(([key, criteria]) => {
          return !event.tags.some((tag) =>
            (criteria as string[]).some((criterion) => isMatchingGenericTagCriterion(key, criterion)(tag)),
          )
        })
    ) {
      return false
    }

    // NIP-50
    if (typeof filter.search === 'string' && filter.search.length > 0) {
      const contentLower = event.content.toLowerCase()
      const terms = filter.search.toLowerCase().split(/\s+/).filter(Boolean)
      if (terms.length === 0 || !terms.every((term) => contentLower.includes(term))) {
        return false
      }
    }

    return true
  }
