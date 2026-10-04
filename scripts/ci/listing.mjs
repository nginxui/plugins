// Derives what a catalog entry shows from the release it is listed with, so
// an author changes the listing by publishing a release. The display release
// is the newest stable release that is not yanked, else the newest one that
// is not yanked. From it come:
//
// - name: the translations of the manifest; the English name stays the one of
//   plugins/<id>.json, a new name goes through review.
// - description: the manifest's, English and translations.
// - homepage_url and capabilities: the manifest's.
// - readme_url: README.md at the tag, when it exists.
// - screenshots: the manifest's, read from the repository at the tag, the
//   ones that answer as an image of at most 2 MB.
// - icon_url: the icon inside the package, which the catalog serves.
//
// Whatever plugins/<id>.json sets wins: for name and description per
// language, for the other fields as a whole. Used by scripts/build-catalog.mjs.

import { inferChannel } from './releases.mjs'

// Image types and the largest screenshot a listing shows.
const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
// Content types of the icons the catalog serves.
export const ICON_CONTENT_TYPES = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' }

/** The release a listing is derived from, undefined without one. */
export function displayRelease(releases) {
  const offered = releases.filter(release => !release.yanked)
  return offered.findLast(release => (release.channel ?? inferChannel(release.version)) === 'stable') ?? offered.at(-1)
}

/** The path of an icon the catalog serves for a release. */
export function iconPath(id, version, type) {
  return `v1/icons/${id}/${version}.${type}`
}

