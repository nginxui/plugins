import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMemory, offeredReleases, renderNotes, renderSite } from '../site.mjs'

test('release notes keep headings, lists and links, and escape the rest', () => {
  const html = renderNotes('### Features\n\n- Add `x` and **y**\n- See [docs](https://example.com/a?b=1&c=2)\n\nA <b>raw</b> line')
  assert.equal(html, '<h4>Features</h4><ul><li>Add <code>x</code> and <strong>y</strong></li><li>See <a href="https://example.com/a?b=1&#38;c=2" rel="noopener nofollow">docs</a></li></ul><p>A &#60;b&#62;raw&#60;/b&#62; line</p>')
})

test('release notes drop links that are not http', () => {
  assert.equal(renderNotes('[click](javascript:alert(1))'), '<p>click)</p>')
})

test('memory reads like Nginx UI shows it', () => {
  assert.equal(formatMemory(256), '256 MB')
  assert.equal(formatMemory(1024), '1 GB')
  assert.equal(formatMemory(1536), '1.5 GB')
})

test('a yanked release is never offered and a newer prerelease is a preview', () => {
  const { stable, preview } = offeredReleases([
    { version: '1.0.0' },
    { version: '1.1.0', yanked: true },
    { version: '1.2.0-beta.1' },
  ])
  assert.equal(stable.version, '1.0.0')
  assert.equal(preview.version, '1.2.0-beta.1')
})

test('every language has a list and a page per plugin', () => {
  const plugin = {
    id: 'com.example.demo',
    name: { en: 'Demo <x>' },
    description: { en: 'Does things' },
    author: 'someone',
    trust: 'community',
    capabilities: ['http'],
    releases: [{ version: '1.0.0', released_at: '2026-10-01T00:00:00Z', platforms: ['any'], manifest: { permissions: ['network'], network_hosts: ['api.example.com'], server: { resources: { recommended_memory_mb: 128 } } } }],
  }
  const pages = new Map(renderSite({ updated_at: '2026-10-02T00:00:00Z', plugins: [plugin] }))
  assert.deepEqual([...pages.keys()].sort(), [
    'index.html',
    'ja_JP/index.html',
    'ja_JP/plugins/com.example.demo/index.html',
    'plugins/com.example.demo/index.html',
    'zh_CN/index.html',
    'zh_CN/plugins/com.example.demo/index.html',
    'zh_TW/index.html',
    'zh_TW/plugins/com.example.demo/index.html',
  ])
  const page = pages.get('plugins/com.example.demo/index.html')
  assert.match(page, /<h1>Demo &#60;x&#62;<\/h1>/)
  assert.match(page, /<code>api\.example\.com<\/code>/)
  assert.match(page, /128 MB/)
  assert.doesNotMatch(page, /<x>/)
  assert.match(pages.get('index.html'), /href="\/plugins\/com\.example\.demo\/" data-plugin="com\.example\.demo"/)
})
