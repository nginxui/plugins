#!/usr/bin/env node
// Downloads every package of a plugin entry's newest release (the portable
// "<id>-<version>.tar.gz" and/or the per-platform packages RFC 0001 added,
// "<id>-<version>-<goos>-<goarch>.tar.gz" under "downloads"), checks it
// against its catalog sha256, extracts it and checks the signature files it
// carries at its root:
//
// 1. plugin.sums and plugin.sums.minisig are both present.
// 2. Every regular file other than those two is listed in plugin.sums, and
//    `sha256sum -c plugin.sums` passes.
// 3. For a community entry, `minisign -Vm plugin.sums -x plugin.sums.minisig
//    -P <author_public_key>` passes. nginx-ui pins the official and partner
//    keys itself, so official and verified entries skip this key check here.
//
// tar, sha256sum and minisign must be on PATH (.github/workflows/validate.yml
// installs minisign).
//
// Usage: node scripts/ci/verify-release.mjs <plugins/id.json>
//
// Exits 0 both when everything verifies and when a package was skipped for a
// documented reason (its asset is not published yet). Exits 1 only for an
// actual mismatch or a missing signature file, for any package of the
// release.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SUMS = 'plugin.sums'
const SIGNATURE = 'plugin.sums.minisig'
const SUMS_LINE = /^([0-9a-f]{64}) {2}(.+)$/

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

/** Runs a command and returns { ok, output }, never throwing. */
function run(command, args, cwd) {
  try {
    const output = execFileSync(command, args, { cwd, stdio: 'pipe' })
    return { ok: true, output: output.toString() }
  }
  catch (err) {
    const output = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim()
    return { ok: false, output: output || err.message }
  }
}

/** The base64 line of a minisign public key, given with or without its
 * "untrusted comment:" line. */
function publicKeyLine(text) {
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('untrusted comment:'))
    .at(-1) ?? ''
}

/** Slash separated paths of every regular file under root. */
function regularFiles(root, dir = '') {
  const files = []
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name
    const stat = lstatSync(path.join(root, rel))
    if (stat.isDirectory())
      files.push(...regularFiles(root, rel))
    else if (stat.isFile())
      files.push(rel)
  }
  return files
}

/**
 * Parses plugin.sums and returns { paths } or { error }. Each line must be
 * "<sha256>  <path>" with a relative slash separated path, LF endings, no
 * duplicates, sorted bytewise by path.
 */
function parseSums(text) {
  if (text.includes('\r'))
    return { error: 'uses CR line endings, only LF is allowed' }
  if (!text.endsWith('\n'))
    return { error: 'does not end with a newline' }

  const paths = []
  for (const [index, line] of text.slice(0, -1).split('\n').entries()) {
    const match = line.match(SUMS_LINE)
    if (!match)
      return { error: `line ${index + 1} is not "<sha256>  <path>": ${JSON.stringify(line)}` }
    const file = match[2]
    const segments = file.split('/')
    if (file.startsWith('/') || file.includes('\\') || segments.some(s => s === '' || s === '.' || s === '..'))
      return { error: `line ${index + 1} has an unsafe path: ${JSON.stringify(file)}` }
    if (file === SUMS || file === SIGNATURE)
      return { error: `line ${index + 1} lists ${file}, which must not be listed` }
    const previous = paths.at(-1)
    if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(file)) >= 0)
      return { error: `line ${index + 1} is out of order or duplicated: ${JSON.stringify(file)} after ${JSON.stringify(previous)}` }
    paths.push(file)
  }
  return { paths }
}

/** Checks one extracted package's signature files. Returns false on failure. */
function verifyContents(entry, label, dir) {
  for (const name of [SUMS, SIGNATURE]) {
    if (!existsSync(path.join(dir, name)) || !lstatSync(path.join(dir, name)).isFile()) {
      log('FAIL', `${label}: ${name} is missing from the package root, the package is unsigned`)
      return false
    }
  }

  const sums = parseSums(readFileSync(path.join(dir, SUMS), 'utf8'))
  if (sums.error) {
    log('FAIL', `${label}: ${SUMS} ${sums.error}`)
    return false
  }

  const listed = new Set(sums.paths)
  const unlisted = regularFiles(dir).filter(file => file !== SUMS && file !== SIGNATURE && !listed.has(file))
  if (unlisted.length > 0) {
    log('FAIL', `${label}: ${SUMS} does not list ${unlisted.map(f => JSON.stringify(f)).join(', ')}`)
    return false
  }

  const check = run('sha256sum', ['-c', '--strict', '--quiet', SUMS], dir)
  if (!check.ok) {
    log('FAIL', `${label}: sha256sum -c ${SUMS} failed:\n${check.output}`)
    return false
  }
  log('OK', `${label}: ${SUMS} covers all ${sums.paths.length} files and every digest matches`)

  if (entry.trust !== 'community') {
    log('SKIP', `${label}: ${entry.trust} key check, nginx-ui pins that key itself`)
    return true
  }

  const key = publicKeyLine(entry.author_public_key ?? '')
  if (!key) {
    log('FAIL', `${label}: ${entry.id} is a community entry without an author_public_key`)
    return false
  }
  const verify = run('minisign', ['-Vm', SUMS, '-x', SIGNATURE, '-P', key], dir)
  if (!verify.ok) {
    log('FAIL', `${label}: ${SIGNATURE} does not verify against author_public_key:\n${verify.output}`)
    return false
  }
  log('OK', `${label}: ${SIGNATURE} verifies against author_public_key`)
  return true
}

/**
 * Verifies one package of a release. `pkg` is either the portable package
 * (built from download_url and sha256) or one entry of "downloads", and
 * `label` names it in log output, e.g. "portable" or "linux-amd64". Returns
 * false only on an actual failure. A documented SKIP still returns true, per
 * the module comment.
 */
async function verifyPackage(entry, label, pkg) {
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
    log('SKIP', `${label}: sha256 is empty, fill it from the .sha256 asset next to the archive`)
  }
  else {
    log('FAIL', `${label}: sha256 is required for a non-official entry`)
    return false
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'nginx-ui-plugins-package-'))
  try {
    const archive = path.join(dir, 'package.tar.gz')
    const root = path.join(dir, 'package')
    writeFileSync(archive, asset)
    mkdirSync(root)

    const extract = run('tar', ['-xzf', archive, '-C', root])
    if (!extract.ok) {
      log('FAIL', `${label}: could not extract the package:\n${extract.output}`)
      return false
    }
    return verifyContents(entry, label, root)
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

  // A release may publish the portable package, per-platform packages, or
  // both (RFC 0001). Every package it lists is verified.
  const packages = []
  if (release.download_url)
    packages.push(['portable', { url: release.download_url, sha256: release.sha256 }])
  for (const [platform, download] of Object.entries(release.downloads ?? {}))
    packages.push([platform, download])

  if (packages.length === 0) {
    log('FAIL', 'release has neither "download_url" nor "downloads"; nothing to verify')
    process.exitCode = 1
    return
  }

  let allOk = true
  for (const [label, pkg] of packages) {
    if (!await verifyPackage(entry, label, pkg))
      allOk = false
  }

  if (!allOk)
    process.exitCode = 1
}

main().catch((err) => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
