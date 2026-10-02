// Renders the pages of plugins.nginxui.com from the built catalog. Each
// language has a list of every plugin and a page per plugin with what the
// marketplace of Nginx UI shows: screenshots, release notes, what it provides
// and the permissions it asks for. On the list the same details open over the
// page. Everything taken from the catalog is escaped, it is written by plugin
// authors.

import { compareSemver } from './ci/semver.mjs'
import { inferChannel } from './ci/releases.mjs'
import {
  CAPABILITIES,
  CREDENTIALS_PERMISSION,
  LANG,
  LANGUAGE_NAME,
  LOCALES,
  OTHER_CAPABILITY,
  PERMISSIONS,
  STRINGS,
  UNKNOWN_PERMISSION,
} from './site-strings.mjs'

const SITE = 'https://plugins.nginxui.com'
const MOON = '<svg class="icon-moon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
const SUN = '<svg class="icon-sun" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>'
const GLOBE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>'
const CROSS = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>'
const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>'
const OS_NAME = { linux: 'Linux', darwin: 'macOS', windows: 'Windows', freebsd: 'FreeBSD' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

/** The URL when it is an absolute http(s) one, so an entry cannot smuggle a
 * javascript: link into the page. */
function safeUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  }
  catch {
    return ''
  }
}

function localized(map, locale) {
  if (!map || typeof map !== 'object')
    return String(map ?? '')
  return map[locale] || map.en || Object.values(map)[0] || ''
}

function listPath(locale) {
  return locale === 'en' ? '/' : `/${locale}/`
}

function pluginPath(locale, id) {
  return `${listPath(locale)}plugins/${encodeURIComponent(id)}/`
}

function isStable(release) {
  return (release.channel ?? inferChannel(release.version)) === 'stable'
}

/** Releases that are not yanked, newest first. */
function listedReleases(releases) {
  return (releases ?? []).filter(release => !release.yanked).sort((a, b) => compareSemver(b.version, a.version))
}

/** The newest stable release a user gets by default, and a newer prerelease
 * when there is one. Yanked releases are never offered. */
export function offeredReleases(releases) {
  const listed = listedReleases(releases)
  const stable = listed.find(isStable)
  const newest = listed[0]
  return { stable, preview: newest && newest !== stable ? newest : undefined }
}

/** "Linux, macOS, Windows" for a release, or null for one that runs anywhere. */
export function platformNames(release) {
  const keys = release?.platforms ?? []
  if (keys.length === 0 || keys.includes('any'))
    return null
  const names = [...new Set(keys.map(key => OS_NAME[key.split('-')[0]] ?? key.split('-')[0]))]
  return names.sort((a, b) => Object.values(OS_NAME).indexOf(a) - Object.values(OS_NAME).indexOf(b))
}

/** Megabytes as Nginx UI shows them, GB from one GiB up. */
export function formatMemory(mb) {
  if (mb >= 1024) {
    const gb = mb / 1024
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
  }
  return `${mb} MB`
}

function day(timestamp) {
  return /^\d{4}-\d{2}-\d{2}/.test(timestamp ?? '') ? timestamp.slice(0, 10) : ''
}

function timeTag(release) {
  const date = day(release.released_at)
  return date ? `<time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>` : ''
}

function inlineMarkdown(text) {
  let html = ''
  let last = 0
  for (const match of text.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    html += escapeHtml(text.slice(last, match.index))
    if (match[1] !== undefined) {
      html += `<code>${escapeHtml(match[1])}</code>`
    }
    else if (match[2] !== undefined) {
      html += `<strong>${escapeHtml(match[2])}</strong>`
    }
    else {
      const url = safeUrl(match[4])
      html += url ? `<a href="${escapeHtml(url)}" rel="noopener nofollow">${escapeHtml(match[3])}</a>` : escapeHtml(match[3])
    }
    last = match.index + match[0].length
  }
  return html + escapeHtml(text.slice(last))
}

/** Release notes as HTML. Notes are short markdown from git-cliff and the
 * like: headings, lists, paragraphs, code, bold and links. Anything else stays
 * text, and every piece is escaped. */
