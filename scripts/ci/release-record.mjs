// Turns a GitHub Release into the release record of the catalog: the
// per-platform packages ("<id>-<version>-<goos>-<goarch>.tar.gz") with the
// digests of their ".sha256" assets, the portable package
// ("<id>-<version>.tar.gz") when published, the manifest snapshot of the tag,
// the notes and the channel. Used by scripts/build-catalog.mjs.

import { createHash } from 'node:crypto'
import { downloadBinary, fetchRawFile } from './github.mjs'
import { platformsFromManifest, trimManifestSnapshot } from './manifest-snapshot.mjs'
import { assetDigest, buildDownloadsMap, findPortableAsset } from './release-assets.mjs'
import { channelToSet, releaseNotes, tagVersion } from './releases.mjs'

/** The release record of a GitHub Release with the dns01 providers its
 * plugin.json declares, as { release, dns01 }, or null after saying why it was
 * skipped. The digests are the ones GitHub computed for the assets; only an
 * older portable package without one is downloaded to hash it. */
export async function releaseFromGithub(entry, repo, ghRelease, token, warn = console.warn) {
  const version = tagVersion(ghRelease.tag_name)

  const manifestText = await fetchRawFile(repo.owner, repo.repo, ghRelease.tag_name, 'plugin.json', token)
  if (!manifestText) {
    warn(`${entry.id} ${version}: plugin.json not found at ${repo.owner}/${repo.repo}@${ghRelease.tag_name}, skipping`)
    return null
  }
  const manifest = JSON.parse(manifestText)
  if (manifest.id !== entry.id) {
    warn(`${entry.id} ${version}: plugin.json id ${JSON.stringify(manifest.id)} is not the catalog id, skipping`)
    return null
  }
  // A host refuses a package whose manifest version is not the catalog one.
  if (manifest.version !== undefined && manifest.version !== version) {
    warn(`${entry.id} ${version}: plugin.json version ${JSON.stringify(manifest.version)} does not match tag ${ghRelease.tag_name}, skipping`)
    return null
  }

  const portableAsset = findPortableAsset(ghRelease.assets, entry.id, version)
  const { downloads } = await buildDownloadsMap(ghRelease.assets, entry.id, version, { token })
  if (!portableAsset && Object.keys(downloads).length === 0) {
    warn(`${entry.id} ${version}: no ${entry.id}-${version}.tar.gz or per-platform package on ${ghRelease.html_url}, skipping`)
    return null
  }

  let downloadUrl, sha256
  if (portableAsset) {
    downloadUrl = portableAsset.browser_download_url
    sha256 = assetDigest(portableAsset)
      ?? createHash('sha256').update(await downloadBinary(downloadUrl, token)).digest('hex')
  }

  const release = {
    version,
    released_at: ghRelease.published_at ?? ghRelease.created_at,
    api_version: manifest.api_version,
    ...(manifest.min_nginx_ui_version ? { min_nginx_ui_version: manifest.min_nginx_ui_version } : {}),
    platforms: platformsFromManifest(manifest),
    ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
    ...(downloadUrl ? { download_url: downloadUrl } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...releaseText(ghRelease),
    manifest: trimManifestSnapshot(manifest),
  }
  const dns01 = (manifest.dns01?.providers ?? []).map(({ code, name }) => ({ code, name }))
  return { release, dns01 }
}

/** The members of a release record that follow the GitHub Release on every
 * build: its page, its notes and its channel. */
export function releaseText(ghRelease) {
  const version = tagVersion(ghRelease.tag_name)
  const notes = releaseNotes(ghRelease.body, ghRelease.html_url)
  // Only a prerelease that reads as stable by its version needs a channel,
  // a host infers the channel of every other version.
  const channel = channelToSet(version, ghRelease)
  return {
    release_notes_url: ghRelease.html_url,
    ...(notes ? { notes } : {}),
    ...(channel ? { channel } : {}),
  }
}

/** The digests a published release record pins that the GitHub Release now
 * contradicts, as "<package>: <pinned> -> <current>" lines. A portable
 * package is compared when GitHub knows its digest. */
export async function changedDigests(entry, published, ghRelease, token) {
  const changes = []
  if (published.download_url) {
    const portable = findPortableAsset(ghRelease.assets, entry.id, published.version)
    const current = portable && assetDigest(portable)
    if (!portable)
      changes.push(`portable: ${published.sha256} -> the package is gone`)
    else if (current && current !== published.sha256)
      changes.push(`portable: ${published.sha256} -> ${current}`)
  }
  const pinned = published.downloads ?? {}
  if (Object.keys(pinned).length === 0)
    return changes
  const { downloads } = await buildDownloadsMap(ghRelease.assets, entry.id, published.version, { token })
  for (const [platform, download] of Object.entries(pinned)) {
    const current = downloads[platform]
    if (!current)
      changes.push(`${platform}: ${download.sha256} -> the package is gone`)
    else if (current.sha256 !== download.sha256)
      changes.push(`${platform}: ${download.sha256} -> ${current.sha256}`)
    else if (current.url !== download.url)
      changes.push(`${platform}: ${download.url} -> ${current.url}`)
  }
  return changes
}
