// Ported from src/utils/filter.ts — only what isEventMatchingFilter needs.

export const isGenericTagQuery = (key: string): boolean => /^#[a-zA-Z]$/.test(key)

const geohashTagQuery = '#g'

export const isGeohashPrefixCriterion = (key: string, criterion: string): boolean =>
  key === geohashTagQuery && criterion.endsWith('*')

export const stripGeohashPrefixWildcard = (criterion: string): string => criterion.slice(0, -1)
