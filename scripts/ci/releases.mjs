// Pure helpers for the release records scripts/build-catalog.mjs builds from
// GitHub Releases: versions, channels, ordering and notes. Kept apart from the
// network code so they can be tested on their own.

import { compareSemver } from './semver.mjs'

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

/** The releases of an entry ordered by semantic version, oldest first. */
export function sortReleases(releases) {
  return [...releases].sort((a, b) => compareSemver(a.version, b.version))
}

// Longest notes a catalog release carries, in characters.
export const MAX_NOTES_LENGTH = 4096
// Releases of a plugin whose notes the index keeps, the newest ones.
export const NOTES_KEPT = 5

/** The notes a catalog release carries for the body of a GitHub Release, or
 * undefined for an empty body. A longer body is cut at a line break and ends
 * with a link to the full notes. */
export function releaseNotes(body, url) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!text)
    return undefined
  if (text.length <= MAX_NOTES_LENGTH)
    return text
  const more = url ? `\n\n[Full release notes](${url})` : ''
  let cut = text.slice(0, MAX_NOTES_LENGTH - more.length)
  const lineEnd = cut.lastIndexOf('\n')
  if (lineEnd > 0)
    cut = cut.slice(0, lineEnd)
  return `${cut.trimEnd()}${more}`
}

/** The releases with notes left only on the NOTES_KEPT newest versions, so
 * the index stays small however long the history of a plugin grows. */
export function keepRecentNotes(releases, count = NOTES_KEPT) {
  const recent = new Set(sortReleases(releases).slice(-count).map(release => release.version))
  return releases.map((release) => {
    if (release.notes === undefined || recent.has(release.version))
      return release
    const { notes: _notes, ...rest } = release
    return rest
  })
}
