// Receives the release webhooks of the catalog GitHub App and starts the
// deploy of the catalog when a plugin it lists publishes, edits or deletes a
// release. The deploy reads everything from GitHub itself, so a delivery only
// decides when it runs.
//
// Settings (wrangler.toml and `wrangler secret put`):
//   WEBHOOK_SECRET          webhook secret of the catalog GitHub App
//   DEPLOY_APP_ID           id of the deploy GitHub App, installed on the
//                           catalog repository with Actions read and write
//   DEPLOY_APP_PRIVATE_KEY  its private key, PKCS#1 as GitHub hands it out or
//                           PKCS#8
//   CATALOG_URL             the published site, read to tell listed plugins
//   CATALOG_REPO            owner/name of the catalog repository
//   DEPLOY_WORKFLOW         file name of the deploy workflow
//   DEPLOY_REF              branch the deploy runs on
//
// Two limits keep a busy repository from running the deploy over and over: a
// repository starts it at most once per COOLDOWN_SECONDS, and nothing starts
// while a deploy is waiting to run, since that one reads the newest state when
// it starts. GitHub runs one deploy at a time on top of that.

const API = 'https://api.github.com'
const USER_AGENT = 'nginxui-plugins-release-hook'
// Actions that change what the catalog lists. "released" and "prereleased"
// arrive together with "published" and add nothing.
const RELEASE_ACTIONS = new Set(['published', 'edited', 'deleted', 'unpublished'])
// Seconds a repository waits before its events start the deploy again.
const COOLDOWN_SECONDS = 60
// Run states of a deploy that has not started yet.
const WAITING = new Set(['queued', 'pending', 'requested', 'waiting'])

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/github')
      return text('Not found', 404)
    if (request.method !== 'POST')
      return text('Method not allowed', 405)

    const body = await request.text()
    if (!await validSignature(env.WEBHOOK_SECRET, body, request.headers.get('X-Hub-Signature-256')))
      return text('Invalid signature', 401)

    const event = request.headers.get('X-GitHub-Event')
    if (event === 'ping')
      return text('pong')
    if (event !== 'release')
      return text(`Ignored event ${event}`, 202)

    const payload = JSON.parse(body)
    if (!RELEASE_ACTIONS.has(payload.action) || payload.release?.draft)
      return text(`Ignored release action ${payload.action}`, 202)

    const repository = payload.repository?.html_url
    if (!await isListed(env, repository))
      return text(`${repository} is not in the catalog`, 202)
    if (!await claimCooldown(request.url, repository))
      return text(`${repository} started the deploy less than ${COOLDOWN_SECONDS} seconds ago`, 202)

    const token = await installationToken(env)
    if (await deployWaiting(env, token))
      return text('A deploy is already waiting to run', 202)
    await startDeploy(env, token)
    return text(`Deploy started for ${repository}`, 202)
  },
}

function text(message, status = 200) {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

/** Checks the X-Hub-Signature-256 header, "sha256=<hex HMAC of the body>". */
export async function validSignature(secret, body, header) {
  if (!secret || !header?.startsWith('sha256='))
    return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = [...mac].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const given = header.slice('sha256='.length).toLowerCase()
  if (given.length !== expected.length)
    return false
  let difference = 0
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return difference === 0
}

/** A repository URL in the form the catalog compares. */
export function normalizeRepository(url) {
  return String(url ?? '').trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
}

/** Whether the published catalog lists a plugin released from repository. */
async function isListed(env, repository) {
  if (!repository)
    return false
  const response = await fetch(`${env.CATALOG_URL.replace(/\/+$/, '')}/v1/index.json`, { cf: { cacheTtl: 60 } })
  if (!response.ok)
    throw new Error(`catalog: HTTP ${response.status}`)
  const index = await response.json()
  const wanted = normalizeRepository(repository)
  return (index.plugins ?? []).some(plugin => normalizeRepository(plugin.repository_url) === wanted)
}

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  })
  if (!response.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

/**
 * Takes the cooldown of a repository in the cache of the data center, false
 * when it is still running. GitHub delivers from few addresses, so its
 * deliveries mostly meet in the same data centers. Without a cache, as in a
 * test, nothing is limited.
 */
async function claimCooldown(requestUrl, repository) {
  const cache = globalThis.caches?.default
  if (!cache)
    return true
  const key = new URL(`/cooldown/${encodeURIComponent(normalizeRepository(repository))}`, requestUrl).toString()
  if (await cache.match(key))
    return false
  await cache.put(key, new Response('1', { headers: { 'Cache-Control': `max-age=${COOLDOWN_SECONDS}` } }))
  return true
}

/** Whether a run of the deploy workflow is waiting to start. */
async function deployWaiting(env, token) {
  const runs = await github(`/repos/${env.CATALOG_REPO}/actions/workflows/${env.DEPLOY_WORKFLOW}/runs?branch=${encodeURIComponent(env.DEPLOY_REF)}&per_page=10`, token)
  return (runs.workflow_runs ?? []).some(run => WAITING.has(run.status))
}

/** Runs the deploy workflow of the catalog repository. */
async function startDeploy(env, token) {
  await github(`/repos/${env.CATALOG_REPO}/actions/workflows/${env.DEPLOY_WORKFLOW}/dispatches`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.DEPLOY_REF }),
  })
}

/** A short lived token of the deploy App for the catalog repository, allowed
 * to read and start its workflows. */
async function installationToken(env) {
  const jwt = await appJwt(env.DEPLOY_APP_ID, env.DEPLOY_APP_PRIVATE_KEY)
  const installation = await github(`/repos/${env.CATALOG_REPO}/installation`, jwt)
  const [, name] = env.CATALOG_REPO.split('/')
  const access = await github(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [name], permissions: { actions: 'write' } }),
  })
  return access.token
}

function base64url(bytes) {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The JWT a GitHub App authenticates with, valid for nine minutes. */
export async function appJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('pkcs8', pkcs8FromPem(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)))
  // Issued a minute back to allow for clock drift, as GitHub recommends.
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))
  return `${unsigned}.${base64url(signature)}`
}

function derLength(length) {
  if (length < 0x80)
    return [length]
  const bytes = []
  for (let rest = length; rest > 0; rest >>= 8)
    bytes.unshift(rest & 0xFF)
  return [0x80 | bytes.length, ...bytes]
}

function der(tag, content) {
  return [tag, ...derLength(content.length), ...content]
}

/** The PKCS#8 DER of a PEM private key. A PKCS#1 key, the form GitHub hands
 * out, is wrapped into PKCS#8 for WebCrypto. */
export function pkcs8FromPem(pem) {
  const text = String(pem ?? '').replace(/\\n/g, '\n')
  const pkcs1 = text.includes('BEGIN RSA PRIVATE KEY')
  const encoded = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
  if (!pkcs1)
    return bytes
  // SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption OID, NULL }, OCTET STRING key }
  const rsaEncryption = [0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00]
  return Uint8Array.from(der(0x30, [
    0x02, 0x01, 0x00,
    ...der(0x30, rsaEncryption),
    ...der(0x04, [...bytes]),
  ]))
}
