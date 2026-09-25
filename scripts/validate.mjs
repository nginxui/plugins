#!/usr/bin/env node
// Validates the whole catalog: every plugins/<id>.json against
// schema/entry.schema.json, v1/index.json against schema/catalog.schema.json,
// plus the structural rules a JSON Schema alone cannot express (id
// uniqueness, provider code registration, an author key on every community
// entry, and that v1/index.json is actually up to date with plugins/*.json).
//
// Usage: node scripts/validate.mjs
//
// Requires Node.js >= 20 and no npm dependencies.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { validateAgainstSchemaFile } from './lib/schema-validator.mjs'
import { buildIndex } from './build-index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const CODES_PATH = path.join(ROOT, 'codes.json')
const INDEX_PATH = path.join(ROOT, 'v1', 'index.json')
const ENTRY_SCHEMA = path.join(ROOT, 'schema', 'entry.schema.json')
const CATALOG_SCHEMA = path.join(ROOT, 'schema', 'catalog.schema.json')

const PROVIDER_CODE_PATTERN = /^[a-z0-9-]{2,32}$/
const PLATFORM_KEY_PATTERN = /^([a-z0-9]+-[a-z0-9]+|any)$/

let errorCount = 0

function fail(where, message) {
  errorCount += 1
  console.error(`FAIL ${where}: ${message}`)
}

