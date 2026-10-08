// nostream-validate — NIP-01 event validator / filter matcher.
//
// Reads a nostr event (JSON) and reports whether its `id` is the correct
// SHA-256 of the canonical serialization, whether `sig` is a valid BIP-340
// schnorr signature, and whether the event matches zero or more NIP-01
// subscription filters. See native/README.md for the scriptc caveats.

import { readFileSync } from 'node:fs'
import type { Event, SubscriptionFilter } from './types'
import { isEventIdValid, isEventMatchingFilter, isEventSignatureValid } from './event'

const USAGE = `nostream-validate — NIP-01 event validator / filter matcher

Usage:
  nostream-validate <event.json|-> [options]

Arguments:
  <event.json|->        Path to an event JSON file, or '-' to read stdin.

Options:
  --filter <f.json|->   A NIP-01 subscription filter as inline JSON, or a path
                        to a filter JSON file, or '-' to read stdin. Repeatable.
  --skip-sig            Skip BIP-340 schnorr signature verification (report
                        signature as "skipped" instead of true/false).
  --help                Show this help.

Output: a single JSON object on stdout, e.g.
  {"id_valid":true,"sig_valid":true,"filters":[{"index":0,"match":true}],"valid":true}

Exit codes:
  0  every requested check passed
  1  a check failed (bad id, bad signature, or a filter did not match)
  2  usage or input error
`

interface FilterResult {
  index: number
  match: boolean
}

interface ValidationReport {
  id_valid: boolean | null
  sig_valid: boolean | 'skipped' | null
  filters: FilterResult[]
  valid: boolean
  error?: string
}

const isHex = (s: string, len: number): boolean => s.length === len && /^[0-9a-f]+$/i.test(s)

const readJsonSource = (source: string, stdinUsed: { value: boolean }): unknown => {
  let text: string
  if (source === '-') {
    if (stdinUsed.value) {
      throw new Error("stdin ('-') can only be consumed once")
    }
    stdinUsed.value = true
    text = readFileSync(0, 'utf8')
  } else if (source.startsWith('{') || source.startsWith('[')) {
    text = source
  } else {
    text = readFileSync(source, 'utf8')
  }
  return JSON.parse(text)
}

const toEvent = (input: unknown): Event => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('event must be a JSON object')
  }
  const e = input as { [key: string]: unknown }
  if (typeof e.id !== 'string' || !isHex(e.id, 64)) {
    throw new Error('event.id must be 64 lowercase hex chars')
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
  // Array.isArray/instanceof have no scriptc lowering; input is JSON.parse
  // output so a length+elements duck-type check is enough.
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
    tags: e.tags as string[][],
  }
}

const print = (report: ValidationReport): void => {
  console.log(JSON.stringify(report))
}

const run = async (argv: string[]): Promise<number> => {
  let eventSource: string | undefined
  const filterSources: string[] = []
  let skipSig = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      return 0
    } else if (arg === '--skip-sig' || arg === '--no-verify') {
      skipSig = true
    } else if (arg === '--filter') {
      const source = argv[++i]
      if (typeof source === 'undefined') {
        console.log(USAGE)
        return 2
      }
      filterSources.push(source)
    } else if (typeof eventSource === 'undefined') {
      eventSource = arg
    } else {
      console.log(USAGE)
      return 2
    }
  }

  if (typeof eventSource === 'undefined') {
    console.log(USAGE)
    return 2
  }

  const stdinUsed = { value: false }
  let event: Event
  const filters: SubscriptionFilter[] = []
  try {
    event = toEvent(readJsonSource(eventSource, stdinUsed))
    for (const source of filterSources) {
      filters.push(readJsonSource(source, stdinUsed) as SubscriptionFilter)
    }
  } catch (error) {
    print({ id_valid: null, sig_valid: skipSig ? 'skipped' : null, filters: [], valid: false, error: String(error) })
    return 2
  }

  const report: ValidationReport = {
    id_valid: isEventIdValid(event),
    sig_valid: 'skipped',
    filters: [],
    valid: true,
  }

  if (!skipSig) {
    report.sig_valid = isEventSignatureValid(event)
  }

  filterSources.forEach((_, index) => {
    report.filters.push({ index, match: isEventMatchingFilter(filters[index])(event) })
  })

  report.valid =
    report.id_valid === true && report.sig_valid !== false && report.filters.every((f) => f.match)

  print(report)
  return report.valid ? 0 : 1
}

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    print({ id_valid: null, sig_valid: null, filters: [], valid: false, error: String(error) })
    process.exit(2)
  })
