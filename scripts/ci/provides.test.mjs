// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providesOf } from '../build-catalog.mjs'

const releases = (...versions) => versions.map(version => ({ version }))
const providers = (...codes) => codes.map(code => ({ code, name: code.toUpperCase() }))
/** "<code>@<since>[..<removed_in>]" for every provider, the default since filled in. */
const ranges = provides => provides.dns01.providers.map(p => `${p.code}@${p.since ?? provides.dns01.since}${p.removed_in ? `..${p.removed_in}` : ''}`)

test('providers since the earliest version leave out a since of their own', () => {
  const declared = new Map([
    ['1.0.0', providers('a')],
    ['1.1.0', providers('a', 'b')],
    ['1.2.0', providers('a', 'b', 'c')],
  ])
  assert.deepEqual(providesOf(releases('1.0.0', '1.1.0', '1.2.0'), declared), {
    dns01: {
      since: '1.0.0',
      providers: [
        { code: 'a', name: 'A' },
        { code: 'b', name: 'B', since: '1.1.0' },
        { code: 'c', name: 'C', since: '1.2.0' },
      ],
    },
  })
})

test('a provider dropped and declared again counts from its return', () => {
  const declared = new Map([['1.0.0', providers('a')], ['1.1.0', providers('b')], ['1.2.0', providers('a', 'b')]])
  assert.deepEqual(ranges(providesOf(releases('1.0.0', '1.1.0', '1.2.0'), declared)), ['a@1.2.0', 'b@1.1.0'])
})

test('the default since follows semantic versioning, not text order', () => {
  const declared = new Map([['1.9.0', providers('a')], ['1.10.0', providers('a', 'b')]])
  assert.equal(providesOf(releases('1.9.0', '1.10.0'), declared).dns01.since, '1.9.0')
})

test('a provider a prerelease dropped stays listed while the newest stable release has it', () => {
  const declared = new Map([['1.0.0', providers('a', 'b')], ['1.1.0-beta.1', providers('a')]])
  assert.deepEqual(ranges(providesOf(releases('1.0.0', '1.1.0-beta.1'), declared)), ['a@1.0.0', 'b@1.0.0..1.1.0-beta.1'])
})

test('a provider leaves once the newest stable release no longer has it', () => {
  const declared = new Map([['1.0.0', providers('a', 'b')], ['1.1.0-beta.1', providers('a')], ['1.1.0', providers('a')]])
  assert.deepEqual(ranges(providesOf(releases('1.0.0', '1.1.0-beta.1', '1.1.0'), declared)), ['a@1.0.0'])
})

test('a yanked stable release does not count as the newest stable one', () => {
  const declared = new Map([['1.0.0', providers('a', 'b')], ['1.1.0', providers('a')]])
  const list = [{ version: '1.0.0' }, { version: '1.1.0', yanked: true }]
  assert.deepEqual(ranges(providesOf(list, declared)), ['a@1.0.0', 'b@1.0.0..1.1.0'])
})

test('past the releases read in this build the published ranges hold', () => {
  const published = { dns01: { since: '1.0.0', providers: [{ code: 'a', name: 'A' }, { code: 'b', name: 'B', since: '1.1.0' }, { code: 'x', name: 'X', removed_in: '1.2.0-beta.1' }] } }
  const declared = new Map([['1.3.0-beta.1', providers('a', 'b', 'd')]])
  const list = releases('1.0.0', '1.1.0', '1.2.0-beta.1', '1.3.0-beta.1')
  assert.deepEqual(ranges(providesOf(list, declared, published)), ['a@1.0.0', 'b@1.1.0', 'd@1.3.0-beta.1', 'x@1.0.0..1.2.0-beta.1'])
})

test('nothing read and nothing published, or no release, provides nothing', () => {
  assert.equal(providesOf([], new Map()), undefined)
  assert.equal(providesOf(releases('1.0.0'), new Map()), undefined)
  assert.equal(providesOf(releases('1.0.0'), new Map([['1.0.0', []]])), undefined)
  const published = { dns01: { since: '1.0.0', providers: [{ code: 'a', name: 'A' }] } }
  assert.deepEqual(providesOf(releases('1.0.0', '1.1.0'), new Map(), published), published)
})