export function renderNotes(markdown) {
  const blocks = []
  let list = null
  let paragraph = null
  const flush = () => {
    if (list)
      blocks.push(`<ul>${list.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
    if (paragraph)
      blocks.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
    list = null
    paragraph = null
  }
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    const item = line.match(/^\s*[-*+]\s+(.*)$/)
    if (heading) {
      flush()
      blocks.push(`<h4>${inlineMarkdown(heading[1].trim())}</h4>`)
    }
    else if (item) {
      if (paragraph)
        flush()
      list ??= []
      list.push(item[1].trim())
    }
    else if (line.trim() === '') {
      flush()
    }
    else if (list && /^\s+/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`
    }
    else {
      if (list)
        flush()
      paragraph ??= []
      paragraph.push(line.trim())
    }
  }
  flush()
  return blocks.join('')
}

function capability(name, locale) {
  const preset = CAPABILITIES[name] ?? OTHER_CAPABILITY
  return { label: preset.label[locale], description: preset.description[locale] }
}

function permission(name, locale) {
  if (name.startsWith('credentials.read:')) {
    const kind = name.slice('credentials.read:'.length)
    return { label: CREDENTIALS_PERMISSION.label[locale](kind), description: CREDENTIALS_PERMISSION.description[locale](kind) }
  }
  const preset = PERMISSIONS[name] ?? UNKNOWN_PERMISSION
  return { label: preset.label[locale], description: preset.description[locale] }
}

function trustBadge(plugin, t) {
  const trust = plugin.trust in t.trust ? plugin.trust : 'community'
  return `<span class="badge trust-${trust}">${escapeHtml(t.trust[trust])}</span>`
}

