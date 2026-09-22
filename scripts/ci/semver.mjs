// A small SemVer 2.0.0 comparator, just enough for scripts/ci/poll-releases.mjs
// to decide whether a GitHub release is newer than the catalog's newest
// listed version. Pre-release versions (e.g. "1.0.0-rc.1") always sort below
// their release ("1.0.0"), matching semver.org precedence rule 11; build
// metadata ("+build") is ignored, also per the spec.

function parse(version) {
  const [main, prerelease] = version.split('+')[0].split('-', 2)
  const [major, minor, patch] = main.split('.').map(n => Number.parseInt(n, 10))
  return { major, minor, patch, prerelease: version.includes('-') ? prerelease : undefined }
}

/** Returns -1, 0 or 1, like Array.prototype.sort expects. */
export function compareSemver(a, b) {
  const pa = parse(a)
  const pb = parse(b)

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key])
      return pa[key] < pb[key] ? -1 : 1
  }

  if (pa.prerelease === pb.prerelease)
    return 0
  if (pa.prerelease === undefined)
    return 1 // a is a release, b is a prerelease of the same core version
  if (pb.prerelease === undefined)
    return -1
  return pa.prerelease < pb.prerelease ? -1 : 1
}
