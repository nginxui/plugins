// The checkout of nginxui/plugin-spec whose schemas describe the documents
// this repository builds and publishes: the catalog, the partner keyring and
// the plugin.json snapshot inside the catalog.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** $PLUGIN_SPEC_DIR, or a checkout next to this repository. */
export const SPEC_DIR = path.resolve(process.env.PLUGIN_SPEC_DIR || path.join(ROOT, '..', 'plugin-spec'))

/** The plugin-spec schemas the site publishes next to its own. */
export const SPEC_SCHEMAS = ['catalog.schema.json', 'partners.schema.json', 'plugin.schema.json']

/** The path of one plugin-spec schema. Throws when the checkout is missing. */
export function specSchema(name) {
  const file = path.join(SPEC_DIR, 'schema', name)
  if (!existsSync(file))
    throw new Error(`${file} is missing: check out nginxui/plugin-spec next to this repository or set PLUGIN_SPEC_DIR`)
  return file
}
