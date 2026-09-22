#!/usr/bin/env node
// Downloads a plugin entry's newest release's package(s) — the portable
// "<id>-<version>.tar.gz" and/or the per-platform packages RFC 0001 added
// ("<id>-<version>-<goos>-<goarch>.tar.gz", listed under "downloads") — and
// each one's detached .minisig, checks it against its sha256, and verifies
// the signature with the `minisign` CLI (must be on PATH —
// .github/workflows/validate.yml installs it) against either the entry's own
// author_public_key (community trust) or the catalog's official public key
// (official/verified trust).
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
// signature that was required, for any package of the release.

import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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

/**
 * Verifies one package of a release against its own sha256 and minisig
 * signature. `pkg` is either the portable package (built from
 * download_url/sha256/signature_url) or one entry of "downloads". `label`
 * names it in log output, e.g. "portable" or "linux-amd64". Returns false
 * only on an actual failure — a documented SKIP still returns true, per the
 * module comment.
 */
async function verifyPackage(entry, release, label, pkg) {
  const asset = await tryDownload(pkg.url)
  if (!asset) {
    log('SKIP', `${label}: url is not reachable yet: ${pkg.url}`)
    return true
  }
  console.log(`  ${label}: downloaded ${asset.length} bytes from ${pkg.url}`)

  if (pkg.sha256) {
    const digest = createHash('sha256').update(asset).digest('hex')
    if (digest !== pkg.sha256.toLowerCase()) {
      log('FAIL', `${label}: sha256 mismatch: catalog says ${pkg.sha256}, asset hashes to ${digest}`)
      return false
    }
    log('OK', `${label}: sha256 matches`)
  }
  else if (entry.trust === 'official') {
    log('SKIP', `${label}: sha256 is empty, filled in by the release workflow for official entries (see docs/signing.md)`)
  }
  else {
    log('FAIL', `${label}: sha256 is required for a non-official entry`)
    return false
  }

  const signatureUrl = pkg.signature_url || `${pkg.url}.minisig`
  const signature = await tryDownload(signatureUrl)
  if (!signature) {
    if (entry.trust === 'official' && !pkg.sha256) {
      log('SKIP', `${label}: signature not published yet: ${signatureUrl}`)
      return true
    }
    log('FAIL', `${label}: signature is required but was not found at ${signatureUrl}`)
    return false
  }

  const publicKeyText = release.signed_by === 'author' ? entry.author_public_key : process.env.PLUGIN_SIGNING_PUBLIC_KEY
  if (!publicKeyText) {
    log('SKIP', release.signed_by === 'author'
      ? `${label}: ${entry.id} has no author_public_key to verify against`
      : `${label}: PLUGIN_SIGNING_PUBLIC_KEY is not configured yet, see docs/signing.md`)
    return true
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'nginx-ui-plugins-asset-'))
  const dataFile = path.join(dir, 'package.tar.gz')
  const sigFile = `${dataFile}.minisig`
  writeFileSync(dataFile, asset)
  writeFileSync(sigFile, signature)

  const result = verifyWithMinisign(dataFile, sigFile, publicKeyText)
  rmSync(dir, { recursive: true, force: true })

  if (!result.ok) {
    log('FAIL', `${label}: signature verification failed: ${result.message}`)
    return false
  }
  log('OK', `${label}: signature verified (signed_by: ${release.signed_by ?? 'unspecified'})`)
  return true
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

  // A release may publish the portable package, per-platform packages, or
  // both (RFC 0001) — verify every package it actually lists.
  const packages = []
  if (release.download_url) {
    packages.push(['portable', {
      url: release.download_url,
      sha256: release.sha256,
      signature_url: release.signature_url,
    }])
  }
  for (const [platform, download] of Object.entries(release.downloads ?? {}))
    packages.push([platform, download])

  if (packages.length === 0) {
    log('FAIL', 'release has neither "download_url" nor "downloads"; nothing to verify')
    process.exitCode = 1
    return
  }

  let allOk = true
  for (const [label, pkg] of packages) {
    if (!await verifyPackage(entry, release, label, pkg))
      allOk = false
  }

  if (!allOk)
    process.exitCode = 1
}

main().catch((err) => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
