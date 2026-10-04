// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { descriptionProblem, manifestNames, pendingNames, reservedWord } from './names.mjs'

test('a name claiming to be official holds a reserved word, a negated one does not', () => {
  assert.equal(reservedWord('Official DNS'), 'official')
  assert.equal(reservedWord('Unofficial DNS'), '')
  assert.equal(reservedWord('官方 DNS 插件'), '官方')
  assert.equal(reservedWord('非官方 DNS 插件'), '')
  assert.equal(reservedWord('DNS 公式プラグイン'), '公式')
  assert.equal(reservedWord('非公式 DNS'), '')
  assert.equal(reservedWord('GeoIP 访问控制'), '')
  // A bidi override makes a name read otherwise than it looks.
  assert.equal(reservedWord('Demo\u202Elaiciffo'), 'an invisible character')
  assert.equal(reservedWord('De\u200Bmo'), 'an invisible character')
})

test('manifest names leave out English, empty names and unknown locales', () => {
  const manifest = { name: 'Demo', i18n: { en: { name: 'Demo' }, zh_CN: { name: ' 演示 ' }, ja_JP: { name: '' }, 'zh-hant': { name: '示範' } } }
  assert.deepEqual(manifestNames(manifest), { zh_CN: '演示' })
})

test('a description may name an official API, not claim to be an official Nginx UI plugin', () => {
  assert.equal(descriptionProblem('Issues certificates through the official Cloudflare API. Works with Nginx UI 2.8.'), '')
  assert.equal(descriptionProblem('通过阿里云官方 API 申请证书'), '')
  assert.equal(descriptionProblem('The official DNS plugin of Nginx UI.'), 'a claim to be official')
  assert.equal(descriptionProblem('Nginx UI 官方出品的 DNS 插件'), 'a claim to be official')
  assert.equal(descriptionProblem('NginxUI 公式の DNS プラグイン'), 'a claim to be official')
  assert.equal(descriptionProblem('A DNS plugin.\nUnofficial, not affiliated with Nginx UI.'), '')
  assert.equal(descriptionProblem('A DNS\u202E plugin'), 'an invisible character')
})

test('an English name the entry does not hold waits too', () => {
  assert.deepEqual(pendingNames({ en: 'Demo' }, { name: ' Demo Pro ' }), { names: { en: 'Demo Pro' }, blocked: {} })
  assert.equal(pendingNames({ en: 'Demo' }, { name: 'Demo' }), undefined)
})

test('pending names are the ones the entry does not hold', () => {
  const manifest = { i18n: { zh_CN: { name: '演示' }, zh_TW: { name: '官方示範' }, ja_JP: { name: 'デモ' } } }
  assert.deepEqual(pendingNames({ en: 'Demo', ja_JP: 'デモ' }, manifest), {
    names: { zh_CN: '演示' },
    blocked: { zh_TW: { name: '官方示範', word: '官方' } },
  })
  assert.equal(pendingNames({ en: 'Demo', zh_CN: '演示', ja_JP: 'デモ' }, { i18n: { zh_CN: { name: '演示' }, ja_JP: { name: 'デモ' } } }), undefined)
})
