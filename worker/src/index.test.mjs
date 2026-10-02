// Run with: node --test worker/src/*.test.mjs
import assert from 'node:assert/strict'
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto'
import { afterEach, test } from 'node:test'
import worker, { appJwt, normalizeRepository, pkcs8FromPem, validSignature } from './index.js'

const secret = 'test-secret'
const sign = body => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' })
const env = {
  WEBHOOK_SECRET: secret,
  DEPLOY_APP_ID: '42',
  DEPLOY_APP_PRIVATE_KEY: pkcs1,
  CATALOG_URL: 'https://plugins.example.com',
  CATALOG_REPO: 'nginxui/plugins',
  DEPLOY_WORKFLOW: 'deploy.yml',
  DEPLOY_REF: 'main',
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete globalThis.caches
})

/** A cache of the data center that keeps every entry until the test ends. */
function fakeCache() {
  const entries = new Map()
  globalThis.caches = {
    default: {
      match: async key => entries.get(String(key)),
      put: async (key, response) => { entries.set(String(key), response) },
    },
  }
  return entries
}

/** Answers the catalog and the GitHub API, recording every request. runs are
 * the recent deploy runs GitHub lists. */
function fakeFetch(listed, runs = [{ status: 'completed' }]) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === 'https://plugins.example.com/v1/index.json')
      return json({ plugins: listed.map(repository_url => ({ repository_url })) })
    if (url === 'https://api.github.com/repos/nginxui/plugins/installation')
      return json({ id: 7 })
    if (url === 'https://api.github.com/app/installations/7/access_tokens')
      return json({ token: 'installation-token' })
    if (url === 'https://api.github.com/repos/nginxui/plugins/actions/workflows/deploy.yml/runs?branch=main&per_page=10')
      return json({ workflow_runs: runs })
    if (url === 'https://api.github.com/repos/nginxui/plugins/actions/workflows/deploy.yml/dispatches')
      return new Response(null, { status: 204 })
    return new Response('unexpected', { status: 500 })
  }
  return calls
}

function delivery(event, payload, signature) {
  const body = JSON.stringify(payload)
  return new Request('https://hook.example.com/github', {
    method: 'POST',
    body,
    headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': signature ?? sign(body) },
  })
}

const released = repository => ({ action: 'published', release: { draft: false }, repository: { html_url: repository } })

test('validSignature accepts only the HMAC of the body', async () => {
  assert.equal(await validSignature(secret, 'body', sign('body')), true)
  assert.equal(await validSignature(secret, 'body', sign('other')), false)
  assert.equal(await validSignature(secret, 'body', 'sha1=00'), false)
  assert.equal(await validSignature('', 'body', sign('body')), false)
  assert.equal(await validSignature(secret, 'body', null), false)
})

test('a PKCS#1 key from GitHub signs a JWT the public key verifies', async () => {
  assert.equal(pkcs8FromPem(pkcs1).length, privateKey.export({ type: 'pkcs8', format: 'der' }).length)
  const jwt = await appJwt('42', pkcs1, 1_000_000)
  const [header, claims, signature] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iat: 999_940, exp: 1_000_540, iss: '42' })
  const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`)
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true)
})

test('normalizeRepository ignores case, a trailing slash and .git', () => {
  assert.equal(normalizeRepository('https://GitHub.com/Example/Plugin.git/'), 'https://github.com/example/plugin')
})

test('a release of a listed plugin runs the deploy workflow', async () => {
  const calls = fakeFetch(['https://github.com/example/plugin'])
  const response = await worker.fetch(delivery('release', released('https://github.com/Example/plugin')), env)
  assert.equal(response.status, 202)
  const dispatch = calls.at(-1)
  assert.equal(dispatch.url, 'https://api.github.com/repos/nginxui/plugins/actions/workflows/deploy.yml/dispatches')
  assert.equal(dispatch.init.headers.Authorization, 'Bearer installation-token')
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: 'main' })
  const token = calls.find(call => call.url.endsWith('/access_tokens'))
  assert.deepEqual(JSON.parse(token.init.body), { repositories: ['plugins'], permissions: { actions: 'write' } })
})

test('a release of a plugin the catalog does not list starts nothing', async () => {
  const calls = fakeFetch(['https://github.com/example/plugin'])
  const response = await worker.fetch(delivery('release', released('https://github.com/someone/else')), env)
  assert.equal(response.status, 202)
  assert.equal(calls.some(call => call.url.includes('/dispatches')), false)
})

test('a forged, a draft or another event starts nothing', async () => {
  const calls = fakeFetch(['https://github.com/example/plugin'])
  assert.equal((await worker.fetch(delivery('release', released('https://github.com/example/plugin'), sign('other')), env)).status, 401)
  const draft = { ...released('https://github.com/example/plugin'), release: { draft: true } }
  assert.equal((await worker.fetch(delivery('release', draft), env)).status, 202)
  for (const action of ['created', 'edited', 'deleted', 'unpublished', 'released', 'prereleased'])
    assert.equal((await worker.fetch(delivery('release', { ...released('https://github.com/example/plugin'), action }), env)).status, 202, action)
  assert.equal((await worker.fetch(delivery('push', {}), env)).status, 202)
  assert.equal((await worker.fetch(delivery('ping', {}), env)).status, 200)
  assert.equal(calls.length, 0)
})

test('only POST /github is served', async () => {
  assert.equal((await worker.fetch(new Request('https://hook.example.com/'), env)).status, 404)
  assert.equal((await worker.fetch(new Request('https://hook.example.com/github'), env)).status, 405)
})

test('nothing starts while a deploy waits to run', async () => {
  for (const status of ['queued', 'pending', 'requested', 'waiting']) {
    const calls = fakeFetch(['https://github.com/example/plugin'], [{ status: 'in_progress' }, { status }])
    const response = await worker.fetch(delivery('release', released('https://github.com/example/plugin')), env)
    assert.equal(response.status, 202)
    assert.equal(calls.some(call => call.url.includes('/dispatches')), false, status)
  }
})

test('a running deploy does not hold back the next one', async () => {
  const calls = fakeFetch(['https://github.com/example/plugin'], [{ status: 'in_progress' }])
  await worker.fetch(delivery('release', released('https://github.com/example/plugin')), env)
  assert.equal(calls.filter(call => call.url.includes('/dispatches')).length, 1)
})

test('a repository starts the deploy once per cooldown', async () => {
  fakeCache()
  const calls = fakeFetch(['https://github.com/example/plugin', 'https://github.com/example/other'])
  const dispatches = () => calls.filter(call => call.url.includes('/dispatches')).length
  await worker.fetch(delivery('release', released('https://github.com/example/plugin')), env)
  const again = await worker.fetch(delivery('release', released('https://github.com/Example/plugin/')), env)
  assert.equal(again.status, 202)
  assert.match(await again.text(), /less than 60 seconds ago/)
  assert.equal(dispatches(), 1)
  // Another repository has a cooldown of its own.
  await worker.fetch(delivery('release', released('https://github.com/example/other')), env)
  assert.equal(dispatches(), 2)
})

