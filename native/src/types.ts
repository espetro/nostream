// Type surface for the scriptc-compiled unit.
//
// These are deliberately relaxed copies of src/@types: scriptc 0.2.5 cannot
// represent the upstream shapes (see native/README.md for the diagnostics):
//   - `Tag = TagBase & string[]`            -> SC2008 (intersection has no runtime shape)
//   - `[key: `#${string}`]` index signature -> SC2006 (outside supported index shape)
//   - numeric-property `CanonicalEvent`     -> SC2001 (type shape can't compile)
// The relaxations below are strictly weaker typings, never narrower.

export type EventId = string
export type Pubkey = string
export type Signature = string
export type TagName = string
export type Tag = string[]

export interface Event {
  id: EventId
  pubkey: Pubkey
  created_at: number
  kind: number
  tags: Tag[]
  sig: Signature
  content: string
}

export interface UnidentifiedEvent {
  pubkey: Pubkey
  created_at: number
  kind: number
  tags: Tag[]
  content: string
}

export interface SubscriptionFilter {
  ids?: EventId[]
  kinds?: number[]
  since?: number
  until?: number
  authors?: Pubkey[]
  limit?: number
  search?: string
  [key: string]: string[] | number[] | number | string | undefined
}
