#!/usr/bin/env node
// Downloads every package of a catalog release (the portable
// "<id>-<version>.tar.gz" and the per-platform
// "<id>-<version>-<goos>-<goarch>.tar.gz" under "downloads"), checks it
// against its catalog sha256, extracts it and checks the signature files it
// carries at its root:
//
// 1. plugin.sums and plugin.sums.minisig are both present.
// 2. Every regular file other than those two is listed in plugin.sums, and
//    every digest in plugin.sums matches.
// 3. plugin.sums.minisig verifies against the key the entry earns its trust
//    with: the official plugin key in PLUGIN_SIGNING_PUBLIC_KEY for an
//    official entry (SKIP when that variable is empty), author_public_key for
//    a community entry.
// 4. For a verified entry carrying a partner certificate (plugin.partner and
//    plugin.partner.minisig at its root): plugin.sums lists both files, the
//    trusted comment reads partner:<name>, optionally followed by
//    ;expires:<YYYY-MM-DD> that has not passed, the certified key is not
//    revoked in partners/, the certificate verifies against the official
//    plugin key in PLUGIN_SIGNING_PUBLIC_KEY (SKIP when that variable is
//    empty), and plugin.sums.minisig is signed by the certified key. Without a
//    certificate, plugin.sums.minisig must be signed by a key listed in
//    partners/ that is neither revoked nor expired.
//
// scripts/build-catalog.mjs runs it on every release it adds to the catalog.
// tar must be on PATH, digests and signatures are checked with node:crypto.
//
// Usage: [PLUGIN_SIGNING_PUBLIC_KEY=<official plugin public key>] \
//          node scripts/ci/verify-release.mjs <index.json> <id> [<version>]
//
// Without a version the newest release of the plugin is checked. Exits 1 on a
// mismatch or a missing signature file.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadPartners } from '../build-partners.mjs'
import { parsePublicKey, parseSignature, publicKeyLine, verifySignature } from '../lib/minisign.mjs'
import { isDate } from '../lib/schema-validator.mjs'
import { compareSemver } from './semver.mjs'

const SUMS = 'plugin.sums'
const SIGNATURE = 'plugin.sums.minisig'
const PARTNER = 'plugin.partner'
const PARTNER_SIGNATURE = 'plugin.partner.minisig'
const SUMS_LINE = /^([0-9a-f]{64}) {2}(.+)$/
const CERTIFICATE_COMMENT = /^partner:([^;]+)(?:;expires:(\S+))?$/

