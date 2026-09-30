#!/usr/bin/env node
// Prints the URL of the package a host running <platform> would install for
// one plugins/<id>.json's newest release, following the same selection order
// as internal/plugin.CatalogRelease.DownloadFor in nginx-ui (RFC 0001
// PKG-15): downloads[platform], then downloads["any"], then the portable
// download_url when "platforms" is empty or covers the platform.
//
// Used by .github/workflows/validate.yml's lint-conformance job, which runs
// on a linux-amd64 GitHub Actions runner and needs one concrete package URL
// to download and lint — the same package a linux-amd64 nginx-ui host would
// actually install.
//
// Usage: node scripts/ci/select-download.mjs <plugins/id.json> <platform>
// Prints the selected URL and exits 0, or prints nothing and exits 1 when
// the release has no package for that platform.

import { readFileSync } from 'node:fs'
import { compareSemver } from './semver.mjs'

function newestRelease(entry) {
  return [...(entry.releases ?? [])].sort((a, b) => compareSemver(a.version, b.version)).at(-1)
}

/** Mirrors CatalogRelease.DownloadFor's selection order (PKG-15): the exact
 * platform, then "any", then the portable package if platforms allows it. */
export function selectDownloadUrl(release, platform) {
  for (const key of [platform, 'any']) {
    const download = release.downloads?.[key]
    if (download?.url)
      return download.url
  }
  if (!release.download_url)
    return null
  const platforms = release.platforms ?? []
  if (platforms.length === 0 || platforms.includes(platform) || platforms.includes('any'))
    return release.download_url
  return null
}

function main() {
  const [entryPath, platform] = process.argv.slice(2)
  if (!entryPath || !platform) {
    console.error('usage: node scripts/ci/select-download.mjs <plugins/id.json> <platform>')
    process.exit(2)
  }

  const entry = JSON.parse(readFileSync(entryPath, 'utf8'))
  const release = newestRelease(entry)
  if (!release) {
    console.error(`${entry.id}: no releases yet`)
    process.exit(1)
  }

  const url = selectDownloadUrl(release, platform)
  if (!url) {
    console.error(`${entry.id} ${release.version}: no package for platform ${platform}`)
    process.exit(1)
  }
  console.log(url)
}

if (import.meta.url === `file://${process.argv[1]}`)
  main()
