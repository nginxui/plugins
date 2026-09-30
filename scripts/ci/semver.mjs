// A small SemVer 2.0.0 comparator, just enough for the scripts under
// scripts/ci/ to order the versions of a catalog entry. Precedence follows
// semver.org: a release sorts after its own prereleases (rule 11), prerelease
// identifiers are compared left to right with numeric ones as numbers, so
// "1.1.0-beta.10" follows "1.1.0-beta.9", and build metadata ("+build") is
// ignored.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** True for a valid semantic version without a leading "v". */
export function isSemver(version) {
  return SEMVER.test(String(version))
}

function parse(version) {
  const match = SEMVER.exec(String(version))
  if (!match)
    throw new Error(`not a semantic version: ${JSON.stringify(version)}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(a, b) {
  // No prerelease part outranks any prerelease of the same core version.
  if (a.length === 0 || b.length === 0)
    return a.length === b.length ? 0 : (a.length === 0 ? 1 : -1)

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i])
      continue
    const aNumeric = /^\d+$/.test(a[i])
    const bNumeric = /^\d+$/.test(b[i])
    if (aNumeric && bNumeric)
      return Number(a[i]) < Number(b[i]) ? -1 : 1
    // Numeric identifiers rank below alphanumeric ones.
    if (aNumeric !== bNumeric)
      return aNumeric ? -1 : 1
    return a[i] < b[i] ? -1 : 1
  }
  return Math.sign(a.length - b.length)
}

/** Returns -1, 0 or 1, like Array.prototype.sort expects. */
export function compareSemver(a, b) {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i])
      return pa.core[i] < pb.core[i] ? -1 : 1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}