function ok(message) {
  console.log(`OK   ${message}`)
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Schema-validates every plugins/<id>.json, returning the parsed entries
 * keyed by file name. A file that fails schema validation is skipped from
 * the further structural checks, since those assume a well shaped entry. */
function validateEntries() {
  const files = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.json')).sort()
  const entries = new Map()

  for (const file of files) {
    const full = path.join(PLUGINS_DIR, file)
    let data
    try {
      data = loadJson(full)
    }
    catch (err) {
      fail(`plugins/${file}`, `invalid JSON: ${err.message}`)
      continue
    }

    const schemaErrors = validateAgainstSchemaFile(ENTRY_SCHEMA, data)
    if (schemaErrors.length > 0) {
      for (const e of schemaErrors)
        fail(`plugins/${file}`, e)
      continue
    }

    if (`${data.id}.json` !== file) {
      fail(`plugins/${file}`, `"id" is ${JSON.stringify(data.id)}, expected the file to be named ${data.id}.json`)
      continue
    }

    entries.set(file, data)
  }

  if (entries.size === files.length && files.length > 0)
    ok(`${files.length} plugin entr${files.length === 1 ? 'y matches' : 'ies match'} schema/entry.schema.json`)

  return entries
}

/** Plugin ids must be unique catalog-wide (they key the merged catalog map
 * in internal/plugin.Marketplace.Catalog). */
function checkIdUniqueness(entries) {
  const byId = new Map()
  for (const [file, entry] of entries) {
    if (byId.has(entry.id)) {
      fail(`plugins/${file}`, `duplicate id ${JSON.stringify(entry.id)}, already used by plugins/${byId.get(entry.id)}`)
      continue
    }
    byId.set(entry.id, file)
  }
  if (byId.size === entries.size)
    ok('every plugin id is unique')
}

/** NAME-1/NAME-2: an author without the com.nginxui.* namespace must not
 * claim it, and io.github.<owner>.<name> ids must be owned by that GitHub
 * user (best-effort: checked against the repository_url host+owner). */
function checkNamingPolicy(entries) {
  for (const [file, entry] of entries) {
    if (entry.trust !== 'official' && entry.id.startsWith('com.nginxui.')) {
      fail(`plugins/${file}`, `id ${JSON.stringify(entry.id)} uses the reserved com.nginxui.* namespace but trust is ${JSON.stringify(entry.trust)}, not "official"`)
      continue
    }

    const githubOwnerMatch = entry.id.match(/^io\.github\.([a-z0-9-]+)\./)
    if (githubOwnerMatch) {
      const claimedOwner = githubOwnerMatch[1]
      const repoMatch = (entry.repository_url ?? '').match(/^https:\/\/github\.com\/([^/]+)\//i)
      if (!repoMatch) {
        fail(`plugins/${file}`, `id ${JSON.stringify(entry.id)} follows io.github.<owner>.<name> but repository_url is not a github.com URL`)
      }
      else if (repoMatch[1].toLowerCase() !== claimedOwner.toLowerCase()) {
        fail(`plugins/${file}`, `id claims GitHub owner ${JSON.stringify(claimedOwner)} but repository_url belongs to ${JSON.stringify(repoMatch[1])}`)
      }
    }
  }
  ok('naming policy (NAME-1/NAME-2/NAME-3)')
}

/** A community package signs its plugin.sums with the author's own key, and
 * the host only trusts that key through the entry's author_public_key. The
 * keys behind official and verified packages are pinned by the host itself. */
function checkAuthorKeys(entries) {
  for (const [file, entry] of entries) {
    if (entry.trust === 'community' && !entry.author_public_key)
      fail(`plugins/${file}`, 'trust is "community" but the entry has no author_public_key')
  }
  ok('every community entry has an author_public_key')
}

/** RFC 0001 PKG-14/PKG-15: a release needs at least one of "downloads" or
 * "download_url" (the schema's anyOf already enforces this structurally;
 * repeated here for a clearer message, matching this file's existing style
 * for cross-field checks the minimal schema validator cannot express on its
 * own), every "downloads" key must be summarized in "platforms", and a key
 * must be "<goos>-<goarch>" or "any". */
function checkDownloadsPlatforms(entries) {
  for (const [file, entry] of entries) {
    for (const release of entry.releases ?? []) {
      const downloadKeys = Object.keys(release.downloads ?? {})

      if (downloadKeys.length === 0 && !release.download_url) {
        fail(`plugins/${file}`, `release ${release.version} has neither "downloads" nor "download_url"; a release needs at least one package`)
        continue
      }

      const platforms = release.platforms ?? []
      for (const key of downloadKeys) {
        if (!PLATFORM_KEY_PATTERN.test(key)) {
          fail(`plugins/${file}`, `release ${release.version} downloads key ${JSON.stringify(key)} must match ${PLATFORM_KEY_PATTERN} or be "any"`)
          continue
        }
        if (!platforms.includes(key))
          fail(`plugins/${file}`, `release ${release.version} downloads key ${JSON.stringify(key)} is missing from "platforms"`)
      }
    }
  }
  ok('downloads keys are valid platform keys and are summarized in platforms')
}

/** NAME-4: a dns01 provider code is a shared namespace, registered once in
 * codes.json. This only checks entries whose manifest snapshot still carries
 * dns01.providers (a large plugin like com.nginxui.dns01 strips it from the
 * snapshot to keep the catalog small; codes.json for that plugin is instead
 * kept up to date with scripts/generate-codes.mjs against the plugin's own
 * release). */
function checkProviderCodes(entries) {
  if (!existsSync(CODES_PATH)) {
    fail('codes.json', 'file is missing')
    return
  }
  const codes = loadJson(CODES_PATH)

  for (const [file, entry] of entries) {
    for (const release of entry.releases ?? []) {
      const providers = release.manifest?.dns01?.providers ?? []
      for (const provider of providers) {
        if (!PROVIDER_CODE_PATTERN.test(provider.code)) {
          fail(`plugins/${file}`, `dns01 provider ${JSON.stringify(provider.name)} has an invalid code ${JSON.stringify(provider.code)}`)
          continue
        }
        const registration = codes[provider.code]
        if (!registration)
          fail('codes.json', `provider code ${JSON.stringify(provider.code)} declared by ${entry.id} (plugins/${file}) is not registered`)
        else if (registration.owner !== entry.id)
          fail('codes.json', `provider code ${JSON.stringify(provider.code)} is registered to ${registration.owner}, but ${entry.id} (plugins/${file}) also declares it`)
      }
    }
  }
  ok('codes.json covers every dns01 provider code present in a manifest snapshot')
}

function checkIndex() {
  if (!existsSync(INDEX_PATH)) {
    fail('v1/index.json', 'file is missing, run: node scripts/build-index.mjs')
    return
  }

  let data
  try {
    data = loadJson(INDEX_PATH)
  }
  catch (err) {
    fail('v1/index.json', `invalid JSON: ${err.message}`)
    return
  }

  const schemaErrors = validateAgainstSchemaFile(CATALOG_SCHEMA, data)
  for (const e of schemaErrors)
    fail('v1/index.json', e)
  if (schemaErrors.length === 0)
    ok('v1/index.json matches schema/catalog.schema.json')

  const expected = JSON.stringify(buildIndex())
  const actual = JSON.stringify(data)
  if (expected !== actual)
    fail('v1/index.json', 'is not up to date with plugins/*.json, run: node scripts/build-index.mjs')
  else
    ok('v1/index.json is up to date with plugins/*.json')
}

function main() {
  console.log(`nginx-ui-plugins validate (node ${process.version})\n`)

  const entries = validateEntries()
  checkIdUniqueness(entries)
  checkNamingPolicy(entries)
  checkAuthorKeys(entries)
  checkDownloadsPlatforms(entries)
  checkProviderCodes(entries)
  checkIndex()

  console.log()
  if (errorCount > 0) {
    console.error(`${errorCount} error(s) found`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main()
