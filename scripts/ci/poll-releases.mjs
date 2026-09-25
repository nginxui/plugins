#!/usr/bin/env node
// Checks every plugins/<id>.json with a github.com repository_url for a
// GitHub Release newer than the catalog's newest listed version, and if
// found, appends a new releases[] entry (never rewrites an existing one).
// Driven every 6 hours by .github/workflows/poll-releases.yml, which opens a
// pull request for whatever this script changed on disk.
//
// Usage: node scripts/ci/poll-releases.mjs
// Env:   GITHUB_TOKEN  raises the GitHub API rate limit, required in
//                       practice (60 unauthenticated requests/hour is not
//                       enough for a catalog of any size).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseGithubRepoUrl, getLatestRelease, fetchRawFile, downloadBinary } from './github.mjs'
import { platformsFromManifest, trimManifestSnapshot } from './manifest-snapshot.mjs'
import { findPortableAsset, buildDownloadsMap } from './release-assets.mjs'
import { compareSemver } from './semver.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

function newestRelease(entry) {
  return [...(entry.releases ?? [])].sort((a, b) => compareSemver(a.version, b.version)).at(-1)
}

/**
 * Builds a new releases[] entry from a GitHub Release: the portable package
 * ("<id>-<version>.tar.gz") when published, the per-platform packages RFC
 * 0001 added ("<id>-<version>-<goos>-<goarch>.tar.gz") when published, or
 * both — a release may ship either form, or one of each.
 */
async function buildNewRelease(entry, ghRelease, manifest, token) {
  const version = ghRelease.tag_name.replace(/^v/, '')
  // The signature travels inside each package (plugin.sums.minisig), so the
  // entry only records the sha256 of every archive as a download check.
  const portableAsset = findPortableAsset(ghRelease.assets, entry.id, version)
  const { downloads } = await buildDownloadsMap(ghRelease.assets, entry.id, version, { token })

  if (!portableAsset && Object.keys(downloads).length === 0) {
    console.warn(`  no ${entry.id}-${version}.tar.gz or per-platform package found on ${ghRelease.html_url}, skipping`)
    return null
  }

  let downloadUrl, sha256
  if (portableAsset) {
    downloadUrl = portableAsset.browser_download_url
    const bytes = await downloadBinary(portableAsset.browser_download_url, token)
    sha256 = createHash('sha256').update(bytes).digest('hex')
  }

  return {
    version,
    released_at: ghRelease.published_at ?? ghRelease.created_at,
    api_version: manifest.api_version,
    ...(manifest.min_nginx_ui_version ? { min_nginx_ui_version: manifest.min_nginx_ui_version } : {}),
    platforms: platformsFromManifest(manifest),
    ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
    ...(downloadUrl ? { download_url: downloadUrl } : {}),
    ...(sha256 ? { sha256 } : {}),
    release_notes_url: ghRelease.html_url,
    manifest: trimManifestSnapshot(manifest),
  }
}

async function processEntry(file, token) {
  const full = path.join(PLUGINS_DIR, file)
  const entry = JSON.parse(readFileSync(full, 'utf8'))

  const repo = parseGithubRepoUrl(entry.repository_url)
  if (!repo)
    return false

  const ghRelease = await getLatestRelease(repo.owner, repo.repo, token)
  if (!ghRelease || ghRelease.draft || ghRelease.prerelease)
    return false

  const tagVersion = ghRelease.tag_name.replace(/^v/, '')
  const current = newestRelease(entry)
  if (current && compareSemver(tagVersion, current.version) <= 0)
    return false

  console.log(`${entry.id}: ${current?.version ?? '(none)'} -> ${tagVersion}`)

  const manifestText = await fetchRawFile(repo.owner, repo.repo, ghRelease.tag_name, 'plugin.json', token)
  if (!manifestText) {
    console.warn(`  plugin.json not found at ${repo.owner}/${repo.repo}@${ghRelease.tag_name}, skipping`)
    return false
  }
  const manifest = JSON.parse(manifestText)
  if (manifest.id !== entry.id) {
    console.warn(`  plugin.json id ${JSON.stringify(manifest.id)} does not match catalog id ${JSON.stringify(entry.id)}, skipping`)
    return false
  }

  const release = await buildNewRelease(entry, ghRelease, manifest, token)
  if (!release)
    return false

  entry.releases = [...(entry.releases ?? []), release]
  writeFileSync(full, `${JSON.stringify(entry, null, 2)}\n`)
  console.log(`  wrote plugins/${file} with release ${release.version}`)
  return true
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  const files = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.json')).sort()

  const updated = []
  for (const file of files) {
    try {
      if (await processEntry(file, token))
        updated.push(file)
    }
    catch (err) {
      console.error(`${file}: ${err.stack || err.message}`)
    }
  }

  console.log(updated.length > 0 ? `updated: ${updated.join(', ')}` : 'nothing to update')

  const outputFile = process.env.GITHUB_OUTPUT
  if (outputFile) {
    const fs = await import('node:fs')
    fs.appendFileSync(outputFile, `updated=${updated.length > 0}\n`)
    fs.appendFileSync(outputFile, `updated_ids=${updated.map(f => f.replace(/\.json$/, '')).join(', ')}\n`)
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
