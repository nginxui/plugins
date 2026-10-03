// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { categoriesFromManifest } from './manifest-snapshot.mjs'

const schema = JSON.parse(readFileSync(new URL('../../schema/entry.schema.json', import.meta.url)))

test('capabilities and content file a plugin under schema categories', () => {
  assert.deepEqual(categoriesFromManifest({ capabilities: ['dns01'] }), ['certificates', 'dns'])
  assert.deepEqual(categoriesFromManifest({ capabilities: ['notify', 'cert.deploy'] }), ['notifications', 'certificates'])
  assert.deepEqual(categoriesFromManifest({ content: { templates: 'templates', locales: 'locales' } }), ['templates', 'languages'])
  assert.deepEqual(categoriesFromManifest({ capabilities: ['http'] }), [])
})

test('a draft keeps at most three categories', () => {
  const manifest = { capabilities: ['dns01', 'probe', 'notify', 'storage'] }
  assert.deepEqual(categoriesFromManifest(manifest), ['certificates', 'dns', 'monitoring'])
})

test('every category a capability maps to is in the entry schema', () => {
  const known = new Set(schema.$defs.category.enum)
  const manifest = {
    capabilities: ['dns01', 'cert.deploy', 'security.blocklist', 'upstream.discovery', 'probe', 'log.sink', 'notify', 'storage', 'mcp'],
    content: { templates: 't', locales: 'l' },
  }
  for (const capability of manifest.capabilities) {
    for (const category of categoriesFromManifest({ capabilities: [capability] }))
      assert.ok(known.has(category), `${capability} maps to ${category}`)
  }
  for (const category of categoriesFromManifest({ content: manifest.content }))
    assert.ok(known.has(category), category)
})
