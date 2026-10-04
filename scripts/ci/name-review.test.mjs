// Run with: node --test scripts/ci/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { covers, issueMarker, pendingDecision, readReview, renderReview, settleReview, submissionIssue, syncNameReviews, untick, withNames } from './name-review.mjs'

const item = { id: 'io.github.alice.demo', version: '1.3.0', names: { zh_CN: '演示', ja_JP: 'デモ' }, blocked: { zh_TW: { name: '官方示範', word: '官方' } } }
const tick = (body, pattern) => body.replace(new RegExp(`^- \\[ \\] (${pattern})`, 'm'), '- [x] $1')

test('a review comment keeps what it asks about', () => {
  const body = renderReview(item, { listed: { zh_CN: '旧名' } })
  assert.match(body, /^- \[ \] `ja_JP` デモ$/m)
  assert.match(body, /^- \[ \] `zh_CN` 演示 \(listed now: 旧名\)$/m)
  assert.match(body, /^- `zh_TW` 官方示範 \("官方"\)$/m)
  assert.deepEqual(readReview(body), { state: 'open', descriptions: {}, ...item })
  // Only blocked names leave nothing to decide.
  const blockedOnly = renderReview({ ...item, names: {} })
  assert.equal(readReview(blockedOnly).state, 'done')
  assert.doesNotMatch(blockedOnly, /- \[ \]/)
})

