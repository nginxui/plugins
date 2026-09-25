#!/usr/bin/env node
// Turns a "Submit a plugin" issue form (.github/ISSUE_TEMPLATE/submit-plugin.yml)
// into a draft plugins/<id>.json. Driven by .github/workflows/submit-issue.yml,
// which then opens a pull request from whatever this script wrote (or posts
// an explanatory comment back on the issue and writes nothing, on the
// well-known failure modes below).
//
// Usage: node scripts/ci/submit-issue.mjs <path-to-issue-event.json>
// Env:   GITHUB_TOKEN  used both for the GitHub API calls and written to
//                       GITHUB_OUTPUT so the workflow can comment back.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseGithubRepoUrl, getLatestRelease, fetchRawFile, downloadBinary } from './github.mjs'
import { localizedTextFromManifest, platformsFromManifest, trimManifestSnapshot } from './manifest-snapshot.mjs'
import { findPortableAsset, buildDownloadsMap } from './release-assets.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/

/** GitHub issue forms render as "### Label\n\nvalue\n\n### Next label\n...".
 * This pulls out {label -> value} without needing a Markdown parser. */
function parseFormFields(body) {
  const fields = {}
  const sections = body.split(/^### /m).slice(1)
  for (const section of sections) {
    const newline = section.indexOf('\n')
    const label = section.slice(0, newline).trim()
    const value = section.slice(newline + 1).trim()
    fields[label] = value === '_No response_' ? '' : value
  }
  return fields
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile)
    return
  // Multi-line safe form, since author_public_key can span several lines.
  appendFileSync(outputFile, `${name}<<EOF\n${value}\nEOF\n`)
}

function fail(message) {
  console.error(message)
  setOutput('result', 'error')
  setOutput('message', message)
  process.exit(0) // A rejected submission is not a workflow failure.
}

async function main() {
  const eventPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.error('usage: node scripts/ci/submit-issue.mjs <path-to-issue-event.json>')
    process.exit(2)
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const issue = event.issue
  const token = process.env.GITHUB_TOKEN

  const fields = parseFormFields(issue.body ?? '')
  const repositoryUrl = (fields['Repository URL'] ?? '').trim()
  const pluginId = (fields['Plugin id'] ?? '').trim()
  const authorPublicKey = (fields['Minisign public key'] ?? '').trim()
  const contact = (fields.Contact ?? issue.user?.login ?? '').trim()

  setOutput('plugin_id', pluginId)

  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.length > 64)
    fail(`"${pluginId}" does not match the required id pattern ^[a-z0-9]+(\\.[a-z0-9-]+)+$ (see README.md#plugin-and-provider-naming).`)

  if (pluginId.startsWith('com.nginxui.'))
    fail('The com.nginxui.* namespace is reserved for plugins the nginx-ui project maintains itself. Choose an id under your own namespace, e.g. io.github.<your-github-handle>.<name>.')

  const repo = parseGithubRepoUrl(repositoryUrl)
  if (!repo)
    fail(`"${repositoryUrl}" is not a github.com repository URL.`)

  const githubOwnerMatch = pluginId.match(/^io\.github\.([a-z0-9-]+)\./)
  if (githubOwnerMatch && githubOwnerMatch[1].toLowerCase() !== repo.owner.toLowerCase())
    fail(`Plugin id claims GitHub owner "${githubOwnerMatch[1]}" but the repository belongs to "${repo.owner}".`)

  const entryFile = path.join(PLUGINS_DIR, `${pluginId}.json`)
  if (existsSync(entryFile))
    fail(`plugins/${pluginId}.json already exists. If this is an update to an existing listing, open a pull request instead of a new submission issue.`)

  const release = await getLatestRelease(repo.owner, repo.repo, token)
  if (!release)
    fail(`${repo.owner}/${repo.repo} has no GitHub Release yet. Publish one (see CONTRIBUTING.md's prerequisites), then reopen this issue or comment to re-trigger.`)

  const manifestText = await fetchRawFile(repo.owner, repo.repo, release.tag_name, 'plugin.json', token)
  if (!manifestText)
    fail(`Could not find plugin.json at the root of ${repo.owner}/${repo.repo}@${release.tag_name}.`)

  const manifest = JSON.parse(manifestText)
  if (manifest.id !== pluginId)
    fail(`plugin.json at ${release.tag_name} declares id "${manifest.id}", which does not match the submitted id "${pluginId}".`)

  const version = release.tag_name.replace(/^v/, '')
  const portableAsset = findPortableAsset(release.assets, pluginId, version)
  // A first submission is always community trust. Its packages carry their
  // own signature (plugin.sums.minisig), and the entry records the sha256 of
  // every archive as a download check.
  const { downloads } = await buildDownloadsMap(release.assets, pluginId, version, { token })
  if (!portableAsset && Object.keys(downloads).length === 0)
    fail(`${release.html_url} has no ${pluginId}-${version}.tar.gz or per-platform package asset.`)

  let downloadUrl, sha256
  if (portableAsset) {
    downloadUrl = portableAsset.browser_download_url
    const bytes = await downloadBinary(portableAsset.browser_download_url, token)
    sha256 = createHash('sha256').update(bytes).digest('hex')
  }

  const { name, description } = localizedTextFromManifest(manifest)
  const entry = {
    id: pluginId,
    name,
    description,
    author: contact || repo.owner,
    ...(authorPublicKey ? { author_public_key: authorPublicKey } : {}),
    homepage_url: manifest.homepage_url || repositoryUrl,
    repository_url: repositoryUrl,
    readme_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${release.tag_name}/README.md`,
    ...(manifest.icon_path ? { icon_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${release.tag_name}/${manifest.icon_path}` } : {}),
    categories: [],
    capabilities: manifest.capabilities ?? [],
    license: '',
    trust: 'community',
    stage: 'beta',
    releases: [
      {
        version,
        released_at: release.published_at ?? release.created_at,
        api_version: manifest.api_version,
        ...(manifest.min_nginx_ui_version ? { min_nginx_ui_version: manifest.min_nginx_ui_version } : {}),
        platforms: platformsFromManifest(manifest),
        ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
        ...(downloadUrl ? { download_url: downloadUrl } : {}),
        ...(sha256 ? { sha256 } : {}),
        release_notes_url: release.html_url,
        manifest: trimManifestSnapshot(manifest),
      },
    ],
  }

  writeFileSync(entryFile, `${JSON.stringify(entry, null, 2)}\n`)
  console.log(`wrote plugins/${pluginId}.json`)

  setOutput('result', 'ok')
  setOutput('message', [
    `Drafted \`plugins/${pluginId}.json\` from ${repo.owner}/${repo.repo}@${release.tag_name}.`,
    '',
    'A few fields need a human to fill in before this can be merged:',
    '- `license` (left empty — the SPDX identifier of the plugin\'s own license)',
    '- `categories` (left empty — pick from existing entries or propose new ones)',
    !authorPublicKey ? '- `author_public_key` (not provided in the form — required before this can be merged)' : null,
    !manifest.icon_path ? '- `icon_url` (the manifest declares no icon_path)' : null,
  ].filter(Boolean).join('\n'))
}

main().catch((err) => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
