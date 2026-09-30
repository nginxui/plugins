// Decides which GitHub Releases a catalog entry still lacks and which release
// channel a new catalog release gets (RFC 0019, PKG-28). Pure functions, kept
// apart from scripts/ci/poll-releases.mjs so they can be tested without the
// network.

import { compareSemver, isSemver } from './semver.mjs'

// Prerelease identifiers that put a version on the dev channel.
const DEV_IDENTIFIERS = new Set(['alpha', 'dev', 'nightly', 'snapshot', 'canary', 'preview'])

/** The version a GitHub tag stands for: the tag without a leading "v". */
export function tagVersion(tagName) {
  return String(tagName).replace(/^v/, '')
}

/** The channel a host infers from a version alone: stable without a
 * prerelease part, dev for a prerelease whose first identifier is one of
 * DEV_IDENTIFIERS (case-insensitive), beta for any other prerelease. */
export function inferChannel(version) {
  const match = /^[^+-]+-([^+]+)/.exec(String(version))
  if (!match)
    return 'stable'
  const first = match[1].split('.')[0].toLowerCase()
  return DEV_IDENTIFIERS.has(first) ? 'dev' : 'beta'
}

/** The "channel" member a new catalog release needs, or undefined when the
 * host infers the right one from the version. GitHub marking a release as a
 * prerelease whose version reads as stable puts it on the beta channel. */
export function channelToSet(version, ghRelease) {
  if (ghRelease.prerelease && inferChannel(version) === 'stable')
    return 'beta'
  return undefined
}

/** The GitHub Releases the entry does not list yet: no drafts, a valid
 * semantic version in the tag, one per version, oldest first. */
export function missingReleases(entry, ghReleases, warn = () => {}) {
  const listed = new Set((entry.releases ?? []).map(release => release.version))
  const seen = new Set()
  const missing = []
  for (const ghRelease of ghReleases) {
    if (ghRelease.draft)
      continue
    const version = tagVersion(ghRelease.tag_name)
    if (!isSemver(version)) {
      warn(`  skipping tag ${ghRelease.tag_name}: not a semantic version`)
      continue
    }
    if (listed.has(version) || seen.has(version))
      continue
    seen.add(version)
    missing.push(ghRelease)
  }
  return missing.sort((a, b) => compareSemver(tagVersion(a.tag_name), tagVersion(b.tag_name)))
}

/** The releases of an entry ordered by semantic version, oldest first. */
export function sortReleases(releases) {
  return [...releases].sort((a, b) => compareSemver(a.version, b.version))
}
