// Minimal minisign helpers built on node:crypto, with no npm dependencies:
// public key parsing and key ids, the parts of a .minisig file, and
// signature verification the way `minisign -V` does it.
//
// Formats (https://jedisct1.github.io/minisign/):
// - public key line: base64 of "Ed" (2 bytes), key id (8 bytes, little
//   endian), Ed25519 public key (32 bytes).
// - .minisig: an "untrusted comment:" line, base64 of the algorithm ("Ed"
//   legacy or "ED" prehashed with BLAKE2b-512), key id and signature, a
//   "trusted comment:" line, and base64 of the signature over the signature
//   bytes followed by the trusted comment.

import { createHash, createPublicKey, verify } from 'node:crypto'

const PUBLIC_KEY_BYTES = 42
const SIGNATURE_BYTES = 74
const ED25519_SIGNATURE_BYTES = 64
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The base64 line of a minisign public key, given with or without its
 * "untrusted comment:" line. */
export function publicKeyLine(text) {
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('untrusted comment:'))
    .at(-1) ?? ''
}

function decodeBase64(text, size, what) {
  if (!BASE64.test(text))
    throw new Error(`${what} is not base64`)
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== size)
    throw new Error(`${what} is ${bytes.length} bytes, expected ${size}`)
  return bytes
}

/** The key id at bytes 2..10, little endian, as the upper case 16 hex digits
 * minisign prints. */
function keyIdOf(bytes) {
  return bytes.readBigUInt64LE(2).toString(16).toUpperCase().padStart(16, '0')
}

/** Parses a minisign public key (text form or its key line alone) into
 * { line, id, key }: the key line, the 16 hex key id and the raw Ed25519
 * key. Throws on anything else. */
export function parsePublicKey(text) {
  const line = publicKeyLine(text)
  const bytes = decodeBase64(line, PUBLIC_KEY_BYTES, 'the public key')
  if (bytes.toString('latin1', 0, 2) !== 'Ed')
    throw new Error('the public key is not an Ed25519 minisign key')
  return { line, id: keyIdOf(bytes), key: bytes.subarray(10) }
}

/** The 16 hex key id of a minisign public key. */
export function publicKeyId(text) {
  return parsePublicKey(text).id
}

/** Parses a .minisig file into { prehashed, keyId, signature,
 * trustedComment, globalSignature }. Throws on a malformed file. */
export function parseSignature(text) {
  const [untrusted, encoded, trusted, encodedGlobal] = text.split('\n').map(line => line.replace(/\r$/, ''))
  if (!untrusted?.startsWith('untrusted comment: '))
    throw new Error('the signature has no "untrusted comment:" line')
  if (!trusted?.startsWith('trusted comment: '))
    throw new Error('the signature has no "trusted comment:" line')

  const bytes = decodeBase64(encoded ?? '', SIGNATURE_BYTES, 'the signature')
  const algorithm = bytes.toString('latin1', 0, 2)
  if (algorithm !== 'Ed' && algorithm !== 'ED')
    throw new Error(`unknown signature algorithm ${JSON.stringify(algorithm)}`)

  return {
    prehashed: algorithm === 'ED',
    keyId: keyIdOf(bytes),
    signature: bytes.subarray(10),
    trustedComment: trusted.slice('trusted comment: '.length),
    globalSignature: decodeBase64(encodedGlobal ?? '', ED25519_SIGNATURE_BYTES, 'the trusted comment signature'),
  }
}

/**
 * Verifies `message` (a Buffer) against a .minisig text and a public key:
 * the key ids must match, the signature must cover the message (its
 * BLAKE2b-512 hash for a prehashed signature), and the global signature must
 * cover the signature and the trusted comment. Returns the trusted comment,
 * throws when anything does not verify.
 */
export function verifySignature(publicKeyText, message, signatureText) {
  const publicKey = parsePublicKey(publicKeyText)
  const signature = parseSignature(signatureText)
  if (signature.keyId !== publicKey.id)
    throw new Error(`signed by key ${signature.keyId}, not ${publicKey.id}`)

  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]), format: 'der', type: 'spki' })
  const signed = signature.prehashed ? createHash('blake2b512').update(message).digest() : message
  if (!verify(null, signed, key, signature.signature))
    throw new Error(`the signature by key ${publicKey.id} does not match`)
  const global = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, 'utf8')])
  if (!verify(null, global, key, signature.globalSignature))
    throw new Error(`the trusted comment signature by key ${publicKey.id} does not match`)
  return signature.trustedComment
}
