// Derives what a plugin's own plugin.json contributes to a catalog entry: the
// platform list and the manifest snapshot stored at releases[].manifest, and
// the name and description locale maps.
//
// Shared by scripts/ci/release-record.mjs and scripts/ci/submit-issue.mjs so a
// new release picked up automatically is shaped the same way a human-authored
// entry (plugins/com.nginxui.dns01.json) is.

/** The members of plugin.json a catalog release keeps, the manifest snapshot
 * of plugin-spec's catalog.schema.json: what a host reads before the install.
 * The capability blocks, such as the dns01 provider list, change from release
 * to release and stay in the package. */
const SNAPSHOT_MEMBERS = [
  'id',
  'name',
  'version',
  'description',
  'i18n',
  'homepage_url',
  'api_version',
  'min_nginx_ui_version',
  'server',
  'capabilities',
  'permissions',
  'requires',
  'requires_capabilities',
  'conflicts',
  'network_hosts',
  'permission_reasons',
]

/** "<goos>-<goarch>" for every key in server.executables, or ["any"] for a
 * plugin with no per-platform executables at all (webapp/content only, or an
 * interpreted plugin started via server.command on PATH). */
export function platformsFromManifest(manifest) {
  const executables = manifest.server?.executables
  if (executables && Object.keys(executables).length > 0)
    return Object.keys(executables).sort()
  return ['any']
}

/** The manifest snapshot of a catalog release: SNAPSHOT_MEMBERS of plugin.json,
 * an empty i18n block left out. */
export function trimManifestSnapshot(manifest) {
  const snapshot = {}
  for (const member of SNAPSHOT_MEMBERS) {
    if (manifest[member] !== undefined)
      snapshot[member] = structuredClone(manifest[member])
  }
  if (snapshot.i18n && Object.keys(snapshot.i18n).length === 0)
    delete snapshot.i18n
  return snapshot
}

/** The name and description locale maps of a catalog entry, filled from the
 * top level fields of plugin.json as "en" and from its i18n block for every
 * other locale. An empty translation is left out, so the
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
