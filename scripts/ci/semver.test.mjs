// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareSemver, isSemver } from './semver.mjs'

test('core versions compare numerically', () => {
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1)
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1)
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1)
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0)
})

test('a release sorts after its own prereleases', () => {
  assert.equal(compareSemver('1.1.0', '1.1.0-beta.3'), 1)
  assert.equal(compareSemver('1.1.0-beta.3', '1.1.0'), -1)
  assert.equal(compareSemver('1.0.1', '1.1.0-beta.2'), -1)
})

test('numeric prerelease identifiers compare as numbers', () => {
  assert.equal(compareSemver('1.1.0-beta.10', '1.1.0-beta.9'), 1)
  assert.equal(compareSemver('1.1.0-beta.2', '1.1.0-beta.11'), -1)
  // Without the dot the identifier is text.
  assert.equal(compareSemver('1.1.0-beta10', '1.1.0-beta9'), -1)
  assert.equal(compareSemver('1.1.0-beta.2', '1.1.0-rc.1'), -1)
  assert.equal(compareSemver('1.1.0-beta', '1.1.0-beta.1'), -1)
  assert.equal(compareSemver('1.1.0-1', '1.1.0-alpha'), -1)
})

test('a prerelease part with dashes is kept whole', () => {
  assert.equal(compareSemver('1.0.0-rc-1', '1.0.0-rc-2'), -1)
})

test('isSemver accepts only valid versions', () => {
  assert.equal(isSemver('1.0.0'), true)
  assert.equal(isSemver('1.0.0-beta.1+build.5'), true)
  assert.equal(isSemver('v1.0.0'), false)
  assert.equal(isSemver('1.0'), false)
  assert.equal(isSemver('latest'), false)
})
