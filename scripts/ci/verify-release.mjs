#!/usr/bin/env node
// Downloads a plugin entry's newest release asset and its detached .minisig,
// checks the asset against sha256, and verifies the signature with the
// `minisign` CLI (must be on PATH — .github/workflows/validate.yml installs
// it) against either the entry's own author_public_key (community trust) or
// the catalog's official public key (official/verified trust).
//
// Usage: node scripts/ci/verify-release.mjs <plugins/id.json>
// Env:   PLUGIN_SIGNING_PUBLIC_KEY  the catalog's official minisign public
//                                   key text. Optional: official/verified
//                                   verification is skipped, not failed,
//                                   when this is not set (e.g. before the
//                                   repository owner has generated the key,
//                                   see docs/signing.md).
//
// Exits 0 both when everything verifies and when verification was skipped
// for a documented reason (no release asset published yet, no official key
// configured yet). Exits 1 only for an actual mismatch or a missing
// signature that was required.

import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function log(status, message) {
  console.log(`${status} ${message}`)
}

function newestRelease(entry) {
  return [...(entry.releases ?? [])].sort((a, b) => (a.version > b.version ? 1 : a.version < b.version ? -1 : 0)).at(-1)
}

async function tryDownload(url) {
  try {
    const response = await fetch(url)
    if (!response.ok)
      return null
    return Buffer.from(await response.arrayBuffer())
  }
  catch {
    return null
  }
}

function verifyWithMinisign(dataFile, sigFile, publicKeyText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nginx-ui-plugins-minisign-'))
  const keyFile = path.join(dir, 'key.pub')
  writeFileSync(keyFile, publicKeyText.endsWith('\n') ? publicKeyText : `${publicKeyText}\n`)
  try {
    execFileSync('minisign', ['-V', '-p', keyFile, '-m', dataFile, '-x', sigFile], { stdio: 'pipe' })
    return { ok: true }
  }
  catch (err) {
    return { ok: false, message: err.stderr?.toString() || err.message }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const entryPath = process.argv[2]
  if (!entryPath) {
    console.error('usage: node scripts/ci/verify-release.mjs <plugins/id.json>')
    process.exit(2)
  }

  const entry = JSON.parse(readFileSync(entryPath, 'utf8'))
  const release = newestRelease(entry)
  if (!release) {
    log('SKIP', `${entry.id} has no releases yet`)
    return
  }

  console.log(`verifying ${entry.id} ${release.version} (trust: ${entry.trust})`)

  const asset = await tryDownload(release.download_url)
  if (!asset) {
    log('SKIP', `download_url is not reachable yet: ${release.download_url}`)
    return
  }
  console.log(`  downloaded ${asset.length} bytes`)

  if (release.sha256) {
    const digest = createHash('sha256').update(asset).digest('hex')
    if (digest !== release.sha256.toLowerCase()) {
      log('FAIL', `sha256 mismatch: catalog says ${release.sha256}, asset hashes to ${digest}`)
      process.exitCode = 1
      return
    }
    log('OK', 'sha256 matches')
  }
  else if (entry.trust === 'official') {
    log('SKIP', 'sha256 is empty, filled in by the release workflow for official entries (see docs/signing.md)')
  }
  else {
    log('FAIL', 'sha256 is required for a non-official entry')
    process.exitCode = 1
    return
  }

  const signatureUrl = release.signature_url || `${release.download_url}.minisig`
  const signature = await tryDownload(signatureUrl)
  if (!signature) {
    if (entry.trust === 'official' && !release.sha256) {
      log('SKIP', `signature not published yet: ${signatureUrl}`)
      return
    }
    log('FAIL', `signature is required but was not found at ${signatureUrl}`)
    process.exitCode = 1
    return
  }

  const publicKeyText = release.signed_by === 'author' ? entry.author_public_key : process.env.PLUGIN_SIGNING_PUBLIC_KEY
  if (!publicKeyText) {
    log('SKIP', release.signed_by === 'author'
      ? `${entry.id} has no author_public_key to verify against`
      : 'PLUGIN_SIGNING_PUBLIC_KEY is not configured yet, see docs/signing.md')
    return
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'nginx-ui-plugins-asset-'))
  const dataFile = path.join(dir, 'package.tar.gz')
  const sigFile = `${dataFile}.minisig`
  writeFileSync(dataFile, asset)
  writeFileSync(sigFile, signature)

  const result = verifyWithMinisign(dataFile, sigFile, publicKeyText)
  rmSync(dir, { recursive: true, force: true })

  if (!result.ok) {
    log('FAIL', `signature verification failed: ${result.message}`)
    process.exitCode = 1
    return
  }
  log('OK', `signature verified (signed_by: ${release.signed_by ?? 'unspecified'})`)
}

main().catch((err) => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
