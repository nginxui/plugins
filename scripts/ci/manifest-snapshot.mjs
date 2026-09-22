// Derives the two things a plugin's own plugin.json needs to become a
// catalog releases[] entry: the platform list, and the trimmed manifest
// snapshot stored at releases[].manifest.
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
 * for a human reading the catalog entry. */
export function trimManifestSnapshot(manifest) {
  const snapshot = { ...manifest }

  if (snapshot.dns01?.providers?.length > MAX_INLINE_PROVIDERS)
    delete snapshot.dns01

  return snapshot
}
