// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assetDigest, buildDownloadsMap } from './release-assets.mjs'

const hex = 'ab'.repeat(32)

test('assetDigest reads the sha256 GitHub computed', () => {
  assert.equal(assetDigest({ digest: `sha256:${hex.toUpperCase()}` }), hex)
  assert.equal(assetDigest({ digest: null }), null)
  assert.equal(assetDigest({}), null)
  assert.equal(assetDigest({ digest: 'sha512:00' }), null)
})

test('buildDownloadsMap takes the digests of the assets without fetching anything', async () => {
  const asset = (name, digest) => ({ name, browser_download_url: `https://example.com/${name}`, digest })
  const assets = [
    asset('x.y-1.0.0-linux-amd64.tar.gz', `sha256:${hex}`),
    asset('x.y-1.0.0-linux-amd64.tar.gz.sha256', 'sha256:00'),
    asset('x.y-1.0.0-darwin-arm64.tar.gz', `sha256:${'cd'.repeat(32)}`),
    asset('x.y-1.0.0.tar.gz', `sha256:${hex}`),
  ]
  const { downloads, platforms } = await buildDownloadsMap(assets, 'x.y', '1.0.0', { token: undefined })
  assert.deepEqual(platforms, ['darwin-arm64', 'linux-amd64'])
  assert.deepEqual(downloads['linux-amd64'], { url: 'https://example.com/x.y-1.0.0-linux-amd64.tar.gz', sha256: hex })
  assert.equal(downloads['darwin-arm64'].sha256, 'cd'.repeat(32))
})