function log(status, message) {
  console.log(`${status} ${message}`)
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

function isRegularFile(dir, name) {
  const full = path.join(dir, name)
  return existsSync(full) && lstatSync(full).isFile()
}

/** Today as YYYY-MM-DD in UTC. An expiry date is valid through that day. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Checks how a verified package earns partner trust, see the module comment
 * (step 4). `listed` is the set of paths plugin.sums lists. Returns false on
 * failure.
 */
function verifyPartner(label, dir, listed) {
  let partners
  try {
    partners = loadPartners()
  }
  catch (err) {
    log('FAIL', `${label}: cannot read partners/: ${err.message}`)
    return false
  }

  const sums = readFileSync(path.join(dir, SUMS))
  const sumsSignature = readFileSync(path.join(dir, SIGNATURE), 'utf8')
  const hasKey = isRegularFile(dir, PARTNER)
  const hasCertificate = isRegularFile(dir, PARTNER_SIGNATURE)

  if (!hasKey && !hasCertificate) {
    let signerId
    try {
      signerId = parseSignature(sumsSignature).keyId
    }
    catch (err) {
      log('FAIL', `${label}: ${SIGNATURE}: ${err.message}`)
      return false
    }
    const match = partners.find(({ key }) => key.id === signerId)
    if (!match) {
      log('FAIL', `${label}: no partner certificate (${PARTNER}, ${PARTNER_SIGNATURE}), and ${SIGNATURE} is signed by key ${signerId}, which is not in partners/`)
      return false
    }
    if (match.partner.revoked === true) {
      log('FAIL', `${label}: ${SIGNATURE} is signed by key ${signerId}, revoked in partners/${match.file}`)
      return false
    }
    if (match.partner.expires && match.partner.expires < today()) {
      log('FAIL', `${label}: ${SIGNATURE} is signed by key ${signerId}, which expired on ${match.partner.expires} in partners/${match.file}`)
      return false
    }
    try {
      verifySignature(match.key.line, sums, sumsSignature)
    }
    catch (err) {
      log('FAIL', `${label}: ${SIGNATURE} does not verify against partners/${match.file}: ${err.message}`)
      return false
    }
    log('OK', `${label}: no partner certificate, ${SIGNATURE} verifies against partners/${match.file} (key ${signerId})`)
    return true
  }

  if (!hasKey || !hasCertificate) {
    log('FAIL', `${label}: ${hasKey ? PARTNER_SIGNATURE : PARTNER} is missing, a partner certificate needs both ${PARTNER} and ${PARTNER_SIGNATURE} at the package root`)
    return false
  }
  if (!listed.has(PARTNER) || !listed.has(PARTNER_SIGNATURE)) {
    log('FAIL', `${label}: ${SUMS} must list both ${PARTNER} and ${PARTNER_SIGNATURE}`)
    return false
  }
  log('OK', `${label}: ${SUMS} lists ${PARTNER} and ${PARTNER_SIGNATURE}`)

  const partnerBytes = readFileSync(path.join(dir, PARTNER))
  const certificateText = readFileSync(path.join(dir, PARTNER_SIGNATURE), 'utf8')
  let partnerKey
  let certificate
  try {
    partnerKey = parsePublicKey(partnerBytes.toString('utf8'))
  }
  catch (err) {
    log('FAIL', `${label}: ${PARTNER} is not a minisign public key: ${err.message}`)
    return false
  }
  try {
    certificate = parseSignature(certificateText)
  }
  catch (err) {
    log('FAIL', `${label}: ${PARTNER_SIGNATURE}: ${err.message}`)
    return false
  }

  const comment = certificate.trustedComment.match(CERTIFICATE_COMMENT)
  if (!comment || (comment[2] !== undefined && !isDate(comment[2]))) {
    log('FAIL', `${label}: ${PARTNER_SIGNATURE} trusted comment ${JSON.stringify(certificate.trustedComment)} is not partner:<name> or partner:<name>;expires:<YYYY-MM-DD>`)
    return false
  }
  const [, name, expires] = comment
  const certified = `certificate for ${JSON.stringify(name)} (key ${partnerKey.id}, ${expires ? `expires ${expires}` : 'no expiry'})`
  if (expires && expires < today()) {
    log('FAIL', `${label}: ${certified} has expired`)
    return false
  }
  const revokedBy = partners.find(({ partner, key }) => partner.revoked === true && key.id === partnerKey.id)
  if (revokedBy) {
    log('FAIL', `${label}: ${certified} names a key revoked in partners/${revokedBy.file}`)
    return false
  }

  const officialKey = (process.env.PLUGIN_SIGNING_PUBLIC_KEY ?? '').trim()
  if (!officialKey) {
    log('SKIP', `${label}: ${certified} signature check, PLUGIN_SIGNING_PUBLIC_KEY is not set`)
  }
  else {
    try {
      parsePublicKey(officialKey)
    }
    catch (err) {
      log('FAIL', `${label}: PLUGIN_SIGNING_PUBLIC_KEY: ${err.message}`)
      return false
    }
    try {
      verifySignature(officialKey, partnerBytes, certificateText)
    }
    catch (err) {
      log('FAIL', `${label}: ${certified} does not verify against the official plugin key: ${err.message}`)
      return false
    }
    log('OK', `${label}: ${certified} verifies against the official plugin key`)
  }

  try {
    verifySignature(partnerKey.line, sums, sumsSignature)
  }
  catch (err) {
    log('FAIL', `${label}: ${SIGNATURE} is not signed by the key in ${PARTNER}: ${err.message}`)
    return false
  }
  log('OK', `${label}: ${SIGNATURE} verifies against the certified partner key ${partnerKey.id}`)
  return true
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

  const sumsText = readFileSync(path.join(dir, SUMS), 'utf8')
  for (const line of sumsText.slice(0, -1).split('\n')) {
    const [, digest, file] = line.match(SUMS_LINE)
    const full = path.join(dir, file)
    if (!isRegularFile(dir, file)) {
      log('FAIL', `${label}: ${SUMS} lists ${JSON.stringify(file)}, which is not a regular file in the package`)
      return false
    }
    if (createHash('sha256').update(readFileSync(full)).digest('hex') !== digest) {
      log('FAIL', `${label}: ${JSON.stringify(file)} does not match its digest in ${SUMS}`)
      return false
    }
  }
  log('OK', `${label}: ${SUMS} covers all ${sums.paths.length} files and every digest matches`)

  if (entry.trust === 'verified')
    return verifyPartner(label, dir, listed)

  let key
  let keyName
  if (entry.trust === 'official') {
    key = (process.env.PLUGIN_SIGNING_PUBLIC_KEY ?? '').trim()
    keyName = 'the official plugin key'
    if (!key) {
      log('SKIP', `${label}: ${SIGNATURE} check, PLUGIN_SIGNING_PUBLIC_KEY is not set`)
      return true
    }
  }
  else if (entry.trust === 'community') {
    key = publicKeyLine(entry.author_public_key ?? '')
    keyName = 'author_public_key'
    if (!key) {
      log('FAIL', `${label}: ${entry.id} is a community entry without an author_public_key`)
      return false
    }
  }
  else {
    log('FAIL', `${label}: unknown trust ${JSON.stringify(entry.trust)}`)
    return false
  }
  try {
    verifySignature(key, readFileSync(path.join(dir, SUMS)), readFileSync(path.join(dir, SIGNATURE), 'utf8'))
  }
  catch (err) {
    log('FAIL', `${label}: ${SIGNATURE} does not verify against ${keyName}: ${err.message}`)
    return false
  }
  log('OK', `${label}: ${SIGNATURE} verifies against ${keyName}`)
  return true
}

/**
 * Verifies one package of a release. `pkg` is either the portable package
 * (built from download_url and sha256) or one entry of "downloads", and
 * `label` names it in log output. Returns false on any failure.
 */
async function verifyPackage(entry, label, pkg) {
  const asset = await tryDownload(pkg.url)
  if (!asset) {
    log('FAIL', `${label}: cannot download ${pkg.url}`)
    return false
  }
  console.log(`  ${label}: downloaded ${asset.length} bytes from ${pkg.url}`)

  if (!pkg.sha256) {
    log('FAIL', `${label}: the release has no sha256 for ${pkg.url}`)
    return false
  }
  const digest = createHash('sha256').update(asset).digest('hex')
  if (digest !== pkg.sha256.toLowerCase()) {
    log('FAIL', `${label}: sha256 mismatch: the release says ${pkg.sha256}, the package hashes to ${digest}`)
    return false
  }
  log('OK', `${label}: sha256 matches`)

  const dir = mkdtempSync(path.join(tmpdir(), 'nginxui-plugins-package-'))
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

/**
 * Verifies every package of one catalog release of entry. Returns false when
 * any of them fails, a documented SKIP still counts as a pass.
 */
export async function verifyRelease(entry, release) {
  console.log(`verifying ${entry.id} ${release.version} (trust: ${entry.trust})`)

  const packages = []
  if (release.download_url)
    packages.push(['portable', { url: release.download_url, sha256: release.sha256 }])
  for (const [platform, download] of Object.entries(release.downloads ?? {}))
    packages.push([platform, download])

  if (packages.length === 0) {
    log('FAIL', `${entry.id} ${release.version}: neither "download_url" nor "downloads", nothing to verify`)
    return false
  }

  let allOk = true
  for (const [label, pkg] of packages) {
    if (!await verifyPackage(entry, `${entry.id} ${release.version} ${label}`, pkg))
      allOk = false
  }
  return allOk
}

async function main() {
  const [indexPath, id, version] = process.argv.slice(2)
  if (!indexPath || !id) {
    console.error('usage: node scripts/ci/verify-release.mjs <index.json> <id> [<version>]')
    process.exit(2)
  }

  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  const entry = index.plugins.find(plugin => plugin.id === id)
  if (!entry) {
    console.error(`${id} is not in ${indexPath}`)
    process.exit(1)
  }
  const releases = [...(entry.releases ?? [])].sort((a, b) => compareSemver(a.version, b.version))
  const release = version ? releases.find(r => r.version === version) : releases.at(-1)
  if (!release) {
    log('SKIP', `${id} has no release${version ? ` ${version}` : ''} in ${indexPath}`)
    return
  }
  if (!await verifyRelease(entry, release))
    process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message || err)
    process.exit(1)
  })
}
