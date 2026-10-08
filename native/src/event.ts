// Ported from src/utils/event.ts — the NIP-01 event-id/hash, schnorr signature
// check, and filter matcher. Only the functions the validator CLI needs; the
// repository-boundary helpers (toNostrEvent, broadcastEvent, signing) are
// intentionally left out — they pull in Buffer/Date row shapes, `cluster` and
// `process.send`, none of which scriptc can lower (see native/README.md).

import * as secp256k1 from '@noble/secp256k1'
import type { Event, SubscriptionFilter, Tag, UnidentifiedEvent } from './types'
import { isGenericTagQuery, isGeohashPrefixCriterion, stripGeohashPrefixWildcard } from './filter'
import { schnorrVerify } from './schnorr'

export const serializeEvent = (event: UnidentifiedEvent): (number | string | Tag[])[] => [
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
]

export const getEventHash = async (event: UnidentifiedEvent): Promise<string> => {
  const id = await secp256k1.utils.sha256(Buffer.from(JSON.stringify(serializeEvent(event))))

  return Buffer.from(id).toString('hex')
}

export const isEventIdValid = async (event: Event): Promise<boolean> => {
  return event.id === (await getEventHash(event))
}

// @noble/secp256k1@1.7.1's schnorr.verify is async and its Promise fails the
// scriptc island marshalling ("expected boolean, got object" — verified), and
// verifySync can't be fed a sha256Sync function across the boundary (SC1090).
// So signature verification uses the vendored pure-BigInt BIP-340 check.
export const isEventSignatureValid = async (event: Event): Promise<boolean> => {
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
