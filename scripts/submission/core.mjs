// The core of a plugin submission, apart from where it comes from: drafts the
// catalog entry of a submission and says whether the submitter may list the
// repository. The issue form (scripts/submission/issue.mjs) is one front end;
// a submission portal can call the same functions.
//
// A submission is { repository_url, author_public_key, categories,
// submitter: { login, id } }.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { githubJson, listReleases, fetchRawFile, parseGithubRepoUrl } from '../ci/github.mjs'
import { categoriesFromManifest } from '../ci/manifest-snapshot.mjs'
import { findPlatformAssets, findPortableAsset } from '../ci/release-assets.mjs'
import { tagVersion } from '../ci/releases.mjs'
import { isSemver } from '../ci/semver.mjs'
import { parsePublicKey } from '../lib/minisign.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const BLOCKED_FILE = path.join(ROOT, 'blocked.json')
const ENTRY_SCHEMA = path.join(ROOT, 'schema', 'entry.schema.json')
const API = 'https://api.github.com'
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/

// A repository with this topic agrees to be listed, whoever submits it: only
// people who administer a repository can set its topics.
export const CONSENT_TOPIC = 'nginx-ui-plugin'

/** The category ids the entry schema accepts, in their order. */
export function knownCategories() {
  return JSON.parse(readFileSync(ENTRY_SCHEMA, 'utf8')).$defs.category.enum
}

/** blocked.json: the plugin ids and repositories that may not be listed. */
export function loadBlocked(file = BLOCKED_FILE) {
  if (!existsSync(file))
    return { plugins: [], repositories: [] }
  const blocked = JSON.parse(readFileSync(file, 'utf8'))
  return { plugins: blocked.plugins ?? [], repositories: blocked.repositories ?? [] }
}

/** Whether an id or "owner/repo" is blocked, case insensitively. */
function isBlocked(list, value) {
  return list.some(item => item.toLowerCase() === value.toLowerCase())
}

/** The release a submission is drafted from: the newest stable one, else the
 * newest prerelease. */
function submittedRelease(releases) {
  const versioned = releases.filter(release => isSemver(tagVersion(release.tag_name)))
  return versioned.find(release => !release.prerelease) ?? versioned[0]
}

/**
 * Whether the submitter may list the repository: the submitter owns it, it
 * carries the consent topic, or the submitter is a public member of the
 * organization that owns it. Returns { eligible, reason }.
 */
export async function checkEligibility(repository, submitter, { token, fetchImpl = fetch } = {}) {
  if (repository.owner.type === 'User' && repository.owner.id === submitter.id)
    return { eligible: true, reason: `@${submitter.login} owns the repository` }
  if ((repository.topics ?? []).includes(CONSENT_TOPIC))
    return { eligible: true, reason: `the repository has the ${CONSENT_TOPIC} topic` }
  if (repository.owner.type === 'Organization') {
    const url = `${API}/orgs/${repository.owner.login}/public_members/${submitter.login}`
    const headers = { 'Accept': 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    const response = await fetchImpl(url, { headers })
    if (response.status === 204)
      return { eligible: true, reason: `@${submitter.login} is a public member of ${repository.owner.login}` }
  }
  return {
    eligible: false,
    reason: `@${submitter.login} does not own ${repository.full_name}, is not a public member of its owner and the repository has no ${CONSENT_TOPIC} topic`,
  }
}

/**
 * Drafts the catalog entry of a submission. Returns { entry, repository, tag }
 * or { rejection } with a reason the submitter can act on.
 */
export async function draftEntry(submission, { token, blocked = loadBlocked(), entriesDir = PLUGINS_DIR } = {}) {
  const reject = rejection => ({ rejection })
  const repo = parseGithubRepoUrl((submission.repository_url ?? '').trim())
  if (!repo)
    return reject(`${JSON.stringify(submission.repository_url ?? '')} is not a github.com repository URL such as https://github.com/<owner>/<repo>.`)

  let repository
  try {
    repository = await githubJson(`${API}/repos/${repo.owner}/${repo.repo}`, token)
  }
  catch {
    return reject(`https://github.com/${repo.owner}/${repo.repo} is not a public repository.`)
  }
  if (repository.private)
    return reject(`${repository.full_name} is private, the catalog lists public repositories only.`)
  if (isBlocked(blocked.repositories, repository.full_name))
    return reject(`${repository.full_name} may not be listed. Contact the maintainers if you think this is a mistake.`)

  const release = submittedRelease(await listReleases(repository.owner.login, repository.name, token))
  if (!release)
    return reject(`${repository.full_name} has no GitHub Release with a version tag such as v1.0.0 yet. Publish one, then edit this submission.`)
  const version = tagVersion(release.tag_name)

  const manifestText = await fetchRawFile(repository.owner.login, repository.name, release.tag_name, 'plugin.json', token)
  if (!manifestText)
    return reject(`There is no plugin.json at the root of ${repository.full_name} at ${release.tag_name}.`)
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  }
  catch (err) {
    return reject(`plugin.json at ${release.tag_name} is not valid JSON: ${err.message}`)
  }

  const id = manifest.id
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id) || id.length > 64)
    return reject(`The id ${JSON.stringify(id)} of plugin.json does not follow the naming rule, see README.md#plugin-and-provider-naming.`)
  if (id.startsWith('com.nginxui.'))
    return reject('The com.nginxui.* namespace is reserved for the plugins of the Nginx UI project. Use an id under your own namespace, such as io.github.<owner>.<name>.')
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '')
    return reject(`plugin.json at ${release.tag_name} has no name.`)
  const githubOwner = id.match(/^io\.github\.([a-z0-9-]+)\./)
  if (githubOwner && githubOwner[1] !== repository.owner.login.toLowerCase())
    return reject(`The id ${id} names the GitHub owner ${githubOwner[1]}, but ${repository.full_name} belongs to ${repository.owner.login}.`)
  if (isBlocked(blocked.plugins, id))
    return reject(`${id} may not be listed. Contact the maintainers if you think this is a mistake.`)
  if (existsSync(path.join(entriesDir, `${id}.json`)))
    return reject(`${id} is listed already. Change a listing with a pull request to plugins/${id}.json instead.`)
  if (!findPortableAsset(release.assets, id, version) && findPlatformAssets(release.assets, id, version).size === 0)
    return reject(`${release.html_url} has no ${id}-${version}.tar.gz or ${id}-${version}-<goos>-<goarch>.tar.gz package.`)

  let primary
  try {
    primary = parsePublicKey(submission.author_public_key ?? '')
  }
  catch {
    return reject('The primary public key is not a minisign public key. Paste primary.pub from nginx-ui plugin key init.')
  }

  const known = knownCategories()
  const unknown = (submission.categories ?? []).filter(category => !known.includes(category))
  if (unknown.length > 0)
    return reject(`Unknown categories: ${unknown.join(', ')}.`)
  const categories = (submission.categories?.length ? submission.categories : categoriesFromManifest(manifest)).slice(0, 3)
  const license = repository.license?.spdx_id

  const entry = {
    id,
    name: { en: manifest.name },
    author: submission.submitter.login,
    author_public_key: primary.line,
    repository_url: `https://github.com/${repository.full_name}`,
    ...(categories.length > 0 ? { categories } : {}),
    ...(license && license !== 'NOASSERTION' ? { license } : {}),
    trust: 'community',
  }
  return { entry, repository, tag: release.tag_name }
}
