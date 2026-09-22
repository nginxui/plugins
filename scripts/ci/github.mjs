// Small GitHub REST API helpers shared by the CI scripts under scripts/ci/.
// Deliberately dependency-free (global fetch, Node.js >= 20) like the rest of
// this repository's tooling; only used inside GitHub Actions, never by
// scripts/validate.mjs or scripts/build-index.mjs.

const API = 'https://api.github.com'

function authHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token)
    headers.Authorization = `Bearer ${token}`
  return headers
}

/** Parses "https://github.com/<owner>/<repo>" (with or without a trailing
 * slash, .git suffix, or extra path) into { owner, repo }. Returns null for
 * anything that is not a github.com repository URL. */
export function parseGithubRepoUrl(url) {
  if (!url)
    return null
  const match = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (!match)
    return null
  return { owner: match[1], repo: match[2] }
}

async function githubJson(url, token) {
  const response = await fetch(url, { headers: authHeaders(token) })
  if (!response.ok)
    throw new Error(`GET ${url}: HTTP ${response.status} ${await response.text()}`)
  return response.json()
}

/** GET /repos/{owner}/{repo}/releases/latest. Returns null (not a throw) on a
 * 404, since a brand-new repository legitimately has no release yet. */
export async function getLatestRelease(owner, repo, token) {
  const url = `${API}/repos/${owner}/${repo}/releases/latest`
  const response = await fetch(url, { headers: authHeaders(token) })
  if (response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`GET ${url}: HTTP ${response.status} ${await response.text()}`)
  return response.json()
}

/** Raw file content of <owner>/<repo> at <ref>, e.g. a tag name. Returns null
 * on a 404 rather than throwing, since not every plugin repository keeps
 * plugin.json at the exact path this catalog expects. */
export async function fetchRawFile(owner, repo, ref, filePath, token) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`
  // raw.githubusercontent.com does not take the same auth header shape as
  // the API host, but a token still raises the rate limit if provided.
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const response = await fetch(url, { headers })
  if (response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`GET ${url}: HTTP ${response.status}`)
  return response.text()
}

/** Downloads a binary asset (a release asset URL) into a Buffer. */
export async function downloadBinary(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const response = await fetch(url, { headers })
  if (!response.ok)
    throw new Error(`GET ${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export { githubJson }
