// Test helpers that make minisign keys and signatures with node:crypto, in
// the formats scripts/lib/minisign.mjs reads.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/** A new key pair as { id, publicKey, sign(message, trustedComment) }:
 * publicKey is the text of a .pub file, sign returns the text of a .minisig
 * file with a prehashed signature. */
export function newMinisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const keyId = randomBytes(8)
  const id = keyId.readBigUInt64LE().toString(16).toUpperCase().padStart(16, '0')
  const line = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')
  return {
    id,
    publicKey: `untrusted comment: minisign public key ${id}\n${line}\n`,
    sign(message, trustedComment = 'timestamp:0') {
      const signature = sign(null, createHash('blake2b512').update(message).digest(), privateKey)
      const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey)
      return [
        'untrusted comment: signature from a test key',
        Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
        `trusted comment: ${trustedComment}`,
        global.toString('base64'),
        '',
      ].join('\n')
    },
  }
}
