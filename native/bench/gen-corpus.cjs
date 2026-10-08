// Generates a signed-event corpus + filters for the nostream-validate bench.
// Usage: node native/bench/gen-corpus.cjs [N] [outdir]
// Requires @noble/secp256k1 from repo node_modules.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { schnorr } = require('@noble/secp256k1')

const N = parseInt(process.argv[2] || '2000', 10)
const OUT = process.argv[3] || path.join(__dirname, 'out')
const N_AUTHORS = 10

const privs = Array.from({ length: N_AUTHORS }, () => crypto.randomBytes(32).toString('hex'))

const canonical = (e) => JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
const idOf = (e) => crypto.createHash('sha256').update(canonical(e)).digest('hex')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const now = Math.floor(Date.now() / 1000)
  const lines = []
  for (let i = 0; i < N; i++) {
    const priv = privs[i % N_AUTHORS]
    const pub = Buffer.from(schnorr.getPublicKey(priv)).toString('hex')
    const e = {
      pubkey: pub,
      created_at: now - (N - i),
      kind: 1,
      tags: [['t', i % 3 === 0 ? 'bench' : `t${i % 10}`], ['p', 'ab'.repeat(32)]],
      content: `bench event ${i} ${crypto.randomBytes(8).toString('hex')}`,
    }
    e.id = idOf(e)
    e.sig = Buffer.from(await schnorr.sign(e.id, priv)).toString('hex')
    lines.push(JSON.stringify(e))
  }
  fs.writeFileSync(path.join(OUT, 'corpus.jsonl'), lines.join('\n') + '\n')

  // Selective filters: one matches ~1/10 authors, one matches ~1/3 of events' #t.
  const pub0 = Buffer.from(schnorr.getPublicKey(privs[0])).toString('hex')
  const filters = [
    { kinds: [1], authors: [pub0] },
    { '#t': ['bench'], kinds: [1] },
  ]
  filters.forEach((f, i) => fs.writeFileSync(path.join(OUT, `filter${i}.json`), JSON.stringify(f)))
  console.log(`wrote ${N} events to ${OUT}/corpus.jsonl (+ filters.json)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
