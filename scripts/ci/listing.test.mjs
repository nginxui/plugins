// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { deriveListing, displayRelease, listingChanges } from './listing.mjs'

const repo = { owner: 'example', repo: 'demo' }
const site = 'https://plugins.nginxui.com'
const raw = file => `https://raw.githubusercontent.com/example/demo/v1.1.0/${file}`

// HEAD answers by URL: a content type, or a status.
let answers
let requested
const realFetch = globalThis.fetch
beforeEach(() => {
  answers = new Map()
  requested = []
  globalThis.fetch = async (url) => {
    requested.push(url)
    const answer = answers.get(url) ?? 404
    return typeof answer === 'number'
      ? new Response(null, { status: answer })
      : new Response(null, { status: 200, headers: { 'content-type': answer, 'content-length': '1000' } })
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const manifest = {
  description: 'Does things',
  homepage_url: 'https://example.com/demo',
  i18n: {
    zh_CN: { name: '演示', description: '做事情', screenshot_captions: { dashboard: '面板' } },
    ja_JP: { name: '', description: '' },
  },
  screenshots: [{ id: 'dashboard', path: 'docs/1.png', dark_path: 'docs/1-dark.png', caption: 'Dashboard' }, { id: 'search', path: 'docs/2.png' }],
}
const releases = [
  { version: '1.0.0', manifest: { description: 'Old' } },
  { version: '1.1.0', manifest },
  { version: '1.2.0-beta.1', manifest: { description: 'Beta' } },
]
const tags = new Map([['1.0.0', 'v1.0.0'], ['1.1.0', 'v1.1.0'], ['1.2.0-beta.1', 'v1.2.0-beta.1']])
const entry = { id: 'io.github.example.demo', name: { en: 'Demo' }, repository_url: 'https://github.com/example/demo' }

test('the display release is the newest stable one that is not yanked', () => {
  assert.equal(displayRelease(releases).version, '1.1.0')
  assert.equal(displayRelease([releases[0], { ...releases[1], yanked: true }, releases[2]]).version, '1.0.0')
  assert.equal(displayRelease([releases[2]]).version, '1.2.0-beta.1')
  assert.equal(displayRelease([{ ...releases[2], yanked: true }]), undefined)
})

test('a listing comes from the display release, the entry overrides it', async () => {
  answers.set(raw('README.md'), 'text/plain')
  answers.set(raw('docs/1.png'), 'image/png')
  answers.set(raw('docs/1-dark.png'), 'image/png')
  answers.set(raw('docs/2.png'), 'text/html')
  const icons = new Map([['1.1.0', { type: 'svg', bytes: Buffer.from('<svg/>') }]])

  const { fields, icon, warnings } = await deriveListing({ ...entry, description: { ja_JP: 'もの' } }, releases, undefined, { repo, tags, icons, site })
  // The English name stays the reviewed one, empty translations are left out.
  assert.deepEqual(Object.entries(fields.name), [['en', 'Demo'], ['zh_CN', '演示']])
  assert.deepEqual(Object.entries(fields.description), [['en', 'Does things'], ['ja_JP', 'もの'], ['zh_CN', '做事情']])
  assert.equal(fields.homepage_url, 'https://example.com/demo')
  assert.equal(fields.readme_url, raw('README.md'))
  assert.deepEqual(fields.screenshots, [{ url: raw('docs/1.png'), dark_url: raw('docs/1-dark.png'), caption: { en: 'Dashboard', zh_CN: '面板' } }])
  assert.match(warnings.join('\n'), /docs\/2\.png is text\/html/)
  assert.equal(fields.icon_url, `${site}/v1/icons/io.github.example.demo/1.1.0.svg`)
  assert.equal(icon.path, 'v1/icons/io.github.example.demo/1.1.0.svg')
})

test('what the published listing checked is not fetched again', async () => {
  const published = {
    readme_url: raw('README.md'),
    screenshots: [{ url: raw('docs/1.png'), dark_url: raw('docs/1-dark.png'), caption: { en: 'Dashboard', zh_CN: '面板' } }, { url: raw('docs/2.png') }],
    icon_url: `${site}/v1/icons/io.github.example.demo/1.0.0.png`,
  }
  const { fields, icon } = await deriveListing(entry, releases, published, { repo, tags, icons: new Map(), site })
  assert.deepEqual(requested, [])
  assert.equal(fields.screenshots.length, 2)
  // The icon of an earlier display release is not carried over, the site is
  // asked for the one of 1.1.0 under each icon type.
  assert.deepEqual(icon, {
    version: '1.1.0',
    candidates: ['svg', 'png', 'webp'].map(type => `v1/icons/io.github.example.demo/1.1.0.${type}`),
  })
  assert.equal(fields.icon_url, undefined)

  // The icon the published listing names for the display release is the only
  // one asked for.
  const named = await deriveListing(entry, releases, { ...published, icon_url: `${site}/v1/icons/io.github.example.demo/1.1.0.png` }, { repo, tags, icons: new Map(), site })
  assert.deepEqual(named.icon, { version: '1.1.0', candidates: ['v1/icons/io.github.example.demo/1.1.0.png'] })
})

test('an entry field replaces what the release gives', async () => {
  const overridden = { ...entry, readme_url: 'https://example.com/readme.md', icon_url: 'https://example.com/icon.png', screenshots: [] }
  const { fields, icon } = await deriveListing(overridden, releases, undefined, { repo, tags, icons: new Map([['1.1.0', { type: 'png', bytes: Buffer.alloc(1) }]]), site })
  assert.deepEqual(requested, [])
  assert.equal(fields.readme_url, 'https://example.com/readme.md')
  assert.equal(fields.icon_url, 'https://example.com/icon.png')
  assert.deepEqual(fields.screenshots, [])
  // The package icon is still served, so dropping the override keeps it.
  assert.equal(icon.path, 'v1/icons/io.github.example.demo/1.1.0.png')

  // Without a fresh read the published site is asked, also under an override.
  const carried = await deriveListing(overridden, releases, { icon_url: 'https://example.com/icon.png' }, { repo, tags, icons: new Map(), site })
  assert.equal(carried.fields.icon_url, 'https://example.com/icon.png')
  assert.equal(carried.icon.candidates.length, 3)
})

test('a listing change names the fields that differ', () => {
  assert.deepEqual(listingChanges({ name: { en: 'A' }, readme_url: 'x' }, { name: { en: 'A' } }), ['readme_url'])
  assert.deepEqual(listingChanges({ name: { en: 'A' } }, undefined), ['name'])
})
