#!/usr/bin/env node
// Builds the site Cloudflare Pages serves at plugins.nginxui.com: the pages
// listing the plugins (scripts/site.mjs), the catalog v1/index.json, the
// partner keyring v1/partners.json, the schemas of this repository and of
// plugin-spec, the assets and _headers. Both documents are
// checked against the schemas of plugin-spec ($PLUGIN_SPEC_DIR or a checkout
// next to this repository). Nothing it writes is committed.
//
// The releases of each plugins/<id>.json come from the GitHub Releases of its
// repository_url. The published catalog is the record of what was listed
// before: a release it lists keeps its packages and digests, and the build
// fails when GitHub now serves other digests for it. A release it does not
// list yet is checked first (scripts/ci/verify-release.mjs) and left out when
// a package does not verify.
//
// Usage: node scripts/build-catalog.mjs [--out <dir>] [--published <url>|none]
//          [--first-deploy] [--only <plugins/id.json>]... [--verify-newest]
//          [--failures <file>]
//
//   --out <dir>        write the site there, default dist
//   --published <url>  the site to read the published catalog and keyring
//                      from, default $CATALOG_URL or https://plugins.nginxui.com.
//                      A directory reads a site built before. "none" builds
//                      without one, for a local build or a pull request.
//   --first-deploy     builds without the published catalog for the first
//                      deploy, and fails when the site already serves one: a
//                      deploy that skipped the published catalog would no
//                      longer pin its packages.
//   --repin <id>@<version>
//                      reads that listed release again as if it were new:
//                      its packages are verified and pinned anew. Only for a
//                      release rebuilt on purpose, the build fails when the
//                      published catalog does not list it.
//   --only <file>      build these entries only, for checking a pull request
//   --verify-newest    also check the newest release of every built entry
//                      when the published catalog already lists it
//   --failures <file>  remembers the releases that were left out, so one is
//                      only read again once the release, its packages or the
//                      key it is checked against change. CI keeps the file in
//                      its cache.
//
// Env: GITHUB_TOKEN (raises the API rate limit), PLUGIN_SIGNING_PUBLIC_KEY (the
// official plugin key, see verify-release.mjs). Writes changed=true|false to
// $GITHUB_OUTPUT: whether the catalog or the keyring differ from the
// published ones.

import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildKeyring, serializeKeyring } from './build-partners.mjs'
import { listReleases, parseGithubRepoUrl } from './ci/github.mjs'
import { changedDigests, releaseFromGithub, releaseText } from './ci/release-record.mjs'
import { assetDigest, findPlatformAssets, findPortableAsset } from './ci/release-assets.mjs'
import { inferChannel, keepRecentNotes, sortReleases, tagVersion } from './ci/releases.mjs'
import { compareSemver, isSemver } from './ci/semver.mjs'
import { verifyRelease } from './ci/verify-release.mjs'
import { validateAgainstSchemaFile } from './lib/schema-validator.mjs'
import { SPEC_SCHEMAS, specSchema } from './lib/spec.mjs'
import { renderSite } from './site.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const DEFAULT_SITE = 'https://plugins.nginxui.com'
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
// Files and directories of the repository the site serves as they are.
const STATIC = ['schema', 'assets', '_headers']
// With a 404.html Cloudflare Pages answers a missing path with 404 instead of
// treating the site as a single page app.
const NOT_FOUND = '<!doctype html>\n<meta charset="utf-8">\n<title>Not found</title>\n<p>Not found. <a href="/">Nginx UI Plugins</a></p>\n'

/** Reads plugins/*.json, sorted by id. Throws on invalid JSON, a file not
 * named <id>.json or a duplicate id; scripts/validate.mjs explains the rest. */
