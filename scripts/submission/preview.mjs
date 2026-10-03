#!/usr/bin/env node
// Renders what a catalog entry will show as Markdown, for the review of a
// submission or a pull request. Text from the plugin is escaped, so it can
// neither format the comment nor mention anyone.
//
// Usage: node scripts/submission/preview.mjs <index.json> <id>
//
// Exits 1 when the entry lists no release, since nothing verified.

import { readFileSync } from 'node:fs'
import { displayRelease } from '../ci/listing.mjs'
import { inferChannel } from '../ci/releases.mjs'

/** Plain text that renders as itself in a GitHub comment. */
export function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]#|~])/g, '\\$1')
    .replace(/@/g, '@\u200B')
    .replace(/\r?\n/g, ' ')
}

function url(value) {
  return /^https:\/\/[^\s"<>]+$/.test(value ?? '') ? value : ''
}

function byLanguage(map) {
  return Object.entries(map ?? {}).map(([locale, text]) => `\`${locale}\` ${escapeText(text)}`).join('<br>')
}

/** The Markdown preview of entry. */
export function renderPreview(entry) {
  const shown = displayRelease(entry.releases ?? [])
  const manifest = shown?.manifest ?? {}
  const rows = [
    ['Name', byLanguage(entry.name)],
    ['Description', byLanguage(entry.description)],
    ['Listed release', shown ? `${escapeText(shown.version)} (${shown.channel ?? inferChannel(shown.version)})${shown.signer ? `, signed by key \`${shown.signer}\`` : ''}` : 'none that verifies'],
    ['Platforms', escapeText((shown?.platforms ?? []).join(', '))],
    ['Capabilities', escapeText((entry.capabilities ?? []).join(', '))],
    ['Categories', escapeText((entry.categories ?? []).join(', '))],
    ['License', escapeText(entry.license ?? '')],
    ['Homepage', url(entry.homepage_url)],
    ['README', url(entry.readme_url)],
    ['Icon', !entry.icon_url ? 'none' : entry.icon_url.includes('/v1/icons/') ? 'read from the package, served by the catalog once listed' : url(entry.icon_url) && `<img src="${entry.icon_url}" width="48" alt="">`],
  ]
  const permissions = (manifest.permissions ?? []).map((permission) => {
    const reason = manifest.permission_reasons?.[permission]
    return `- \`${escapeText(permission)}\`${reason ? `: ${escapeText(reason)}` : ''}`
  })
  const hosts = manifest.network_hosts ?? []
  const shots = (entry.screenshots ?? []).filter(shot => url(shot.url))
  // Screenshots sit in a table, four to a row with their captions below.
  const shotRows = []
  for (let i = 0; i < shots.length; i += 4) {
    const row = shots.slice(i, i + 4)
    shotRows.push(`| ${row.map(shot => `<a href="${shot.url}"><img src="${shot.url}" width="200" alt=""></a>`).join(' | ')} |`)
    if (i === 0)
      shotRows.push(`| ${row.map(() => '---').join(' | ')} |`)
    shotRows.push(`| ${row.map(shot => escapeText(shot.caption?.en ?? '')).join(' | ')} |`)
  }

  return [
    '| Field | Listed as |',
    '| --- | --- |',
    ...rows.filter(([, value]) => value).map(([label, value]) => `| ${label} | ${value} |`),
    '',
    '**Permissions**',
    '',
    ...(permissions.length > 0 ? permissions : ['None.']),
    ...(hosts.length > 0 ? ['', `**Network hosts**: ${hosts.map(host => `\`${escapeText(host)}\``).join(', ')}`] : []),
    ...(shots.length > 0 ? ['', '**Screenshots**', '', ...shotRows] : []),
  ].join('\n')
}

function main() {
  const [indexPath, id] = process.argv.slice(2)
  if (!indexPath || !id) {
    console.error('usage: node scripts/submission/preview.mjs <index.json> <id>')
    process.exit(2)
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  const entry = index.plugins.find(plugin => plugin.id === id)
  if (!entry) {
    console.error(`${id} is not in ${indexPath}`)
    process.exit(1)
  }
  console.log(renderPreview(entry))
  if ((entry.releases ?? []).length === 0)
    process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`)
  main()
