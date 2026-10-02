#!/usr/bin/env node
// Validates the sources of the catalog: every plugins/<id>.json against
// schema/entry.schema.json and every partners/<name>.json against
// schema/partner.schema.json, plus the rules a JSON Schema alone cannot
// express (id uniqueness, the naming policy, a GitHub repository and an
// author key where needed, unique partner keys, a reason on every
// revocation, and a keyring that builds). The releases are checked when
// scripts/build-catalog.mjs reads them from GitHub.
//
// Usage: node scripts/validate.mjs
//
// Requires Node.js >= 20 and no npm dependencies.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { validateAgainstSchemaFile } from './lib/schema-validator.mjs'
import { parsePublicKey } from './lib/minisign.mjs'
import { buildKeyring } from './build-partners.mjs'
import { parseGithubRepoUrl } from './ci/github.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const PARTNERS_DIR = path.join(ROOT, 'partners')
const ENTRY_SCHEMA = path.join(ROOT, 'schema', 'entry.schema.json')
const PARTNER_SCHEMA = path.join(ROOT, 'schema', 'partner.schema.json')
const KEYRING_SCHEMA = path.join(ROOT, 'schema', 'partners.schema.json')

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

/** Naming policy: an author without the com.nginxui.* namespace must not
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
  ok('naming policy')
}

/** A community package signs its plugin.sums with the author's own key, and
 * the host only trusts that key through the entry's author_public_key. The
 * official plugin key behind official packages is pinned by the host, and a
 * verified package relies on a partner certificate or on v1/partners.json. */
function checkAuthorKeys(entries) {
  for (const [file, entry] of entries) {
    if (entry.trust === 'community' && !entry.author_public_key)
      fail(`plugins/${file}`, 'trust is "community" but the entry has no author_public_key')
  }
  ok('every community entry has an author_public_key')
}

/** The releases come from the GitHub Releases of repository_url. */
function checkRepositories(entries) {
  for (const [file, entry] of entries) {
    if (!parseGithubRepoUrl(entry.repository_url))
      fail(`plugins/${file}`, `repository_url ${JSON.stringify(entry.repository_url)} is not a github.com repository, the releases are read from its GitHub Releases`)
  }
  ok('every entry is released on GitHub')
}

/** Schema-validates every partners/<name>.json and checks what the schema
 * cannot: the file name, a parsable key used by one partner only, and a
 * reason exactly when the partner is revoked. */
function validatePartners() {
  if (!existsSync(PARTNERS_DIR)) {
    ok('no partners/ directory, the partner keyring is empty')
    return
  }

  const files = readdirSync(PARTNERS_DIR).filter(f => f.endsWith('.json')).sort()
  const fileByKeyId = new Map()
  let validCount = 0

  for (const file of files) {
    const where = `partners/${file}`
    let data
    try {
      data = loadJson(path.join(PARTNERS_DIR, file))
    }
    catch (err) {
      fail(where, `invalid JSON: ${err.message}`)
      continue
    }

    const schemaErrors = validateAgainstSchemaFile(PARTNER_SCHEMA, data)
    if (schemaErrors.length > 0) {
      for (const e of schemaErrors)
        fail(where, e)
      continue
    }

    let valid = true
    if (`${data.name}.json` !== file) {
      fail(where, `"name" is ${JSON.stringify(data.name)}, expected the file to be named ${data.name}.json`)
      valid = false
    }
    if (data.revoked === true && !data.reason) {
      fail(where, 'revoked is true but there is no reason')
      valid = false
    }
    if (data.revoked !== true && data.reason) {
      fail(where, 'has a reason but revoked is not true')
      valid = false
    }

    try {
      const { id } = parsePublicKey(data.public_key)
      if (fileByKeyId.has(id)) {
        fail(where, `key ${id} is already listed in partners/${fileByKeyId.get(id)}`)
        valid = false
      }
      else {
        fileByKeyId.set(id, file)
      }
    }
    catch (err) {
      fail(where, `public_key: ${err.message}`)
      valid = false
    }

    if (valid)
      validCount += 1
  }

  if (validCount === files.length)
    ok(`${files.length} partner file(s) match schema/partner.schema.json with unique keys`)
}

/** The keyring builds from partners/ and matches its schema. Its
 * updated_at is settled against the published keyring at deploy time. */
function checkKeyring() {
  let keyring
  try {
    keyring = buildKeyring()
  }
  catch (err) {
    fail('partners/', `the keyring cannot be built: ${err.message}`)
    return
  }
  const schemaErrors = validateAgainstSchemaFile(KEYRING_SCHEMA, keyring)
  for (const e of schemaErrors)
    fail('partners/', `the keyring does not match schema/partners.schema.json: ${e}`)
  if (schemaErrors.length === 0)
    ok('the partner keyring builds and matches schema/partners.schema.json')
}

function main() {
  console.log(`nginxui/plugins validate (node ${process.version})\n`)

  const entries = validateEntries()
  checkIdUniqueness(entries)
  checkNamingPolicy(entries)
  checkAuthorKeys(entries)
  checkRepositories(entries)
  validatePartners()
  checkKeyring()

  console.log()
  if (errorCount > 0) {
    console.error(`${errorCount} error(s) found`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main()
