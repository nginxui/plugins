// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { newMinisignKey } from './test-minisign.mjs'
import { verifyContents } from './verify-release.mjs'

const ID = 'io.github.example.demo'

/** Writes an extracted package with files, plugin.sums over them and its
 * signature by signer. */
function writePackage(files, signer) {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-release-test-'))
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(dir, name), body)
  const sums = Object.keys(files).sort().map(name => `${createHash('sha256').update(files[name]).digest('hex')}  ${name}\n`).join('')
  writeFileSync(path.join(dir, 'plugin.sums'), sums)
  writeFileSync(path.join(dir, 'plugin.sums.minisig'), signer.sign(Buffer.from(sums)))
  return dir
}

function certificate(signing, primary, id = ID) {
  return { 'plugin.signer': signing.publicKey, 'plugin.signer.minisig': primary.sign(Buffer.from(signing.publicKey), `signer:${id}`) }
}

function check(entry, files, signer) {
  const dir = writePackage({ 'plugin.json': JSON.stringify({ id: ID }), ...files }, signer)
  try {
    return verifyContents(entry, 'test', dir)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a community package is signed by a signing key its author certified', () => {
  const primary = newMinisignKey()
  const signing = newMinisignKey()
  const stranger = newMinisignKey()
  const entry = { id: ID, trust: 'community', author_public_key: primary.publicKey }

  assert.equal(check(entry, certificate(signing, primary), signing), true)
  // The primary key itself does not sign packages the catalog lists.
  assert.equal(check(entry, {}, primary), false)
  assert.equal(check(entry, certificate(signing, primary), primary), false)
  assert.equal(check(entry, certificate(signing, primary, 'io.github.example.other'), signing), false)
  assert.equal(check(entry, certificate(signing, stranger), signing), false)
  assert.equal(check({ ...entry, revoked_signers: [signing.id] }, certificate(signing, primary), signing), false)
  assert.equal(check(entry, { 'plugin.signer': signing.publicKey }, signing), false)
})
