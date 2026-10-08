// Vendored BIP-340 schnorr signature verification (secp256k1, even-y public
// keys), pure BigInt arithmetic over our own sha256.
//
// Why this exists: @noble/secp256k1@1.7.1's schnorr.verify is async, and
// Promise<boolean> results fail scriptc 0.2.5's quickjs island marshalling
// ("expected boolean, got object" — verified). schnorr.verifySync would work
// but requires injecting utils.sha256Sync, and passing a function with
// Uint8Array parameters across the island boundary is rejected at compile
// time (SC1090). This implementation takes and returns only strings/booleans,
// so it is boundary-safe whether it compiles statically or runs in the island.

import { concatBytes, sha256 } from './sha256'

const ZERO = BigInt(0)
const ONE = BigInt(1)
const TWO = BigInt(2)

const CURVE_P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f')
const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

interface AffinePoint {
  x: bigint
  y: bigint
}

const G: AffinePoint = {
  x: BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
  y: BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'),
}

const mod = (a: bigint, m: bigint): bigint => {
  const r = a % m
  return r >= ZERO ? r : r + m
}

const powMod = (base: bigint, exp: bigint, m: bigint): bigint => {
  let result = ONE
  let b = mod(base, m)
  let e = exp
  while (e > ZERO) {
    if (e % TWO === ONE) {
      result = mod(result * b, m)
    }
    b = mod(b * b, m)
    e = e / TWO
  }
  return result
}

const invert = (x: bigint): bigint => powMod(mod(x, CURVE_P), CURVE_P - TWO, CURVE_P)

const pointDouble = (p: AffinePoint): AffinePoint | null => {
  if (p.y === ZERO) {
    return null
  }
  const slope = mod(BigInt(3) * p.x * p.x * invert(mod(TWO * p.y, CURVE_P)), CURVE_P)
  const x = mod(slope * slope - TWO * p.x, CURVE_P)
  const y = mod(slope * (p.x - x) - p.y, CURVE_P)
  return { x, y }
}

const pointAdd = (p: AffinePoint | null, q: AffinePoint | null): AffinePoint | null => {
  if (p === null) {
    return q
  }
  if (q === null) {
    return p
  }
  if (p.x === q.x) {
    if (mod(p.y + q.y, CURVE_P) === ZERO) {
      return null
    }
    return pointDouble(p)
  }
  const slope = mod((q.y - p.y) * invert(mod(q.x - p.x, CURVE_P)), CURVE_P)
  const x = mod(slope * slope - p.x - q.x, CURVE_P)
  const y = mod(slope * (p.x - x) - p.y, CURVE_P)
  return { x, y }
}

const pointMul = (scalar: bigint, p: AffinePoint): AffinePoint | null => {
  let n = mod(scalar, CURVE_N)
  let result: AffinePoint | null = null
  let addend: AffinePoint | null = p
  while (n > ZERO) {
    if (n % TWO === ONE) {
      result = pointAdd(result, addend)
    }
    addend = pointAdd(addend, addend)
    n = n / TWO
  }
  return result
}

// secp256k1: y^2 = x^3 + 7; P % 4 == 3, so the square root is ySq^((P+1)/4).
const liftX = (x: bigint): AffinePoint | null => {
  if (x >= CURVE_P) {
    return null
  }
  const ySq = mod(x * x * x + BigInt(7), CURVE_P)
  const y = powMod(ySq, (CURVE_P + ONE) / BigInt(4), CURVE_P)
  if (mod(y * y, CURVE_P) !== ySq) {
    return null
  }
  return { x, y: y % TWO === ZERO ? y : CURVE_P - y }
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const bytesToBigint = (bytes: Uint8Array): bigint => {
  let n = ZERO
  for (let i = 0; i < bytes.length; i++) {
    n = n * BigInt(256) + BigInt(bytes[i])
  }
  return n
}

const asciiBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i)
  }
  return out
}

const taggedHash = (tag: string, messages: Uint8Array[]): Uint8Array => {
  const tagHash = sha256(asciiBytes(tag))
  return sha256(concatBytes([tagHash, tagHash, ...messages]))
}

export const schnorrVerify = (sigHex: string, messageHex: string, pubkeyHex: string): boolean => {
  const sig = hexToBytes(sigHex)
  const msg = hexToBytes(messageHex)
  const pub = hexToBytes(pubkeyHex)
  if (sig.length !== 64 || msg.length !== 32 || pub.length !== 32) {
    return false
  }

  const r = bytesToBigint(sig.slice(0, 32))
  const s = bytesToBigint(sig.slice(32, 64))
  const px = bytesToBigint(pub)
  if (r >= CURVE_P || s >= CURVE_N) {
    return false
  }

  const p = liftX(px)
  if (p === null) {
    return false
  }

  const e = mod(bytesToBigint(taggedHash('BIP0340/challenge', [sig.slice(0, 32), pub, msg])), CURVE_N)

  const sG = pointMul(s, G)
  const eP = pointMul(e, p)
  const negEP: AffinePoint | null = eP === null ? null : { x: eP.x, y: mod(-eP.y, CURVE_P) }
  const sum = pointAdd(sG, negEP)
  if (sum === null) {
    return false
  }

  return sum.x === r && sum.y % TWO === ZERO
}
