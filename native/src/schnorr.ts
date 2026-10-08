// Vendored BIP-340 schnorr signature verification (secp256k1, even-y public
// keys): pure BigInt arithmetic over our own sha256, Jacobian coordinates
// (one modular inversion per verification, not one per point op).
//
// Why this exists: the compiled unit deliberately avoids @noble/secp256k1 so
// the binary stays 100% static — noble's async schnorr.verify fails scriptc's
// quickjs island marshalling ("expected boolean, got object" — verified) and
// verifySync can't be fed a Uint8Array-typed sha256Sync across the boundary
// (SC1090). All inputs/outputs are strings/booleans, so the module is fully
// statically compiled with zero island traffic.

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

// Jacobian (X, Y, Z) represents affine (X/Z^2, Y/Z^3); Z = 0 is infinity.
interface JacobianPoint {
  x: bigint
  y: bigint
  z: bigint
}

const G: AffinePoint = {
  x: BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
  y: BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'),
}

const JACOBIAN_INF: JacobianPoint = { x: ZERO, y: ONE, z: ZERO }

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

const isInf = (p: JacobianPoint): boolean => p.z === ZERO

// Standard a=0 short-Weierstrass Jacobian doubling.
const jacobianDouble = (p: JacobianPoint): JacobianPoint => {
  if (p.y === ZERO || isInf(p)) {
    return JACOBIAN_INF
  }
  const a = mod(p.x * p.x, CURVE_P)
  const b = mod(p.y * p.y, CURVE_P)
  const c = mod(b * b, CURVE_P)
  const d = mod(TWO * mod(mod(p.x + b, CURVE_P) * mod(p.x + b, CURVE_P) - a - c, CURVE_P), CURVE_P)
  const e = mod(BigInt(3) * a, CURVE_P)
  const f = mod(e * e, CURVE_P)
  const x = mod(f - TWO * d, CURVE_P)
  const y = mod(e * mod(d - x, CURVE_P) - BigInt(8) * c, CURVE_P)
  const z = mod(TWO * p.y * p.z, CURVE_P)
  return { x, y, z }
}

// General Jacobian + Jacobian addition.
const jacobianAdd = (p: JacobianPoint, q: JacobianPoint): JacobianPoint => {
  if (isInf(p)) {
    return q
  }
  if (isInf(q)) {
    return p
  }
  const z1z1 = mod(p.z * p.z, CURVE_P)
  const z2z2 = mod(q.z * q.z, CURVE_P)
  const u1 = mod(p.x * z2z2, CURVE_P)
  const u2 = mod(q.x * z1z1, CURVE_P)
  const s1 = mod(p.y * mod(q.z * z2z2, CURVE_P), CURVE_P)
  const s2 = mod(q.y * mod(p.z * z1z1, CURVE_P), CURVE_P)
  if (u1 === u2) {
    if (s1 !== s2) {
      return JACOBIAN_INF
    }
    return jacobianDouble(p)
  }
  const h = mod(u2 - u1, CURVE_P)
  const i = mod(mod(TWO * h, CURVE_P) * mod(TWO * h, CURVE_P), CURVE_P)
  const j = mod(h * i, CURVE_P)
  const r = mod(TWO * mod(s2 - s1, CURVE_P), CURVE_P)
  const v = mod(u1 * i, CURVE_P)
  const x = mod(r * r - j - TWO * v, CURVE_P)
  const y = mod(r * mod(v - x, CURVE_P) - TWO * s1 * j, CURVE_P)
  const z = mod((mod(p.z + q.z, CURVE_P) * mod(p.z + q.z, CURVE_P) - z1z1 - z2z2) * h, CURVE_P)
  return { x, y, z }
}

const jacobianNeg = (p: JacobianPoint): JacobianPoint => ({ x: p.x, y: mod(-p.y, CURVE_P), z: p.z })

const jacobianMul = (scalar: bigint, p: AffinePoint): JacobianPoint => {
  let n = mod(scalar, CURVE_N)
  let result = JACOBIAN_INF
  let addend: JacobianPoint = { x: p.x, y: p.y, z: ONE }
  while (n > ZERO) {
    if (n % TWO === ONE) {
      result = jacobianAdd(result, addend)
    }
    addend = jacobianDouble(addend)
    n = n / TWO
  }
  return result
}

const toAffine = (p: JacobianPoint): AffinePoint | null => {
  if (isInf(p)) {
    return null
  }
  const zInv = invert(p.z)
  const zInv2 = mod(zInv * zInv, CURVE_P)
  return { x: mod(p.x * zInv2, CURVE_P), y: mod(p.y * mod(zInv2 * zInv, CURVE_P), CURVE_P) }
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

  // R = s*G - e*P
  const sG = jacobianMul(s, G)
  const eP = jacobianMul(e, p)
  const sum = jacobianAdd(sG, jacobianNeg(eP))
  const sumAffine = toAffine(sum)
  if (sumAffine === null) {
    return false
  }

  return sumAffine.x === r && sumAffine.y % TWO === ZERO
}
