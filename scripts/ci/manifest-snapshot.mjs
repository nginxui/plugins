// Derives what a plugin's own plugin.json contributes to a catalog entry: the
// platform list and the trimmed manifest snapshot stored at
// releases[].manifest, and the name and description locale maps.
//
// Shared by scripts/ci/poll-releases.mjs and scripts/ci/submit-issue.mjs so a
// new release picked up automatically is shaped the same way a human-authored
// entry (plugins/com.nginxui.dns01.json) is.

/** A provider list this large is the dns01 plugin's own lego catalog, not
 * something worth repeating in every host's cached catalog document. Below
 * the threshold, providers stay in the snapshot so scripts/validate.mjs can
 * cross-check codes.json for a small dns01 plugin too. */
const MAX_INLINE_PROVIDERS = 20

/** "<goos>-<goarch>" for every key in server.executables, or ["any"] for a
 * plugin with no per-platform executables at all (webapp/content only, or an
 * interpreted plugin started via server.command on PATH). */
export function platformsFromManifest(manifest) {
  const executables = manifest.server?.executables
  if (executables && Object.keys(executables).length > 0)
    return Object.keys(executables).sort()
  return ['any']
}

/** Strips the parts of plugin.json that are either bulky (a large provider
 * list) or not meaningful outside the plugin's own package (icon_path,
 * content paths). The host (internal/plugin.Marketplace) only reads
 * permissions, capabilities, requires and the two version fields from this
 * snapshot; everything else here is kept only because it is small and useful
 * for a human reading the catalog entry. That includes the i18n block
 * (spec MAN-40), which localizedTextFromManifest turns into the name and
 * description maps of the entry. */
export function trimManifestSnapshot(manifest) {
  const snapshot = { ...manifest }

  if (snapshot.dns01?.providers?.length > MAX_INLINE_PROVIDERS)
    delete snapshot.dns01
  if (manifest.i18n && Object.keys(manifest.i18n).length > 0)
    snapshot.i18n = structuredClone(manifest.i18n)
  else
    delete snapshot.i18n

  return snapshot
}

/** The name and description locale maps of a catalog entry, filled from the
 * top level fields of plugin.json as "en" and from its i18n block (spec
 * MAN-40) for every other locale. An empty translation is left out, so the
 * host falls back to English for it. */
export function localizedTextFromManifest(manifest) {
  const name = { en: manifest.name }
  const description = { en: manifest.description ?? '' }

  for (const [locale, translated] of Object.entries(manifest.i18n ?? {})) {
    if (locale === 'en')
      continue
    if (translated?.name)
      name[locale] = translated.name
    if (translated?.description)
      description[locale] = translated.description
  }

  return { name, description }
}