test('an English name waits like the others, a description left out is only told', () => {
  const body = renderReview({ ...item, names: { en: 'Demo Pro' }, blocked: {} }, { listed: { en: 'Demo' } })
  assert.match(body, /^- \[ \] `en` Demo Pro \(listed now: Demo\)$/m)
  assert.deepEqual(pendingDecision(tick(body, '`en`')).approve, ['en'])

  const told = renderReview({ ...item, names: {}, blocked: {}, descriptions: { en: { text: 'The official Nginx UI DNS plugin.', word: 'a claim to be official' } } })
  assert.match(told, /^### Left off the listing/)
  assert.match(told, /^- `en` The official Nginx UI DNS plugin\. \(a claim to be official\)$/m)
  assert.equal(readReview(told).state, 'done')
  assert.equal(covers(readReview(told), { ...item, names: {}, blocked: {}, descriptions: { en: { text: 'The official Nginx UI DNS plugin.', word: 'a claim to be official' } } }), true)
  assert.equal(covers(readReview(told), { ...item, names: {}, blocked: {}, descriptions: { en: { text: 'Now the official Nginx UI plugin.', word: 'a claim to be official' } } }), false)
})

test('text from the plugin can neither format the comment nor mention anyone', () => {
  const body = renderReview({ ...item, names: { zh_CN: '<b>@everyone</b> `x`' }, blocked: {} })
  assert.match(body, /`zh_CN` &lt;b&gt;@​everyone&lt;\/b&gt; \\`x\\`/)
})

test('a marker only counts at the end of a review comment', () => {
  const body = renderReview(item)
  // Quoted in another comment, such as a drafted entry, it is not a review.
  assert.equal(readReview(`### Checks passed\n\n\`\`\`json\n${body}\n\`\`\`\n<!-- submission -->`), null)
  assert.equal(readReview(`Some text\n${body}`), null)
})

test('the comment as it is decides: ticked names not yet listed, and decline', () => {
  const body = renderReview(item)
  assert.equal(pendingDecision(body), null)
  const ticked = tick(body, '`zh_CN`')
  assert.deepEqual(pendingDecision(ticked), { review: readReview(body), approve: ['zh_CN'], decline: false })
  // Two ticks whose runs merged are both decided.
  assert.deepEqual(pendingDecision(tick(ticked, '`ja_JP`')).approve, ['ja_JP', 'zh_CN'])
  // A listed name is not decided again.
  const settled = settleReview(ticked, pendingDecision(ticked), 'jacky').body
  assert.equal(pendingDecision(settled), null)
  assert.deepEqual(pendingDecision(tick(settled, 'Decline')), { review: readReview(body), approve: [], decline: true })
  // Unticking a failed approval lets ticking retry it, a listed name stays.
  assert.equal(pendingDecision(untick(tick(settled, '`ja_JP`'), ['ja_JP', 'zh_CN'])), null)
  assert.match(untick(settled, ['zh_CN']), /^- \[x\] `zh_CN` 演示, listed by @jacky$/m)
})

test('settling a review records who decided and closes it once nothing is left', () => {
  const body = renderReview(item)
  const partly = settleReview(tick(body, '`zh_CN`'), { approve: ['zh_CN'], decline: false }, 'jacky')
  assert.equal(partly.done, false)
  assert.match(partly.body, /^- \[x\] `zh_CN` 演示, listed by @jacky$/m)
  assert.match(partly.body, /^- \[ \] `ja_JP` デモ$/m)
  assert.match(partly.body, /Decline the names left unticked/)

  const declined = settleReview(tick(partly.body, 'Decline'), { approve: [], decline: true }, 'jacky')
  assert.equal(declined.done, true)
  assert.match(declined.body, /^- ~~`ja_JP` デモ~~ declined by @jacky$/m)
  assert.doesNotMatch(declined.body, /Decline the names/)
  assert.match(declined.body, /^### Names reviewed/)
  assert.equal(readReview(declined.body).state, 'done')

  const all = settleReview(tick(tick(body, '`zh_CN`'), '`ja_JP`'), { approve: ['ja_JP', 'zh_CN'], decline: false }, 'jacky')
  assert.equal(all.done, true)
  assert.doesNotMatch(all.body, /Decline/)

  // A name ticked while a run lists another keeps the review open for its run.
  const raced = settleReview(tick(tick(body, '`zh_CN`'), '`ja_JP`'), { approve: ['zh_CN'], decline: false }, 'jacky')
  assert.equal(raced.done, false)
  assert.deepEqual(pendingDecision(raced.body).approve, ['ja_JP'])
})

test('a review covers a build that asks about nothing new', () => {
  const review = readReview(renderReview(item))
  assert.equal(covers(review, { ...item, names: { zh_CN: '演示' } }), true)
  assert.equal(covers(review, { ...item, names: { zh_CN: '演示版' } }), false)
  assert.equal(covers(review, { ...item, blocked: {}, names: { ko_KR: '데모' } }), false)
  assert.equal(covers(undefined, item), false)
})

test('the submission issue comes from the commit that added the entry', () => {
  // git log lists the newest first: a plugin listed again uses its new issue.
  const log = 'feat(plugins): list io.github.alice.demo\n\nSubmitted by @alice in #57\0feat(plugins): list io.github.alice.demo\n\nSubmitted by @alice in #42\nApproved by @jacky\0'
  assert.equal(submissionIssue('io.github.alice.demo', () => log), 57)
  assert.equal(submissionIssue('io.github.alice.demo', () => 'feat: add demo\0'), 0)
  assert.equal(submissionIssue('io.github.alice.demo', () => { throw new Error('no git') }), 0)
})

test('approved names join the entry in order', () => {
  const text = `${JSON.stringify({ id: 'x.y', name: { en: 'Demo', zh_TW: '示範' }, author: 'alice' }, null, 2)}\n`
  const merged = JSON.parse(withNames(text, { ja_JP: 'デモ' }))
  assert.deepEqual(Object.entries(merged.name), [['en', 'Demo'], ['ja_JP', 'デモ'], ['zh_TW', '示範']])
  assert.deepEqual(Object.keys(merged), ['id', 'name', 'author'])
})

// An in-memory stand-in for the parts of Octokit the sync uses.
function fakeGithub(issues) {
  let nextComment = 1
  let nextIssue = 100
  const comments = new Map()
  const issue = number => issues.find(item => item.number === number)
  const github = {
    paginate: async (fn, params) => fn(params).then(response => response.data),
    rest: {
      issues: {
        get: async ({ issue_number }) => {
          if (!issue(issue_number))
            throw new Error('Not Found')
          return { data: issue(issue_number) }
        },
        listForRepo: async ({ labels, state }) => ({ data: issues.filter(item => item.labels.includes(labels) && (state === 'all' || item.state === state)) }),
        create: async ({ title, body, labels }) => {
          const made = { number: nextIssue++, title, body, labels, state: 'open', user: { login: 'github-actions[bot]' } }
          issues.push(made)
          return { data: made }
        },
        update: async ({ issue_number, state }) => { issue(issue_number).state = state },
        addLabels: async ({ issue_number, labels }) => { issue(issue_number).labels.push(...labels) },
        removeLabel: async ({ issue_number, name }) => {
          const target = issue(issue_number)
          target.labels = target.labels.filter(label => label !== name)
        },
        listComments: async ({ issue_number }) => ({ data: comments.get(issue_number) ?? [] }),
        createComment: async ({ issue_number, body }) => {
          comments.set(issue_number, [...(comments.get(issue_number) ?? []), { id: nextComment++, body, user: { type: 'Bot', login: 'github-actions[bot]' } }])
        },
        updateComment: async ({ comment_id, body }) => {
          for (const list of comments.values()) {
            const found = list.find(comment => comment.id === comment_id)
            if (found)
              found.body = body
          }
        },
      },
    },
  }
  return { github, comments }
}

test('the deploy asks once on the submission issue and closes it when nothing is left', async () => {
  const issues = [{ number: 42, state: 'closed', labels: ['submission', 'listed'], body: '' }]
  const { github, comments } = fakeGithub(issues)
  const repo = { owner: 'nginxui', repo: 'plugins' }
  const entries = new Map([[item.id, { id: item.id, name: { en: 'Demo' }, author: 'alice' }]])
  const git = () => 'feat(plugins): list io.github.alice.demo\n\nSubmitted by @alice in #42\0'
  const sync = pending => syncNameReviews({ github, repo, pending: { plugins: pending }, entries, git })

  await sync([item])
  assert.equal(comments.get(42).length, 1)
  assert.equal(issues[0].state, 'open')
  assert.ok(issues[0].labels.includes('pending-review'))

  // The same names ask nothing again, nor do the ones left after an approval.
  await sync([item])
  await sync([{ ...item, names: { ja_JP: 'デモ' } }])
  assert.equal(comments.get(42).length, 1)

  // A new name supersedes the open review with a new one.
  await sync([{ ...item, names: { ja_JP: 'デモ', ko_KR: '데모' } }])
  assert.equal(comments.get(42).length, 2)
  assert.match(comments.get(42)[0].body, /^### Superseded/)
  assert.equal(readReview(comments.get(42)[0].body).state, 'done')
  // Nothing is left to tick on a superseded review.
  assert.doesNotMatch(comments.get(42)[0].body, /- \[ \]|Decline/)

  // Nothing pending: the open review is done and the issue closes.
  await sync([])
  assert.equal(readReview(comments.get(42)[1].body).state, 'done')
  assert.equal(issues[0].state, 'closed')
  assert.ok(!issues[0].labels.includes('pending-review'))
})

test('an entry without a submission issue gets one of its own, once', async () => {
  const issues = []
  const { github } = fakeGithub(issues)
  const repo = { owner: 'nginxui', repo: 'plugins' }
  const entries = new Map([[item.id, { id: item.id, name: { en: 'Demo' }, author: 'alice' }]])
  const sync = pending => syncNameReviews({ github, repo, pending: { plugins: pending }, entries, git: () => '' })
  await sync([item])
  await sync([{ ...item, names: { ko_KR: '데모' }, blocked: {} }])
  assert.equal(issues.length, 1)
  assert.ok(issues[0].body.includes(issueMarker(item.id)))
  assert.match(issues[0].body, /@alice/)
  assert.ok(issues[0].labels.includes('listed'))
})

test('a listed issue holding the marker in its own text is not taken for the plugin', async () => {
  const issues = [{ number: 7, state: 'closed', labels: ['submission', 'listed'], title: 'Submit a plugin', body: issueMarker(item.id), user: { login: 'mallory' } }]
  const { github } = fakeGithub(issues)
  await syncNameReviews({ github, repo: { owner: 'nginxui', repo: 'plugins' }, pending: { plugins: [item] }, entries: new Map(), git: () => '' })
  assert.equal(issues.length, 2)
  assert.equal(issues[1].title, `Listing of ${item.id}`)
})

test('a plugin whose issue cannot be read does not stop the others', async () => {
  const issues = []
  const { github, comments } = fakeGithub(issues)
  const other = { ...item, id: 'io.github.bob.other' }
  const git = args => args.at(-1).includes('alice') ? 'feat(plugins): list x\n\nSubmitted by @alice in #404\0' : ''
  const done = await syncNameReviews({ github, repo: { owner: 'nginxui', repo: 'plugins' }, pending: { plugins: [item, other] }, entries: new Map(), git })
  assert.match(done[0], /could not ask, Not Found/)
  assert.equal(comments.get(100).length, 1)
})
