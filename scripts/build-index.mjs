#!/usr/bin/env node
// Merges plugins/*.json into v1/index.json, the document nginx-ui hosts
// actually fetch (settings.DefaultPluginMarketplaceSource). Requires
// Node.js >= 20 and no npm dependencies.
//
// Usage: node scripts/build-index.mjs [--check]
//
// --check builds the index in memory and compares it against the committed
// v1/index.json instead of writing, exiting non-zero if they differ. Used by
// scripts/validate.mjs and by CI to make sure nobody forgot to regenerate it.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const INDEX_PATH = path.join(ROOT, 'v1', 'index.json')
const SCHEMA_VERSION = 1
// Name a host shows for this catalog as the source of its plugins.
const CATALOG_NAME = {
  en: 'NGINX UI Plugins',
  zh_CN: 'NGINX UI 插件',
  zh_TW: 'NGINX UI 外掛',
  ja_JP: 'NGINX UI プラグイン',
}
// Image a host shows for this catalog, served next to the index.
const CATALOG_ICON = 'https://plugins.nginxui.com/assets/icon.png'

export function loadEntries() {
  const files = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.json')).sort()
  const entries = []
  const seenIds = new Map()

  for (const file of files) {
    const full = path.join(PLUGINS_DIR, file)
    let entry
    try {
      entry = JSON.parse(readFileSync(full, 'utf8'))
    }
    catch (err) {
      throw new Error(`plugins/${file}: invalid JSON: ${err.message}`)
    }

    const expectedFile = `${entry.id}.json`
    if (file !== expectedFile)
      throw new Error(`plugins/${file}: "id" is ${JSON.stringify(entry.id)}, expected the file to be named ${expectedFile}`)

    if (seenIds.has(entry.id))
      throw new Error(`duplicate plugin id ${JSON.stringify(entry.id)} in plugins/${file} and plugins/${seenIds.get(entry.id)}`)
    seenIds.set(entry.id, file)

    entries.push(entry)
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return entries
}

/**
 * The index's updated_at is derived from the data itself (the newest
 * release.released_at across every entry) rather than from the wall clock,
 * so rebuilding from the same plugins/*.json is byte-for-byte deterministic
 * and does not produce a commit every time build-index.yml runs.
 */
export function newestReleaseTimestamp(entries) {
  let newest = ''
  for (const entry of entries) {
    for (const release of entry.releases ?? []) {
      if (release.released_at && release.released_at > newest)
        newest = release.released_at
    }
  }
  return newest
}

export function buildIndex() {
  const plugins = loadEntries()
  const updatedAt = newestReleaseTimestamp(plugins)
  // Key order is fixed here (schema_version, name, icon, updated_at,
  // plugins), so this object can be serialized directly with JSON.stringify
  // without a separate reordering step, and two calls to buildIndex() always
  // stringify identically.
  const document = { schema_version: SCHEMA_VERSION, name: CATALOG_NAME, icon: CATALOG_ICON }
  if (updatedAt)
    document.updated_at = updatedAt
  document.plugins = plugins
  return document
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const document = buildIndex()
  const serialized = serialize(document)

  if (checkOnly) {
    const current = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf8') : ''
    if (current !== serialized) {
      console.error('v1/index.json is not up to date with plugins/*.json. Run: node scripts/build-index.mjs')
      process.exit(1)
    }
    console.log('v1/index.json is up to date')
    return
  }

  writeFileSync(INDEX_PATH, serialized)
  console.log(`wrote ${document.plugins.length} plugin(s) to v1/index.json`)
}

if (import.meta.url === `file://${process.argv[1]}`)
  main()