function iconTag(plugin, size) {
  const icon = safeUrl(plugin.icon_url)
  return icon
    ? `<img class="plugin-icon" src="${escapeHtml(icon)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="plugin-icon" aria-hidden="true"></span>'
}

/** What a plugin shows on a card and in its details, for one language. */
function describe(plugin, locale) {
  const { stable, preview } = offeredReleases(plugin.releases)
  const shown = stable ?? preview
  const manifest = shown?.manifest ?? {}
  return {
    name: localized(plugin.name, locale),
    description: localized(plugin.description, locale),
    stable,
    preview,
    shown,
    manifest,
    platforms: platformNames(shown),
    memory: manifest.server?.resources?.recommended_memory_mb ?? 0,
    capabilities: (plugin.capabilities ?? []).map(name => ({ name, ...capability(name, locale) })),
    providers: [...(plugin.provides?.dns01?.providers ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'en')),
  }
}

function renderCard(plugin, locale) {
  const t = STRINGS[locale]
  const d = describe(plugin, locale)
  const search = [plugin.id, d.name, d.description, plugin.author, ...d.capabilities.map(c => c.label), ...d.providers.map(p => p.name)].join(' ').toLowerCase()

  const facts = []
  if (d.stable)
    facts.push([t.version, escapeHtml(d.stable.version)])
  if (d.preview)
    facts.push([t.beta, escapeHtml(d.preview.version)])
  if (d.memory > 0)
    facts.push([t.memoryShort, escapeHtml(formatMemory(d.memory))])

  return `<article class="plugin" data-search="${escapeHtml(search)}">
  <header class="plugin-head">
    ${iconTag(plugin, 48)}
    <div class="plugin-title">
      <h2><a class="plugin-link" href="${escapeHtml(pluginPath(locale, plugin.id))}" data-plugin="${escapeHtml(plugin.id)}">${escapeHtml(d.name)}</a></h2>
      <p class="plugin-author">${escapeHtml(t.by(plugin.author ?? ''))}</p>
    </div>
    ${trustBadge(plugin, t)}
  </header>
  <p class="plugin-description">${escapeHtml(d.description)}</p>
  <dl class="card-stats">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
  ${d.capabilities.length > 0 ? `<ul class="chips">${d.capabilities.map(c => `<li>${escapeHtml(c.label)}</li>`).join('')}</ul>` : ''}
</article>`
}

function section(title, body, extra = '') {
  return `<section class="detail-section"${extra}>
  <h3>${escapeHtml(title)}</h3>
  ${body}
</section>`
}

function renderScreenshots(plugin, locale) {
  const shots = (plugin.screenshots ?? []).map(shot => ({ url: safeUrl(shot.url), dark: safeUrl(shot.dark_url), caption: localized(shot.caption, locale) })).filter(shot => shot.url)
  if (shots.length === 0)
    return ''
  return `<ul class="shots">${shots.map(shot => `<li><figure>
    <a href="${escapeHtml(shot.url)}" class="shot${shot.dark ? ' has-dark' : ''}" rel="noopener">
      <img class="shot-light" src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.caption)}" loading="lazy" referrerpolicy="no-referrer">
      ${shot.dark ? `<img class="shot-dark" src="${escapeHtml(shot.dark)}" alt="${escapeHtml(shot.caption)}" loading="lazy" referrerpolicy="no-referrer">` : ''}
    </a>
    ${shot.caption ? `<figcaption>${escapeHtml(shot.caption)}</figcaption>` : ''}
  </figure></li>`).join('')}</ul>`
}

function renderVersions(plugin, d, t) {
  const releases = listedReleases(plugin.releases)
  if (releases.length === 0)
    return ''
  return `<ol class="versions">${releases.map((release, i) => {
    const pills = [
      release === d.stable ? `<span class="pill pill-accent">${escapeHtml(t.latest)}</span>` : '',
      isStable(release) ? '' : `<span class="pill pill-beta">${escapeHtml(t.beta)}</span>`,
    ].join('')
    const notesUrl = safeUrl(release.release_notes_url)
    const head = `<span class="version">${escapeHtml(release.version)}</span>${pills}${timeTag(release)}${notesUrl ? `<a href="${escapeHtml(notesUrl)}" rel="noopener">${escapeHtml(t.releaseNotes)}</a>` : ''}`
    const notes = release.notes ? renderNotes(release.notes) : ''
    if (!notes)
      return `<li><div class="version-head">${head}</div></li>`
    // The newest notes are open, like the update notes of an app store.
    return `<li><details${i === 0 ? ' open' : ''}><summary class="version-head">${head}</summary><div class="notes">${notes}</div></details></li>`
  }).join('')}</ol>`
}

function renderProvides(d, t) {
  const items = d.capabilities.map((c) => {
    const providers = c.name === 'dns01' && d.providers.length > 0
      ? `<details class="providers"><summary>${escapeHtml(t.providers(d.providers.length))}</summary><input class="provider-search" type="search" placeholder="${escapeHtml(t.searchProviders)}" aria-label="${escapeHtml(t.searchProviders)}" hidden><ul>${d.providers.map(p => `<li>${escapeHtml(p.name)}</li>`).join('')}</ul></details>`
      : ''
    return `<li><strong>${escapeHtml(c.label)}</strong><p>${escapeHtml(c.description)}</p>${providers}</li>`
  })
  return `<ul class="rows">${items.join('')}</ul>`
}

function renderPermissions(d, t, locale) {
  const names = d.manifest.permissions ?? []
  if (names.length === 0)
    return `<p class="muted">${escapeHtml(t.noPermissions)}</p>`
  const hosts = d.manifest.network_hosts ?? []
  return `<ul class="rows">${names.map((name) => {
    const { label, description } = permission(name, locale)
    const extra = name === 'network'
      ? (hosts.length > 0
          ? `<p class="hosts-label">${escapeHtml(t.onlyHosts)}</p><ul class="hosts">${hosts.map(host => `<li><code>${escapeHtml(host)}</code></li>`).join('')}</ul>`
          : `<p class="muted">${escapeHtml(t.noHosts)}</p>`)
      : ''
    return `<li><strong>${escapeHtml(label)}</strong><p>${escapeHtml(description)}</p>${extra}</li>`
  }).join('')}</ul>`
}

/** The details of a plugin, shared by its page and the overlay on the list. */
function renderDetail(plugin, locale, index, headingTag) {
  const t = STRINGS[locale]
  const d = describe(plugin, locale)
  const names = new Map(index.plugins.map(p => [p.id, localized(p.name, locale)]))
  const conflicts = (d.manifest.conflicts ?? []).map(id => names.get(id) ?? id)
  const homepage = safeUrl(plugin.homepage_url ?? d.manifest.homepage_url)
  const repository = safeUrl(plugin.repository_url)

  const stats = []
  if (d.stable)
    stats.push([t.version, escapeHtml(d.stable.version)])
  if (d.preview)
    stats.push([t.beta, escapeHtml(d.preview.version)])
  if (d.shown?.min_nginx_ui_version)
    stats.push([t.requiresLabel, escapeHtml(t.minVersion(d.shown.min_nginx_ui_version))])
  if (d.memory > 0)
    stats.push([t.memory, escapeHtml(formatMemory(d.memory))])
  stats.push([t.platforms, escapeHtml(d.platforms ? d.platforms.join(', ') : t.allPlatforms)])

  const info = [[t.id, `<code>${escapeHtml(plugin.id)}</code>`]]
  if (plugin.author)
    info.push([t.author, escapeHtml(plugin.author)])
  if (plugin.license)
    info.push([t.license, escapeHtml(plugin.license)])
  if (homepage)
    info.push([t.homepage, `<a href="${escapeHtml(homepage)}" rel="noopener">${escapeHtml(homepage)}</a>`])
  if (repository)
    info.push([t.repository, `<a href="${escapeHtml(repository)}" rel="noopener">${escapeHtml(repository.replace(/^https:\/\//, ''))}</a>`])

  const screenshots = renderScreenshots(plugin, locale)
  const versions = renderVersions(plugin, d, t)

  return `<header class="detail-head">
  ${iconTag(plugin, 72)}
  <div class="detail-title">
    <${headingTag}>${escapeHtml(d.name)}</${headingTag}>
    <p class="plugin-author">${escapeHtml(t.by(plugin.author ?? ''))}</p>
    <div class="detail-badges">${trustBadge(plugin, t)}${!d.stable && d.preview ? `<span class="badge pill-beta">${escapeHtml(t.beta)}</span>` : ''}</div>
  </div>
</header>
<dl class="stats">${stats.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
${conflicts.length > 0 ? `<p class="notice">${escapeHtml(t.conflicts(conflicts))}</p>` : ''}
${screenshots ? section(t.screenshots, screenshots) : ''}
${section(t.about, `<p class="detail-description">${escapeHtml(d.description)}</p>`)}
${versions ? section(t.versions, versions) : ''}
${d.capabilities.length > 0 ? section(t.provides, renderProvides(d, t)) : ''}
${section(t.permissions, renderPermissions(d, t, locale))}
${section(t.information, `<dl class="info">${info.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`)}`
}

function renderShell({ locale, title, description, pathOf, main }) {
  const t = STRINGS[locale]
  const alternates = LOCALES.map(other => `<link rel="alternate" hreflang="${LANG[other]}" href="${SITE}${pathOf(other)}">`).join('\n')
  const languages = LOCALES.map(other => `<li><a href="${pathOf(other)}" hreflang="${LANG[other]}" lang="${LANG[other]}" data-locale="${other}"${other === locale ? ' aria-current="page"' : ''}>${LANGUAGE_NAME[other]}</a></li>`).join('')
  return `<!doctype html>
<html lang="${LANG[locale]}" data-locale="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${SITE}${pathOf(locale)}">
${alternates}
<link rel="alternate" hreflang="x-default" href="${SITE}${pathOf('en')}">
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js"></script>
</head>
<body>
<header class="site-head">
  <a class="site-brand" href="${listPath(locale)}">
    <img src="/assets/logo.svg" alt="" width="40" height="40">
    <span class="site-name">${escapeHtml(t.title)}</span>
  </a>
  <div class="site-tools">
    <button class="theme" type="button" title="${escapeHtml(t.darkMode)}" aria-label="${escapeHtml(t.darkMode)}" aria-pressed="false" hidden>${MOON}${SUN}</button>
    <details class="languages">
      <summary title="${escapeHtml(t.language)}" aria-label="${escapeHtml(t.language)}">${GLOBE}</summary>
      <ul>
        ${languages}
      </ul>
    </details>
  </div>
</header>
${main}
<dialog class="lightbox" aria-label="${escapeHtml(t.screenshots)}">
  <button class="lightbox-close" type="button" aria-label="${escapeHtml(t.close)}" title="${escapeHtml(t.close)}">${CROSS}</button>
  <button class="lightbox-step lightbox-previous" type="button" aria-label="${escapeHtml(t.previous)}" title="${escapeHtml(t.previous)}">${CHEVRON_LEFT}</button>
  <figure>
    <img alt="">
    <figcaption><span class="lightbox-caption"></span> <span class="lightbox-count"></span></figcaption>
  </figure>
  <button class="lightbox-step lightbox-next" type="button" aria-label="${escapeHtml(t.next)}" title="${escapeHtml(t.next)}">${CHEVRON_RIGHT}</button>
</dialog>
<footer class="site-foot">
  <a href="https://github.com/nginxui/plugins/blob/main/CONTRIBUTING.md">${escapeHtml(t.submit)}</a>
  <a href="https://nginxui.com/plugin/overview">${escapeHtml(t.guide)}</a>
  <a href="/v1/index.json">${escapeHtml(t.catalog)}</a>
</footer>
</body>
</html>
`
}

function renderList(index, locale) {
  const t = STRINGS[locale]
  const plugins = [...index.plugins].sort((a, b) => localized(a.name, locale).localeCompare(localized(b.name, locale), LANG[locale]))
  const updated = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(index.updated_at ?? '') ? index.updated_at : ''
  const dialogs = plugins.map(plugin => `<dialog class="detail-dialog" id="detail-${escapeHtml(plugin.id)}" aria-label="${escapeHtml(localized(plugin.name, locale))}">
  <button class="close" type="button" aria-label="${escapeHtml(t.close)}" title="${escapeHtml(t.close)}">${CROSS}</button>
  <div class="detail-sheet">
    ${renderDetail(plugin, locale, index, 'h2')}
  </div>
</dialog>`).join('\n')
  return renderShell({
    locale,
    title: t.title,
    description: t.lead,
    pathOf: listPath,
    main: `<main>
  <h1 class="visually-hidden">${escapeHtml(t.title)}</h1>
  <p class="lead">${escapeHtml(t.lead)}</p>
  <input class="search" type="search" placeholder="${escapeHtml(t.search)}" aria-label="${escapeHtml(t.search)}" hidden>
  <div class="plugins">
${plugins.map(plugin => renderCard(plugin, locale)).join('\n')}
  </div>
  <p class="empty" hidden>${escapeHtml(t.empty)}</p>
  ${updated ? `<p class="updated">${escapeHtml(t.updated)} <time class="local-time" datetime="${escapeHtml(updated)}">${escapeHtml(`${updated.slice(0, 10)} ${updated.slice(11, 16)} UTC`)}</time></p>` : ''}
</main>
${dialogs}`,
  })
}

function renderPluginPage(plugin, index, locale) {
  const t = STRINGS[locale]
  return renderShell({
    locale,
    title: `${localized(plugin.name, locale)} | ${t.title}`,
    description: localized(plugin.description, locale),
    pathOf: other => pluginPath(other, plugin.id),
    main: `<main class="detail-page">
  <p class="back"><a href="${listPath(locale)}">${escapeHtml(t.allPlugins)}</a></p>
  <article class="detail">
${renderDetail(plugin, locale, index, 'h1')}
  </article>
</main>`,
  })
}

/** The pages of the site as [path, html]: per language the list and a page
 * per plugin. */
export function renderSite(index) {
  const pages = []
  for (const locale of LOCALES) {
    const base = locale === 'en' ? '' : `${locale}/`
    pages.push([`${base}index.html`, renderList(index, locale)])
    for (const plugin of index.plugins)
      pages.push([`${base}plugins/${plugin.id}/index.html`, renderPluginPage(plugin, index, locale)])
  }
  return pages
}
