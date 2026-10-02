// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listReleases } from './github.mjs'
import { channelToSet, inferChannel, keepRecentNotes, MAX_NOTES_LENGTH, missingReleases, releaseNotes, sortReleases, tagVersion } from './releases.mjs'

const gh = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra })

test('inferChannel follows the prerelease part', () => {
  assert.equal(inferChannel('1.0.0'), 'stable')
  assert.equal(inferChannel('1.0.0+build-5'), 'stable')
  for (const version of ['1.0.0-beta.1', '2.0.0-rc.1+build.5', '1.0.0-pre', '1.0.0-alphabet'])
    assert.equal(inferChannel(version), 'beta', version)
  for (const version of ['1.0.0-alpha', '1.0.0-DEV.3', '1.0.0-nightly.20260930', '1.0.0-snapshot', '1.0.0-canary.2', '1.0.0-preview.1'])
    assert.equal(inferChannel(version), 'dev', version)
})

test('channelToSet only names a channel a host could not infer', () => {
  assert.equal(channelToSet('1.0.0', gh('v1.0.0')), undefined)
  assert.equal(channelToSet('1.0.0-beta.1', gh('v1.0.0-beta.1', { prerelease: true })), undefined)
  assert.equal(channelToSet('1.0.0-beta.1', gh('v1.0.0-beta.1')), undefined)
  assert.equal(channelToSet('1.0.0-nightly.1', gh('v1.0.0-nightly.1', { prerelease: true })), undefined)
  // GitHub calls it a prerelease but the version reads as stable.
  assert.equal(channelToSet('1.0.0', gh('v1.0.0', { prerelease: true })), 'beta')
})

test('missingReleases lists every version the entry lacks, oldest first', () => {
  const entry = { releases: [{ version: '1.0.0' }, { version: '1.2.0' }] }
  const releases = [
    gh('v1.3.0-beta.10', { prerelease: true }),
    gh('v1.3.0-beta.9', { prerelease: true }),
    gh('v1.2.0'),
    gh('v1.1.0'),
    gh('v1.0.0'),
    gh('v0.9.0'),
    gh('v2.0.0', { draft: true }),
    gh('nightly'),
    gh('1.1.0'),
  ]
  const warnings = []
  const missing = missingReleases(entry, releases, message => warnings.push(message))
  assert.deepEqual(missing.map(release => tagVersion(release.tag_name)), ['0.9.0', '1.1.0', '1.3.0-beta.9', '1.3.0-beta.10'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /nightly/)
})

test('missingReleases is empty for an entry that lists everything', () => {
  const entry = { releases: [{ version: '1.0.0' }] }
  assert.deepEqual(missingReleases(entry, [gh('v1.0.0')]), [])
  assert.deepEqual(missingReleases({}, []), [])
})

test('sortReleases orders by semantic version', () => {
  const sorted = sortReleases([{ version: '1.1.0' }, { version: '1.1.0-beta.10' }, { version: '1.1.0-beta.9' }, { version: '0.9.0' }])
  assert.deepEqual(sorted.map(release => release.version), ['0.9.0', '1.1.0-beta.9', '1.1.0-beta.10', '1.1.0'])
})

test('listReleases follows the pages and drops drafts', async () => {
  const pages = {
    1: Array.from({ length: 100 }, (_, i) => gh(`v1.0.${i}`)),
    2: [gh('v0.9.0'), gh('v0.8.0', { draft: true })],
  }
  const urls = []
  const fakeFetch = async (url) => {
    urls.push(url)
    const page = Number(new URL(url).searchParams.get('page'))
    return { ok: true, status: 200, json: async () => pages[page] ?? [], text: async () => '' }
  }
  const releases = await listReleases('o', 'r', undefined, fakeFetch)
  assert.equal(releases.length, 101)
  assert.equal(urls.length, 2)
  assert.ok(releases.every(release => !release.draft))
})

test('listReleases returns nothing for a repository without releases', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  assert.deepEqual(await listReleases('o', 'r', undefined, fakeFetch), [])
})

test('listReleases reports a failing request', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'rate limited' })
  await assert.rejects(listReleases('o', 'r', undefined, fakeFetch), /HTTP 403/)
})

test('releaseNotes keeps a short body and cuts a long one at a line break', () => {
  assert.equal(releaseNotes('', 'https://x/r'), undefined)
  assert.equal(releaseNotes(' \r\n ', 'https://x/r'), undefined)
  assert.equal(releaseNotes('### Features\r\n\r\n- One\r\n', 'https://x/r'), '### Features\n\n- One')

  const line = `- ${'a'.repeat(98)}\n`
  const notes = releaseNotes(line.repeat(100), 'https://x/r')
  assert.ok(notes.length <= MAX_NOTES_LENGTH)
  assert.ok(notes.endsWith('\n\n[Full release notes](https://x/r)'))
  const kept = notes.slice(0, notes.indexOf('\n\n[Full'))
  assert.ok(kept.split('\n').every(l => l === line.trimEnd()), 'cut inside a line')
})

test('keepRecentNotes drops the notes of all but the newest releases', () => {
  const releases = ['1.0.0', '1.2.0', '1.10.0', '1.3.0', '2.0.0-beta.1', '1.1.0']
    .map(version => ({ version, notes: `notes ${version}` }))
  const trimmed = keepRecentNotes(releases, 3)
  assert.deepEqual(trimmed.map(r => r.version), releases.map(r => r.version))
  assert.deepEqual(trimmed.filter(r => r.notes).map(r => r.version), ['1.10.0', '1.3.0', '2.0.0-beta.1'])
  assert.ok(releases.every(r => r.notes), 'the input is left as it was')
})
