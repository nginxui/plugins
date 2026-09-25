#!/usr/bin/env node
// Assembles partners/*.json into v1/partners.json, the partner keyring
// nginx-ui hosts fetch. CI signs the result with the project's release key
// into v1/partners.json.minisig (.github/workflows/build-index.yml, see
// docs/signing.md). Requires Node.js >= 20 and no npm dependencies.
//
// Usage: node scripts/build-partners.mjs [--check]
//
// --check builds the keyring in memory and compares it against the committed
// v1/partners.json instead of writing, exiting non-zero if they differ.
//
// The output is deterministic. Partners are sorted by name, revoked key ids
// are sorted, and updated_at only moves when partners or revoked change.
// Then it is the commit time of the newest change under partners/, or the
// build time when partners/ has uncommitted changes or that commit is not
// newer than the published updated_at. Hosts refuse a keyring older than the
// one they cached, so updated_at never moves back.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePublicKey } from './lib/minisign.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PARTNERS_DIR = path.join(ROOT, 'partners')
const KEYRING_PATH = path.join(ROOT, 'v1', 'partners.json')
const SCHEMA_VERSION = 1

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

/**
 * Reads partners/*.json and returns [{ file, partner, key }], where key is
 * the parsed public key ({ line, id, key }). Throws on invalid JSON, a file
 * not named <name>.json, a malformed key, or a key used by two files.
 * scripts/validate.mjs reports schema problems with better messages.
 */
export function loadPartners() {
  if (!existsSync(PARTNERS_DIR))
    return []

  const files = readdirSync(PARTNERS_DIR).filter(f => f.endsWith('.json')).sort()
  const partners = []
  const fileByKeyId = new Map()

  for (const file of files) {
    let partner
    try {
      partner = JSON.parse(readFileSync(path.join(PARTNERS_DIR, file), 'utf8'))
    }
    catch (err) {
      throw new Error(`partners/${file}: invalid JSON: ${err.message}`)
    }

    if (file !== `${partner.name}.json`)
      throw new Error(`partners/${file}: "name" is ${JSON.stringify(partner.name)}, expected the file to be named ${partner.name}.json`)

    let key
    try {
      key = parsePublicKey(typeof partner.public_key === 'string' ? partner.public_key : '')
    }
    catch (err) {
      throw new Error(`partners/${file}: public_key: ${err.message}`)
    }

    if (fileByKeyId.has(key.id))
      throw new Error(`partners/${file}: key ${key.id} is already listed in partners/${fileByKeyId.get(key.id)}`)
    fileByKeyId.set(key.id, file)

    partners.push({ file, partner, key })
  }

  return partners
}

/** The keyring without updated_at: partners not revoked, sorted by name,
 * and the sorted key ids of the revoked ones. */
export function keyringContent(partners = loadPartners()) {
  const listed = partners
    .filter(({ partner }) => partner.revoked !== true)
    .sort((a, b) => compareBytes(a.partner.name, b.partner.name))
    .map(({ partner, key }) => {
      const item = { name: partner.name, public_key: key.line }
      if (partner.expires)
        item.expires = partner.expires
      return item
    })

  const revoked = [...new Set(partners
    .filter(({ partner }) => partner.revoked === true)
    .map(({ key }) => key.id))]
    .sort(compareBytes)

  return { partners: listed, revoked }
}

function readPublished() {
  if (!existsSync(KEYRING_PATH))
    return null
  try {
    return JSON.parse(readFileSync(KEYRING_PATH, 'utf8'))
  }
  catch {
    return null
  }
}

function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Runs git in the repository, returning its trimmed output or '' when git
 * is missing or fails. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  }
  catch {
    return ''
  }
}

/** Commit time of the newest change under partners/, deletions included, or
 * '' when there is none or partners/ has uncommitted changes. */
function lastPartnersCommit() {
  if (git(['status', '--porcelain', '--', 'partners']) !== '')
    return ''
  const time = git(['log', '-1', '--format=%cI', '--', 'partners'])
  return time ? rfc3339(new Date(time)) : ''
}

function nextUpdatedAt(previous) {
  const previousTime = previous ? Date.parse(previous) : Number.NaN
  for (const candidate of [lastPartnersCommit(), rfc3339(new Date())]) {
    if (candidate && (Number.isNaN(previousTime) || Date.parse(candidate) > previousTime))
      return candidate
  }
  // The clock is not past the published keyring, move one second beyond it.
  return rfc3339(new Date(previousTime + 1000))
}

function sameContent(published, content) {
  return published?.schema_version === SCHEMA_VERSION
    && typeof published.updated_at === 'string'
    && JSON.stringify(published.partners) === JSON.stringify(content.partners)
    && JSON.stringify(published.revoked) === JSON.stringify(content.revoked)
}

export function buildKeyring() {
  const content = keyringContent()
  const published = readPublished()
  const updatedAt = sameContent(published, content) ? published.updated_at : nextUpdatedAt(published?.updated_at)
  // Key order is fixed so two builds of the same content stringify
  // identically.
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: updatedAt,
    partners: content.partners,
    revoked: content.revoked,
  }
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const document = buildKeyring()
  const serialized = serialize(document)

  if (checkOnly) {
    const current = existsSync(KEYRING_PATH) ? readFileSync(KEYRING_PATH, 'utf8') : ''
    if (current !== serialized) {
      console.error('v1/partners.json is not up to date with partners/*.json. Run: node scripts/build-partners.mjs')
      process.exit(1)
    }
    console.log('v1/partners.json is up to date')
    return
  }

  writeFileSync(KEYRING_PATH, serialized)
  console.log(`wrote ${document.partners.length} partner(s) and ${document.revoked.length} revoked key id(s) to v1/partners.json (updated_at ${document.updated_at})`)
}

if (import.meta.url === `file://${process.argv[1]}`)
  main()
