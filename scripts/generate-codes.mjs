#!/usr/bin/env node
// Regenerate codes.json, the shared registry of dns01 provider codes
// (https://nginxui.com/plugin/naming), from a plugin's plugin.json.
//
// Usage:
//   node scripts/generate-codes.mjs <path-or-url-to-plugin.json> [--check]
//
// <path-or-url-to-plugin.json> is read from the plugin's OWN repository (a
// local checkout, or a downloaded release asset) — never from this catalog
// repository, which only stores a trimmed manifest snapshot without the
// bulky provider list. Point this script at the source when a dns01 plugin's
// provider list changes, review the diff, then commit the result.
//
// --check reports what would change without writing codes.json, and exits
// with a non-zero status if the file is not already up to date. This is
// useful in CI to double-check a hand-edited codes.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CODES_PATH = path.join(ROOT, 'codes.json')

const PROVIDER_CODE_PATTERN = /^[a-z0-9-]{2,32}$/

async function readManifest(source) {
  let text
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source)
    if (!response.ok)
      throw new Error(`fetching ${source}: HTTP ${response.status}`)
    text = await response.text()
  }
  else {
    text = readFileSync(source, 'utf8')
  }
  return JSON.parse(text)
}

function loadExistingCodes() {
  if (!existsSync(CODES_PATH))
    return {}
  return JSON.parse(readFileSync(CODES_PATH, 'utf8'))
}

function sortedObject(obj) {
  const out = {}
  for (const key of Object.keys(obj).sort())
    out[key] = obj[key]
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const source = args.find(a => !a.startsWith('--'))
  if (!source) {
    console.error('usage: node scripts/generate-codes.mjs <path-or-url-to-plugin.json> [--check]')
    process.exit(2)
  }

  const manifest = await readManifest(source)
  const ownerId = manifest.id
  if (!ownerId)
    throw new Error(`${source} has no "id" field`)

  const providers = manifest.dns01?.providers ?? []
  if (providers.length === 0)
    console.error(`warning: ${source} declares no dns01.providers, nothing to register`)

  const existing = loadExistingCodes()
  const next = { ...existing }
  const conflicts = []

  for (const provider of providers) {
    const { code, name } = provider
    if (!PROVIDER_CODE_PATTERN.test(code)) {
      conflicts.push(`provider ${JSON.stringify(name)} has an invalid code ${JSON.stringify(code)}`)
      continue
    }
    const current = next[code]
    if (current && current.owner !== ownerId) {
      // A code is a shared namespace, only the registered owner may
      // update its entry.
      conflicts.push(`code ${JSON.stringify(code)} is already registered to ${current.owner}, cannot reassign to ${ownerId}`)
      continue
    }
    next[code] = { name, owner: ownerId }
  }

  if (conflicts.length > 0) {
    console.error('codes.json conflicts:')
    for (const c of conflicts)
      console.error(`  - ${c}`)
    process.exit(1)
  }

  const sorted = sortedObject(next)
  const serialized = `${JSON.stringify(sorted, null, 2)}\n`

  if (checkOnly) {
    const current = existsSync(CODES_PATH) ? readFileSync(CODES_PATH, 'utf8') : ''
    if (current !== serialized) {
      console.error('codes.json is not up to date with', source)
      process.exit(1)
    }
    console.log('codes.json is up to date')
    return
  }

  writeFileSync(CODES_PATH, serialized)
  console.log(`wrote ${Object.keys(sorted).length} codes to ${path.relative(ROOT, CODES_PATH)} (${Object.keys(next).length - Object.keys(existing).length} new)`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
