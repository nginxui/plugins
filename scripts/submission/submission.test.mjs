// Run with: node --test scripts/ci/*.test.mjs scripts/submission/*.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { newMinisignKey } from '../ci/test-minisign.mjs'
import { checkEligibility, draftEntry } from './core.mjs'
import { parseFormFields, submissionFromIssue } from './issue.mjs'
import { escapeText, renderPreview } from './preview.mjs'

const ID = 'io.github.alice.demo'
const key = newMinisignKey()
let repository
let releases
let manifest
let publicMembers
const realFetch = globalThis.fetch

beforeEach(() => {
  repository = { full_name: 'alice/demo', name: 'demo', private: false, owner: { login: 'alice', id: 7, type: 'User' }, topics: [], license: { spdx_id: 'MIT' } }
  manifest = { id: ID, name: 'Demo', capabilities: ['dns01'] }
  releases = [
    { tag_name: 'v1.1.0-beta.1', prerelease: true, assets: [] },
    { tag_name: 'v1.0.0', prerelease: false, html_url: 'https://github.com/alice/demo/releases/tag/v1.0.0', assets: [{ name: `${ID}-1.0.0.tar.gz` }] },
  ]
  publicMembers = new Set()
  globalThis.fetch = async (url) => {
    const json = body => new Response(JSON.stringify(body), { status: 200 })
    if (url === 'https://api.github.com/repos/alice/demo')
      return json(repository)
    if (url.startsWith('https://api.github.com/repos/alice/demo/releases'))
      return json(releases)
    if (url === 'https://raw.githubusercontent.com/alice/demo/v1.0.0/plugin.json')
      return new Response(JSON.stringify(manifest), { status: 200 })
    const member = url.match(/^https:\/\/api\.github\.com\/orgs\/([^/]+)\/public_members\/([^/]+)$/)
    if (member)
      return new Response(null, { status: publicMembers.has(`${member[1]}/${member[2]}`) ? 204 : 404 })
    return new Response('not found', { status: 404 })
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const submission = (extra = {}) => ({
  repository_url: 'https://github.com/alice/demo',
  author_public_key: key.publicKey,
  categories: [],
  submitter: { login: 'alice', id: 7 },
  ...extra,
})
const options = (extra = {}) => ({ blocked: { plugins: [], repositories: [] }, entriesDir: mkdtempSync(path.join(tmpdir(), 'entries-')), ...extra })

test('a submission drafts an entry from the newest stable release', async () => {
  const { entry, tag } = await draftEntry(submission(), options())
  assert.equal(tag, 'v1.0.0')
  assert.deepEqual(entry, {
    id: ID,
    name: { en: 'Demo' },
    author: 'alice',
    author_public_key: key.publicKey.trim().split('\n').at(-1),
    repository_url: 'https://github.com/alice/demo',
    categories: ['certificates', 'dns'],
    license: 'MIT',
    trust: 'community',
  })
  const picked = await draftEntry(submission({ categories: ['tools'] }), options())
  assert.deepEqual(picked.entry.categories, ['tools'])
})

test('a submission is rejected with a reason the author can act on', async () => {
  const rejected = async (sub, opts = options()) => (await draftEntry(sub, opts)).rejection ?? ''
  assert.match(await rejected(submission({ repository_url: 'https://gitlab.com/alice/demo' })), /not a github\.com repository/)
  assert.match(await rejected(submission({ author_public_key: 'nope' })), /not a minisign public key/)
  assert.match(await rejected(submission({ categories: ['games'] })), /Unknown categories: games/)
  assert.match(await rejected(submission(), options({ blocked: { plugins: [], repositories: ['Alice/Demo'] } })), /may not be listed/)
  assert.match(await rejected(submission(), options({ blocked: { plugins: [ID], repositories: [] } })), /may not be listed/)

  const listed = options()
  writeFileSync(path.join(listed.entriesDir, `${ID}.json`), '{}')
  assert.match(await rejected(submission(), listed), /listed already/)

  manifest.id = 'io.github.bob.demo'
  releases[1].assets = [{ name: 'io.github.bob.demo-1.0.0.tar.gz' }]
  assert.match(await rejected(submission()), /names the GitHub owner bob/)
  manifest.id = 'com.nginxui.demo'
  assert.match(await rejected(submission()), /reserved/)
  manifest.id = ID
  releases[1].assets = []
  assert.match(await rejected(submission()), /has no io\.github\.alice\.demo-1\.0\.0\.tar\.gz/)
  releases = []
  assert.match(await rejected(submission()), /has no GitHub Release/)
})

test('the repository owner, its topic or a public member may submit', async () => {
  const submitter = { login: 'alice', id: 7 }
  assert.equal((await checkEligibility(repository, submitter)).eligible, true)
  assert.equal((await checkEligibility(repository, { login: 'bob', id: 8 })).eligible, false)
  assert.equal((await checkEligibility({ ...repository, topics: ['nginx-ui-plugin'] }, { login: 'bob', id: 8 })).eligible, true)

  const org = { ...repository, full_name: 'acme/demo', owner: { login: 'acme', id: 9, type: 'Organization' } }
  assert.equal((await checkEligibility(org, submitter)).eligible, false)
  publicMembers.add('acme/alice')
  assert.equal((await checkEligibility(org, submitter)).eligible, true)
})

test('an issue body becomes a submission', () => {
  const body = [
    '### Repository URL', '', 'https://github.com/alice/demo', '',
    '### Primary public key', '', '```', key.publicKey.trim(), '```', '',
    '### Categories', '', 'certificates, dns', '',
    '### Checklist', '', '- [x] done',
  ].join('\n')
  assert.equal(parseFormFields('### A\n\n_No response_\n').A, '')
  assert.deepEqual(submissionFromIssue({ body, user: { login: 'alice', id: 7 } }), {
    repository_url: 'https://github.com/alice/demo',
    author_public_key: key.publicKey.trim(),
    categories: ['certificates', 'dns'],
    submitter: { login: 'alice', id: 7 },
  })
})

test('a preview shows plugin text as text', () => {
  assert.equal(escapeText('<b>@everyone</b> *x*'), '&lt;b&gt;@\u200Beveryone&lt;/b&gt; \\*x\\*')
  const preview = renderPreview({
    name: { en: 'Demo' },
    description: { en: 'Pings @admins <script>' },
    releases: [{ version: '1.0.0', signer: 'ABCDEF0123456789', platforms: ['linux-amd64'], manifest: { permissions: ['network'], permission_reasons: { network: 'Calls the API' } } }],
    screenshots: [{ url: 'https://raw.githubusercontent.com/alice/demo/v1.0.0/1.png', caption: { en: 'Dash' } }],
  })
  assert.match(preview, /Pings @\u200Badmins &lt;script&gt;/)
  assert.match(preview, /1\.0\.0 \(stable\), signed by key `ABCDEF0123456789`/)
  assert.match(preview, /- `network`: Calls the API/)
  assert.match(preview, /<img src="https:\/\/raw\.githubusercontent\.com\/alice\/demo\/v1\.0\.0\/1\.png" width="200" alt=""><\/a> \|\n\| --- \|\n\| Dash \|/)
})
