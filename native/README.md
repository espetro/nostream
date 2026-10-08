# native/ — scriptc-compiled validator

A native binary build of the relay's NIP-01 event validation core, compiled
with [vercel-labs/scriptc](https://github.com/vercel-labs/scriptc) `0.2.5`.
This is a fork-side experiment: it proves the portable protocol layer of
nostream can ship as a small native executable with no Node.js runtime —
and no embedded JS engine: the compiled unit is **100% static**
(`scriptc coverage` reports 306/306 statements, "no dynamic remainder").

## What ships

`nostream-validate` (~460 KB ELF): reads a NIP-01 event as JSON and reports

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
`--batch` reads stdin as JSONL (one event per line) and prints one report
line per event — the mode used by the benchmark below.

## Build

```console
$ pnpm run build:native          # or: bash scripts/build-native.sh [out]
```

`SCRIPTC_DYNAMIC=1` builds the quickjs-island variant instead (~1.8 MB) —
useful only for comparison; the static build is the default.

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
| `src/schnorr.ts` | vendored BIP-340 verify (pure BigInt, Jacobian coordinates) |
| `src/sha256.ts` | vendored pure-TS SHA-256 (event-id hashing + BIP-340 tagged hash) |
| `testdata/` | deterministic signed fixture event + tampered/bad-sig/filter variants |
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
- **No `@noble/secp256k1` at all — all cryptography is vendored**
  (`src/sha256.ts` pure-TS SHA-256, `src/schnorr.ts` pure-BigInt BIP-340
  verify with Jacobian point math), verified against noble on
  valid/tampered/boundary inputs (104/104 agreement). Two scriptc bugs
  force this:
  - noble's `schnorr.verify` is async; `Promise<boolean>` crossing the
    quickjs-ng island boundary fails marshalling (`TypeError: expected
    boolean, got object`), so the call always errors.
  - `schnorr.verifySync` would work but requires assigning a
    `utils.sha256Sync` implementation; passing a function with `Uint8Array`
    parameters across the island boundary is rejected at compile time (SC1090).
  Vendoring also removed the last 2 island sites (noble's async
  `utils.sha256`), which is what makes the binary fully static.
- **Not compiled here:** `toNostrEvent` (`DBEvent` Buffer/Date row shapes),
  `broadcastEvent`/`getRelayPrivateKey` (`cluster` default import, SC1012;
  `process.send` has no lowering), signing helpers.

## Benchmark: scriptc binary vs Node

`bash native/bench/run.sh` builds the binary plus a tsc-compiled Node
baseline from the same `native/src` sources, generates a signed corpus
(2000 events), and measures three modes: `native` (this binary), `node`
(`node dist-node/cli.js` — zero-dep JS), `tsnode` (dev-loop baseline).

Results (2000 events, full id-hash + BIP-340 sig + 2 filters per event):

| mode | spawn+validate p50 | batch ev/s | batch peak RSS | artifact |
|---|---|---|---|---|
| native | 56 ms | 18 | 3.3 MiB | 473 KiB static ELF, zero deps |
| node | 33 ms | 216 | 66 MiB | 24 KiB JS + ~120 MiB node runtime |
| tsnode | 254 ms | 404 | 135 MiB | sources + node_modules |

Reading it honestly — scriptc wins where it should and loses where it matters:

- **Startup:** pure spawn cost (`--skip-sig`) is ~5 ms native vs ~20 ms
  node vs ~220 ms ts-node — the binary is 4-40× faster to first output and
  20-40× lighter on RSS.
- **Compute:** the vendored pure-BigInt BIP-340 verify runs ~54 ms/event
  compiled by scriptc vs ~4.6 ms under V8 (~12× slower). Signature
  verification dominates: `--skip-sig` drops native to ~72 µs/event
  (JSON+SHA-256+filter) vs ~32 µs on node — only ~2× apart.
- Verdict: for anything BigInt/crypto-heavy, scriptc's codegen is not
  competitive with V8 yet; for spawn-per-invocation tooling, hashing-only
  pipelines, or zero-runtime footprint, the 473 KiB static binary is the
  practical win. Batch corpus + harness live in `native/bench/`.

## Verified outputs

Built on Linux x86-64 (Node 24, scriptc 0.2.5, zig-cc shim). Fixtures in
`native/testdata/` are deterministic (fixed private key). A full
validation (id hash + schnorr verify) takes ~70 ms; ~4 ms with
`--skip-sig`.

```
$ ./native/dist/nostream-validate native/testdata/event.json
{"id_valid":true,"sig_valid":true,"filters":[],"valid":true}          # exit 0
$ ./native/dist/nostream-validate native/testdata/event-tampered.json
{"id_valid":false,"sig_valid":true,"filters":[],"valid":false}        # exit 1
$ ./native/dist/nostream-validate native/testdata/event.json --filter native/testdata/filter-nomatch.json
{"id_valid":true,"sig_valid":true,"filters":[{"index":0,"match":false}],"valid":false}  # exit 1
```
