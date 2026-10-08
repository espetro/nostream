# native/ — scriptc-compiled validator

A native binary build of the relay's NIP-01 event validation core, compiled
with [vercel-labs/scriptc](https://github.com/vercel-labs/scriptc) `0.2.5`
(`scriptc build --dynamic`). This is a fork-side experiment: it proves the
portable protocol layer of nostream can ship as a small native executable
with no Node.js runtime.

## What ships

`nostream-validate` (~1.8 MB ELF): reads a NIP-01 event as JSON and reports

- `id_valid` — `id` equals the SHA-256 of the NIP-01 canonical serialization
- `sig_valid` — `sig` is a valid BIP-340 schnorr signature over `id`/`pubkey`
- `filters[i].match` — whether the event matches each NIP-01 subscription
  filter (`ids`, `authors`, `kinds`, `since`, `until`, `#<tag>`, NIP-50 `search`)

```console
$ nostream-validate event.json --filter '{"kinds":[1]}'
{"id_valid":true,"sig_valid":true,"filters":[{"index":0,"match":true}],"valid":true}
```

Event input is a file path, inline JSON, or `-` for stdin; `--filter` is
repeatable and accepts the same forms. Exit code is `0` when every check
passes, `1` when a check fails, `2` on usage/input errors. `--skip-sig`
skips signature verification entirely (e.g. for hashing-only pipelines).

## Build

```console
$ pnpm run build:native          # or: bash scripts/build-native.sh [out]
```

`scripts/build-native.sh` installs `scriptc` if missing and synthesizes a
`clang` driver on top of `zig cc` when no real clang exists (scriptc emits
objects via `clang -target x86_64-unknown-linux-gnu …`, a triple `zig cc`
rejects; the shim rewrites it to `x86_64-linux-gnu`). Artifacts land in
`native/dist/`; the shim in `.scriptc-toolchain/` (both gitignored).

## Layout

| file | what |
|---|---|
| `src/cli.ts` | arg parsing, JSON event/filter ingestion, report + exit codes |
| `src/event.ts` | ported `serializeEvent`, `getEventHash`, `isEventIdValid`, `isEventSignatureValid`, `isEventMatchingFilter` from `src/utils/event.ts` |
| `src/filter.ts` | `#x` tag-query + geohash-prefix helpers from `src/utils/filter.ts` |
| `src/types.ts` | `Event`, `SubscriptionFilter`, `Tag`, … — relaxed copies of `src/@types` |
| `src/schnorr.ts` | vendored BIP-340 verify (pure BigInt) + `src/sha256.ts` pure-TS SHA-256 |
| `tsconfig.json` | isolated program, `strictNullChecks` (required by scriptc) |

## Caveats / known limitations (scriptc 0.2.5)

- **Scope.** The compiled unit is a *copy* of the protocol-core functions it
  needs — not shared code — because several upstream type shapes cannot be
  represented by scriptc:
  - `Tag = TagBase & string[]` — SC2008 (intersection has no runtime shape) → `string[]`
  - `[key: `#${string}`]` index signature on `SubscriptionFilter` — SC2006 → string-keyed signature
  - numeric-property `CanonicalEvent` interface — SC2001 → dropped for a plain array type
  - `UnidentifiedEvent | Event` union parameters — marshalling rejects the
    full `Event` literal (nested `tags: string[][]`) → signatures narrowed
  - `Array.isArray`/`instanceof` on `unknown`/`any` — no lowering → duck-type checks
  - `?? []` destructuring a `find()` result panics scriptc's checker — fixed in
    `src/utils/event.ts` itself (only shared-source change in this PR)
- **`strictNullChecks` is required** by scriptc but the repo's root tsconfig
  does not enable it (~114 mechanical errors repo-wide — a separate
  upstreamable effort). Only `native/` compiles under strictness here.
- **schnorr signature verification uses the vendored implementation in
  `src/schnorr.ts`, not `@noble/secp256k1`.** Verified against noble on
  valid/tampered/boundary inputs. Two scriptc bugs force this:
  - noble's `schnorr.verify` is async; `Promise<boolean>` crossing the
    quickjs-ng island boundary fails marshalling (`TypeError: expected
    boolean, got object`), so the call always errors.
  - `schnorr.verifySync` would work but requires assigning a
    `utils.sha256Sync` implementation; passing a function with `Uint8Array`
    parameters across the island boundary is rejected at compile time (SC1090).
- **Only `@noble/secp256k1.utils.sha256` runs in the island** (2 dynamic
  sites; `scriptc coverage` reports 99% static). Everything else — event-id
  hashing via Buffer+island sha256, filter matching, the full schnorr path —
  is statically compiled.
- **Not compiled here:** `toNostrEvent` (`DBEvent` Buffer/Date row shapes),
  `broadcastEvent`/`getRelayPrivateKey` (`cluster` default import, SC1012;
  `process.send` has no lowering), signing helpers.

## Verified outputs

Built on Linux x86-64 (Node 24, scriptc 0.2.5, zig-cc shim):

```
$ ./native/dist/nostream-validate /tmp/event.json
{"id_valid":true,"sig_valid":true,"filters":[],"valid":true}          # exit 0
$ ./native/dist/nostream-validate /tmp/event-tampered.json
{"id_valid":false,"sig_valid":true,"filters":[],"valid":false}        # exit 1
$ ./native/dist/nostream-validate /tmp/event.json --filter /tmp/f.json
{"id_valid":true,"sig_valid":true,"filters":[{"index":0,"match":false}],"valid":false}  # exit 1
```