export function loadEntries(only = []) {
  const files = only.length > 0
    ? only.map(file => path.basename(file))
    : readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.json')).sort()
  const entries = []
  const seen = new Set()
  for (const file of files) {
    let entry
    try {
      entry = JSON.parse(readFileSync(path.join(PLUGINS_DIR, file), 'utf8'))
    }
    catch (err) {
      throw new Error(`plugins/${file}: ${err.message}`)
    }
    if (file !== `${entry.id}.json`)
      throw new Error(`plugins/${file}: "id" is ${JSON.stringify(entry.id)}, expected the file to be named ${entry.id}.json`)
    if (seen.has(entry.id))
      throw new Error(`duplicate plugin id ${JSON.stringify(entry.id)}`)
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The newest released_at of every release, so the same releases always
 * build the same document. */
export function newestReleaseTimestamp(plugins) {
  let newest = ''
  for (const plugin of plugins) {
    for (const release of plugin.releases ?? []) {
      if (release.released_at && release.released_at > newest)
        newest = release.released_at
    }
  }
  return newest
}

/** GET a JSON document of the published site. null when the site answers 404,
 * a throw on any other failure: building without the published catalog would
 * drop the digests it pins. */
async function fetchPublished(site, file) {
  if (!/^https?:\/\//.test(site)) {
    const local = path.join(site, file)
    return existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')) : null
  }
  const url = `${site.replace(/\/+$/, '')}/${file}`
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`GET ${url}: HTTP ${response.status}`)
  return response.json()
}

/** Whether the site serves a catalog. An unreachable site or one without a
 * deployment does not; any answer with a document does. */
async function servesCatalog(site) {
  try {
    const response = await fetch(`${site.replace(/\/+$/, '')}/v1/index.json`, { headers: { 'Cache-Control': 'no-cache' } })
    return response.ok
  }
  catch {
    return false
  }
}

/** What reading and verifying a GitHub Release depends on: the release
 * itself (an edit moves its updated_at), its packages and the key the entry is
 * checked against. Taken from the release listing alone, so a release that
 * failed before costs no request until one of them changes. */
function releaseFingerprint(entry, ghRelease, version) {
  const portable = findPortableAsset(ghRelease.assets, entry.id, version)
  const packages = [...(portable ? [portable] : []), ...findPlatformAssets(ghRelease.assets, entry.id, version).values()]
    .map(asset => [asset.name, assetDigest(asset) ?? `${asset.id}:${asset.updated_at}`])
    .sort()
  const keys = [entry.trust, entry.author_public_key ?? '', process.env.PLUGIN_SIGNING_PUBLIC_KEY ?? '']
  return createHash('sha256').update(JSON.stringify([ghRelease.updated_at ?? '', packages, keys])).digest('hex')
}

/**
 * The releases of one entry. published is the entry of the published catalog
 * or undefined. failed maps "<id>@<version>" to the fingerprint of a
 * release that was left out and is updated in place. Returns
 * { releases, provides, failures }: failures are reasons the build must stop
 * for, a new release that cannot be read or does not verify is only left out.
 */
async function entryReleases(entry, published, { token, verifyNewest, failed, visited, repin }) {
  const failures = []
  const pinned = new Map((published?.releases ?? []).map(release => [release.version, release]))
  for (const version of pinned.keys()) {
    if (repin.delete(`${entry.id}@${version}`)) {
      console.warn(`::warning title=${entry.id}::${version} is read again, its packages are pinned anew`)
      pinned.delete(version)
    }
  }
  const repo = parseGithubRepoUrl(entry.repository_url)
  if (!repo) {
    failures.push(`${entry.id}: repository_url ${JSON.stringify(entry.repository_url)} is not a github.com repository`)
    return { releases: [], failures }
  }

  let ghReleases
  try {
    ghReleases = await listReleases(repo.owner, repo.repo, token)
  }
  catch (err) {
    // Keep what is listed rather than emptying the entry over a network error.
    console.warn(`::warning title=${entry.id}::cannot list the releases of ${repo.owner}/${repo.repo}, keeping the published ones: ${err.message}`)
    return { releases: [...pinned.values()], provides: published?.provides, failures }
  }

  const releases = []
  const seen = new Set()
  // The dns01 providers of every release read from GitHub in this build.
  const declared = new Map()
  for (const ghRelease of ghReleases) {
    const version = tagVersion(ghRelease.tag_name)
    if (!isSemver(version) || seen.has(version))
      continue
    seen.add(version)

    const listed = pinned.get(version)
    if (listed) {
      const changes = await changedDigests(entry, listed, ghRelease, token)
      if (changes.length > 0) {
        failures.push(`${entry.id} ${version}: the published catalog pins other packages than ${ghRelease.html_url} now serves:\n  ${changes.join('\n  ')}`)
        continue
      }
      const { notes: _notes, channel: _channel, ...kept } = listed
      releases.push({ ...kept, ...releaseText(ghRelease) })
      continue
    }

    const key = `${entry.id}@${version}`
    visited.add(key)
    const fingerprint = releaseFingerprint(entry, ghRelease, version)
    if (failed[key] === fingerprint) {
      console.warn(`::warning title=${entry.id}::${version} is left out, it failed before and neither the release nor the key changed`)
      continue
    }
    const built = await releaseFromGithub(entry, repo, ghRelease, token, message => console.warn(`::warning title=${entry.id}::${message}`))
    if (!built) {
      failed[key] = fingerprint
      continue
    }
    const record = built.release
    if (!await verifyRelease(entry, record)) {
      failed[key] = fingerprint
      console.warn(`::warning title=${entry.id}::${version} is left out, a package does not verify`)
      continue
    }
    delete failed[key]
    releases.push(record)
    declared.set(version, built.dns01)
  }

  const sorted = sortReleases(releases)
  const newest = sorted.at(-1)
  if (verifyNewest && newest && pinned.has(newest.version) && !await verifyRelease(entry, newest))
    failures.push(`${entry.id} ${newest.version}: a package does not verify`)

  const yanked = new Set(entry.yanked ?? [])
  for (const release of sorted) {
    if (yanked.has(release.version))
      release.yanked = true
    else
      delete release.yanked
  }
  return { releases: keepRecentNotes(sorted).map(ordered), provides: providesOf(sorted, declared, published?.provides), failures }
}

/** Whether a published provides lists code as present in version. */
function publishedPresence(published) {
  const dns01 = published?.dns01
  const ranges = new Map((dns01?.providers ?? []).map(provider => [provider.code, {
    name: provider.name,
    since: provider.since ?? dns01.since,
    removedIn: provider.removed_in,
  }]))
  return {
    ranges,
    has(code, version) {
      const range = ranges.get(code)
      return Boolean(range) && compareSemver(range.since, version) <= 0
        && (!range.removedIn || compareSemver(version, range.removedIn) < 0)
    },
  }
}

function isStable(release) {
  return !release.yanked && (release.channel ?? inferChannel(release.version)) === 'stable'
}

/**
 * The dns01 providers of the plugin. A provider is listed from the newest
 * unbroken run of releases that declare it: since is the first release of
 * the run, removed_in the release after it when the run stops before the
 * newest. A dropped provider stays listed only while the newest stable
 * release still has it. dns01.since is the earliest since, and a provider
 * repeats its since only when it differs. declared holds the providers of
 * the releases read in this build; for the others the published provides
 * tells.
 */
export function providesOf(releases, declared, published) {
  if (releases.length === 0)
    return undefined
  const previous = publishedPresence(published)
  const names = new Map([...previous.ranges].map(([code, range]) => [code, range.name]))
  for (const release of releases) {
    for (const provider of declared.get(release.version) ?? [])
      names.set(provider.code, provider.name)
  }
  const has = (code, release) => {
    const codes = declared.get(release.version)
    return codes ? codes.some(provider => provider.code === code) : previous.has(code, release.version)
  }
  const newestStable = releases.findLast(isStable)

  const providers = []
  for (const [code, name] of names) {
    let last = releases.length - 1
    while (last >= 0 && !has(code, releases[last]))
      last--
    if (last < 0)
      continue
    let first = last
    while (first > 0 && has(code, releases[first - 1]))
      first--
    const removedIn = releases[last + 1]?.version
    if (removedIn && newestStable && compareSemver(newestStable.version, removedIn) >= 0)
      continue
    providers.push({ code, name, since: releases[first].version, ...(removedIn ? { removed_in: removedIn } : {}) })
  }
  if (providers.length === 0)
    return undefined

  providers.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const since = providers.map(provider => provider.since).reduce((a, b) => (compareSemver(a, b) <= 0 ? a : b))
  return {
    dns01: {
      since,
      providers: providers.map(({ since: own, ...provider }) => (own === since
        ? provider
        : { code: provider.code, name: provider.name, since: own, ...(provider.removed_in ? { removed_in: provider.removed_in } : {}) })),
    },
  }
}

// Member order of a release record, so a kept and a new record serialize alike.
const RELEASE_KEYS = ['version', 'released_at', 'api_version', 'min_nginx_ui_version', 'platforms', 'downloads', 'download_url', 'sha256', 'release_notes_url', 'notes', 'yanked', 'channel', 'manifest']

function ordered(release) {
  const out = {}
  for (const key of RELEASE_KEYS) {
    if (release[key] !== undefined)
      out[key] = release[key]
  }
  return out
}

/** The catalog entry: the source entry without yanked, with what it provides
 * and its releases. */
function catalogEntry(entry, releases, provides) {
  const { yanked: _yanked, ...rest } = entry
  return { ...rest, ...(provides ? { provides } : {}), releases }
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

async function main() {
  const { values } = parseArgs({
    options: {
      'out': { type: 'string', default: 'dist' },
      'published': { type: 'string', default: process.env.CATALOG_URL || DEFAULT_SITE },
      'only': { type: 'string', multiple: true, default: [] },
      'verify-newest': { type: 'boolean', default: false },
      'failures': { type: 'string' },
      'first-deploy': { type: 'boolean', default: false },
      'repin': { type: 'string', multiple: true, default: [] },
    },
  })
  const repin = new Set(values.repin)
  if (values['first-deploy']) {
    if (await servesCatalog(values.published))
      throw new Error(`${values.published} already serves a catalog; --first-deploy only builds the first one`)
    values.published = 'none'
  }
  const failuresFile = values.failures ? path.resolve(values.failures) : null
  const failed = failuresFile && existsSync(failuresFile) ? JSON.parse(readFileSync(failuresFile, 'utf8')) : {}
  const visited = new Set()
  const token = process.env.GITHUB_TOKEN
  const site = values.published === 'none' ? null : values.published

  const publishedIndex = site ? await fetchPublished(site, 'v1/index.json') : null
  const publishedKeyring = site ? await fetchPublished(site, 'v1/partners.json') : null
  console.log(site
    ? `published catalog: ${publishedIndex ? `${publishedIndex.plugins.length} plugin(s)` : 'none yet'} at ${site}`
    : 'building without a published catalog')
  const publishedById = new Map((publishedIndex?.plugins ?? []).map(plugin => [plugin.id, plugin]))

  const plugins = []
  const failures = []
  for (const entry of loadEntries(values.only)) {
    const result = await entryReleases(entry, publishedById.get(entry.id), { token, verifyNewest: values['verify-newest'], failed, visited, repin })
    failures.push(...result.failures)
    plugins.push(catalogEntry(entry, result.releases, result.provides))
    console.log(`${entry.id}: ${result.releases.map(release => release.version).join(', ') || 'no release'}`)
  }

  for (const release of repin)
    failures.push(`--repin ${release}: the published catalog lists no such release`)

  // Key order is fixed, so the same sources and releases build the same bytes.
  const index = { schema_version: SCHEMA_VERSION, name: CATALOG_NAME, icon: CATALOG_ICON }
  const updatedAt = newestReleaseTimestamp(plugins)
  if (updatedAt)
    index.updated_at = updatedAt
  index.plugins = plugins
  const keyring = buildKeyring(publishedKeyring)

  // The documents follow the contract in plugin-spec.
  for (const error of validateAgainstSchemaFile(specSchema('catalog.schema.json'), index))
    failures.push(`v1/index.json: ${error}`)
  for (const error of validateAgainstSchemaFile(specSchema('partners.schema.json'), keyring))
    failures.push(`v1/partners.json: ${error}`)

  if (failuresFile) {
    // A full build forgets the releases that are gone.
    if (values.only.length === 0) {
      for (const key of Object.keys(failed)) {
        if (!visited.has(key))
          delete failed[key]
      }
    }
    mkdirSync(path.dirname(failuresFile), { recursive: true })
    writeFileSync(failuresFile, `${JSON.stringify(failed, null, 2)}\n`)
  }

  if (failures.length > 0) {
    for (const failure of failures)
      console.error(`::error::${failure}`)
    process.exit(1)
  }

  const out = path.resolve(values.out)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(path.join(out, 'v1'), { recursive: true })
  for (const item of STATIC) {
    if (existsSync(path.join(ROOT, item)))
      cpSync(path.join(ROOT, item), path.join(out, item), { recursive: true })
  }
  for (const name of SPEC_SCHEMAS)
    cpSync(specSchema(name), path.join(out, 'schema', name))
  writeFileSync(path.join(out, '404.html'), NOT_FOUND)
  for (const [file, html] of renderSite(index)) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true })
    writeFileSync(path.join(out, file), html)
  }
  writeFileSync(path.join(out, 'v1', 'index.json'), serialize(index))
  writeFileSync(path.join(out, 'v1', 'partners.json'), serializeKeyring(keyring))

  const changed = JSON.stringify(index) !== JSON.stringify(publishedIndex)
    || JSON.stringify(keyring) !== JSON.stringify(publishedKeyring)
  console.log(`wrote ${out} (${plugins.length} plugin(s), ${changed ? 'changed' : 'unchanged'})`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message || err)
    process.exit(1)
  })
}