function rawUrl(repo, tag, file) {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(tag)}/${file.split('/').map(encodeURIComponent).join('/')}`
}

/** The locale map of a manifest text: en from the top level, the others from
 * i18n, empty translations left out. */
function localized(english, translations) {
  const map = english ? { en: english } : {}
  for (const [locale, text] of Object.entries(translations ?? {})) {
    if (locale !== 'en' && text)
      map[locale] = text
  }
  return map
}

/** A locale map with en first and the other languages in order, so the same
 * texts always serialize alike. */
function sortedLocales(map) {
  const locales = Object.keys(map).filter(locale => locale !== 'en').sort()
  return Object.fromEntries([...(map.en !== undefined ? ['en'] : []), ...locales].map(locale => [locale, map[locale]]))
}

/** HEAD a URL, null when it cannot be reached. */
async function head(url) {
  try {
    return await fetch(url, { method: 'HEAD', redirect: 'follow' })
  }
  catch {
    return null
  }
}

/** Why an image cannot be listed, empty when it can. */
async function imageProblem(url) {
  const response = await head(url)
  if (!response?.ok)
    return `${url} answers ${response ? `HTTP ${response.status}` : 'nothing'}`
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!SCREENSHOT_TYPES.includes(type))
    return `${url} is ${type || 'of no type'}, not PNG, JPEG or WebP`
  const length = Number(response.headers.get('content-length'))
  if (length > MAX_SCREENSHOT_BYTES)
    return `${url} is ${length} bytes, more than ${MAX_SCREENSHOT_BYTES}`
  return ''
}

/** The screenshots of a manifest snapshot as catalog screenshots. */
function manifestScreenshots(manifest, repo, tag) {
  return (manifest.screenshots ?? []).slice(0, 8).map((shot) => {
    const captions = Object.fromEntries(Object.entries(manifest.i18n ?? {}).map(([locale, text]) => [locale, text?.screenshot_captions?.[shot.id]]))
    const caption = sortedLocales(localized(shot.caption, captions))
    return {
      url: rawUrl(repo, tag, shot.path),
      ...(shot.dark_path ? { dark_url: rawUrl(repo, tag, shot.dark_path) } : {}),
      ...(Object.keys(caption).length > 0 ? { caption } : {}),
    }
  })
}

/**
 * The fields a catalog entry shows. entry is plugins/<id>.json, releases the
 * built releases, published the published entry or undefined. tags maps a
 * version to its tag, icons maps a version verified in this build to the icon
 * of its package, site is where the catalog is served. Returns
 * { fields, icon, warnings }: icon is { path, bytes } to serve, or
 * { version, candidates } for the paths to carry over from the published site,
 * which then also give icon_url when the entry sets none.
 */
export async function deriveListing(entry, releases, published, { repo, tags, icons, site }) {
  const warnings = []
  const shown = displayRelease(releases)
  const manifest = shown?.manifest ?? {}
  const tag = shown ? tags.get(shown.version) : undefined
  const fields = {}

  fields.name = sortedLocales({
    ...localized(undefined, Object.fromEntries(Object.entries(manifest.i18n ?? {}).map(([locale, text]) => [locale, text?.name]))),
    ...entry.name,
  })
  fields.description = sortedLocales({
    ...localized(manifest.description, Object.fromEntries(Object.entries(manifest.i18n ?? {}).map(([locale, text]) => [locale, text?.description]))),
    ...entry.description,
  })
  if (!fields.description.en) {
    warnings.push(`${entry.id}: no English description in plugins/${entry.id}.json or the plugin.json of its release`)
    delete fields.description
  }

  const homepage = entry.homepage_url ?? manifest.homepage_url
  if (homepage)
    fields.homepage_url = homepage
  const capabilities = entry.capabilities ?? manifest.capabilities
  if (capabilities?.length)
    fields.capabilities = capabilities

  if (entry.readme_url) {
    fields.readme_url = entry.readme_url
  }
  else if (repo && tag) {
    const readme = rawUrl(repo, tag, 'README.md')
    if (readme === published?.readme_url || (await head(readme))?.ok)
      fields.readme_url = readme
    else
      warnings.push(`${entry.id}: no README.md at ${tag}, the listing has no readme`)
  }

  if (entry.screenshots) {
    fields.screenshots = entry.screenshots
  }
  else if (repo && tag) {
    const candidates = manifestScreenshots(manifest, repo, tag)
    const checked = JSON.stringify(candidates) === JSON.stringify(published?.screenshots ?? [])
    const kept = []
    for (const shot of candidates) {
      const problems = checked ? [] : (await Promise.all([shot.url, shot.dark_url].filter(Boolean).map(imageProblem))).filter(Boolean)
      if (problems.length === 0)
        kept.push(shot)
      else
        warnings.push(`${entry.id}: screenshot left out, ${problems.join(', ')}`)
    }
    if (kept.length > 0)
      fields.screenshots = kept
  }

  // The icon inside the package of the display release. The catalog serves it
  // even while the entry sets icon_url, so dropping the override keeps it.
  let icon
  if (shown) {
    const base = site.replace(/\/+$/, '')
    const fresh = icons.get(shown.version)
    if (fresh) {
      icon = { path: iconPath(entry.id, shown.version, fresh.type), bytes: fresh.bytes }
    }
    else {
      // Read in an earlier build, the published site holds it: under the name
      // the published listing gives, else under one of the icon types.
      const files = Object.keys(ICON_CONTENT_TYPES).map(type => iconPath(entry.id, shown.version, type))
      const named = files.find(file => published?.icon_url === `${base}/${file}`)
      icon = { version: shown.version, candidates: named ? [named] : files }
    }
  }
  if (entry.icon_url)
    fields.icon_url = entry.icon_url
  else if (icon?.bytes)
    fields.icon_url = `${site.replace(/\/+$/, '')}/${icon.path}`

  return { fields, icon, warnings }
}

// The fields a listing change report compares.
export const LISTING_FIELDS = ['name', 'description', 'homepage_url', 'readme_url', 'icon_url', 'screenshots', 'capabilities']

/** The listing fields of entry that differ from published. */
export function listingChanges(entry, published) {
  return LISTING_FIELDS.filter(field => JSON.stringify(entry[field]) !== JSON.stringify(published?.[field]))
}
