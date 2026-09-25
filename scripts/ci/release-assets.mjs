// Discovers a GitHub release's package assets — the portable
// "<id>-<version>.tar.gz" and/or the per-platform
// "<id>-<version>-<goos>-<goarch>.tar.gz" files RFC 0001 added — and turns
// the per-platform ones into a catalog release's "downloads" map. Shared by
// scripts/ci/poll-releases.mjs and scripts/ci/submit-issue.mjs so a release
// picked up automatically is shaped the same way whether it ships one
// package or one per platform.
//
// See nginx-ui-plugin-spec/spec/rfcs/0001-per-platform-packages.md and the
// packaging done by build.sh in a plugin such as nginx-ui-plugin-dns01.

const SHA256_HEX = /\b([0-9a-f]{64})\b/i

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches the per-platform archives build.sh writes for one id/version.
 * The captured group is the platform key, "<goos>-<goarch>". */
function perPlatformPattern(id, version) {
  return new RegExp(`^${escapeRegExp(id)}-${escapeRegExp(version)}-([a-z0-9]+-[a-z0-9]+)\\.tar\\.gz$`)
}

/** Finds the portable package asset, "<id>-<version>.tar.gz", or null when
 * this release does not publish one. */
export function findPortableAsset(assets, id, version) {
  return assets.find(a => a.name === `${id}-${version}.tar.gz`) ?? null
}

/** Finds every per-platform package asset for one id/version, keyed by
 * platform ("<goos>-<goarch>"). Empty when the release ships only the
 * portable package. */
export function findPlatformAssets(assets, id, version) {
  const pattern = perPlatformPattern(id, version)
  const byPlatform = new Map()
  for (const asset of assets) {
    const match = asset.name.match(pattern)
    if (match)
      byPlatform.set(match[1], asset)
  }
  return byPlatform
}

/** The sha256sum-style sidecar asset for a package asset ("<archive>.sha256"),
 * or null when not published. */
function findSha256Asset(assets, packageAsset) {
  return assets.find(a => a.name === `${packageAsset.name}.sha256`) ?? null
}

/** Reads the hex digest out of a fetched sha256sum-format file's text
 * ("<hex>  <filename>", what "sha256sum"/build.sh write), tolerating a bare
 * hex string too. Returns null when no digest could be found. */
export function parseSha256Text(text) {
  const match = text.match(SHA256_HEX)
  return match ? match[1].toLowerCase() : null
}

async function fetchAssetText(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const response = await fetch(url, { headers })
  if (!response.ok)
    throw new Error(`GET ${url}: HTTP ${response.status}`)
  return response.text()
}

/**
 * Builds the "downloads" map (RFC 0001 PKG-14) for a release from its GitHub
 * assets: one entry per per-platform archive found, each with its "url" and
 * the digest read from the archive's small ".sha256" sidecar asset. That is
 * the file nginx-ui-plugin-dns01/README.md's Packaging section describes as
 * feeding this map, so every platform's archive (tens of MiB) does not have
 * to be downloaded just to hash it here. The package signature is not part
 * of the map: it lives in plugin.sums.minisig inside each archive.
 *
 * Returns { downloads, platforms }; both are empty when no per-platform
 * asset is found (a webapp-only or interpreted plugin, or one that only
 * publishes the portable package).
 */
export async function buildDownloadsMap(assets, id, version, { token }) {
  const byPlatform = findPlatformAssets(assets, id, version)
  const platforms = [...byPlatform.keys()].sort()
  const downloads = {}

  for (const platform of platforms) {
    const asset = byPlatform.get(platform)
    const shaAsset = findSha256Asset(assets, asset)
    if (!shaAsset)
      throw new Error(`${asset.name}: release has no matching .sha256 asset`)
    const digest = parseSha256Text(await fetchAssetText(shaAsset.browser_download_url, token))
    if (!digest)
      throw new Error(`${shaAsset.name}: could not parse a sha256 digest from its contents`)

    downloads[platform] = { url: asset.browser_download_url, sha256: digest }
  }

  return { downloads, platforms }
}
