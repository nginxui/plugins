// Asks the maintainers to review the names a listing does not show yet, and
// tells the authors what was left out (names.mjs), on the issue of the plugin:
//
// - The issue of a plugin is the submission issue it was listed from, found
//   through the newest commit that added its entry. An entry without one gets
//   an issue of its own, labelled "listed" like a listed submission, which
//   submit-issue.yml then leaves alone.
// - The deploy (syncNameReviews) posts one comment per new set of names with a
//   checkbox per name, English included, reopens the issue and labels it
//   "pending-review", which notifies its author and whoever watches this
//   repository. Names and descriptions left out are told the same way, with
//   nothing to tick. The comment carries the names it asks about, so a
//   maintainer approves exactly what the comment shows. Only people with write
//   access can tick a box in a comment of someone else.
// - review-names.yml handles a tick (pendingDecision, then settleReview): a
//   ticked name goes into plugins/<id>.json, "Decline" keeps the names left
//   unticked off the listing until the plugin names them differently. Once
//   nothing is left to decide, the issue closes again.
//
// The comments are English, like every other bot comment of this repository.

import { execFileSync } from 'node:child_process'
import { escapeText } from '../submission/preview.mjs'

export const LISTED_LABEL = 'listed'
export const PENDING_LABEL = 'pending-review'
const DECLINE = '<!-- decline -->'
// The marker ends a review comment. Anchoring it keeps a marker quoted in some
// other bot comment, such as a submission status, from counting.
const MARKER = /<!-- names:(open|done) ([A-Za-z0-9_-]+) -->\s*$/
const NAME_LINE = /^- \[([ xX])\] `([a-z]{2,3}(?:_[A-Z]{2})?)` /
// An approved line names its approver. A name cannot end like this, since
// escapeText breaks every @ it holds.
const SETTLED = /, listed by @[A-Za-z0-9-]+$/
const BOT = 'github-actions[bot]'

function encode(item) {
  return Buffer.from(JSON.stringify({ id: item.id, version: item.version, names: item.names, blocked: item.blocked, descriptions: item.descriptions ?? {} })).toString('base64url')
}

/** The marker comment that keeps what a review comment asks about. */
function marker(state, item) {
  return `<!-- names:${state} ${encode(item)} -->`
}

/** The issue body marker of an issue made for a plugin. */
export function issueMarker(id) {
  return `<!-- listing id=${id} -->`
}

/** What a review comment asks about: { state, id, version, names, blocked,
 * descriptions }, null for any other comment. */
export function readReview(body) {
  const match = (body ?? '').match(MARKER)
  if (!match || !body.startsWith('### '))
    return null
  try {
    const item = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'))
    return { state: match[1], id: item.id, version: item.version, names: item.names ?? {}, blocked: item.blocked ?? {}, descriptions: item.descriptions ?? {} }
  }
  catch {
    return null
  }
}

/** The review comment of item. listed holds the names the listing shows now. */
export function renderReview(item, { listed = {} } = {}) {
  const names = Object.keys(item.names).sort()
  const blocked = Object.keys(item.blocked).sort()
  const descriptions = Object.keys(item.descriptions ?? {}).sort()
  const lines = [names.length > 0 ? '### Names waiting for review' : '### Left off the listing', '']
  if (names.length > 0) {
    lines.push(
      `The plugin.json of \`${item.id}\` ${escapeText(item.version)} names the plugin in languages its listing does not show yet. A maintainer lists a name by ticking it, or declines the names left unticked.`,
      '',
      ...names.map(locale => `- [ ] \`${locale}\` ${escapeText(item.names[locale])}${item.names[locale] && listed[locale] ? ` (listed now: ${escapeText(listed[locale])})` : ''}`),
      '',
      `- [ ] Decline the names left unticked ${DECLINE}`,
    )
  }
  if (blocked.length > 0) {
    lines.push(
      ...(names.length > 0 ? [''] : []),
      `These names of \`${item.id}\` ${escapeText(item.version)} hold what no name may and stay off the listing. Only the plugins of the Nginx UI project are official.`,
      '',
      ...blocked.map(locale => `- \`${locale}\` ${escapeText(item.blocked[locale].name)} ("${escapeText(item.blocked[locale].word)}")`),
    )
  }
  if (descriptions.length > 0) {
    const short = text => text.length > 200 ? `${text.slice(0, 200)}…` : text
    lines.push(
      ...(lines.length > 2 ? [''] : []),
      `These descriptions of \`${item.id}\` ${escapeText(item.version)} stay off the listing, which keeps the description it had. Only the plugins of the Nginx UI project are official.`,
      '',
      ...descriptions.map(locale => `- \`${locale}\` ${escapeText(short(item.descriptions[locale].text))} (${escapeText(item.descriptions[locale].word)})`),
    )
  }
  lines.push('', marker(names.length > 0 ? 'open' : 'done', item))
  return lines.join('\n')
}

/**
 * What a review comment asks to do now: { review, approve, decline }, approve
 * the locales ticked but not yet listed, decline true when "Decline" is
 * ticked. Read from the comment as it is, so ticks whose runs were cancelled
 * or raced are not lost. Null when there is nothing to do.
 */
export function pendingDecision(body) {
  const review = readReview(body)
  if (review?.state !== 'open')
    return null
  const approve = []
  let decline = false
  for (const line of body.split('\n')) {
    const name = line.match(NAME_LINE)
    if (name && name[1] !== ' ' && !SETTLED.test(line) && review.names[name[2]])
      approve.push(name[2])
    if (line.includes(DECLINE) && /^- \[[xX]\]/.test(line))
      decline = true
  }
  return approve.length > 0 || decline ? { review, approve: approve.sort(), decline } : null
}

/** The comment with the boxes of some names cleared again, so ticking them
 * retries. */
export function untick(body, locales) {
  return body.split('\n').map((line) => {
    const name = line.match(NAME_LINE)
    return name && locales.includes(name[2]) && !SETTLED.test(line) ? line.replace(/^- \[[xX]\]/, '- [ ]') : line
  }).join('\n')
}

/** The comment after a decision: approved lines name their approver, declined
 * lines lose their box, and the comment is done once nothing is left. */
export function settleReview(body, { approve, decline }, login) {
  const review = readReview(body)
  const approved = new Set(approve)
  let open = false
  const lines = body.split('\n').map((line) => {
    const name = line.match(NAME_LINE)
    if (name && approved.has(name[2]))
      return `- [x] \`${name[2]}\` ${escapeText(review.names[name[2]])}, listed by @${login}`
    // A name ticked meanwhile waits for the run its tick queued.
    if (name && !SETTLED.test(line)) {
      if (name[1] === ' ' && decline)
        return `- ~~\`${name[2]}\` ${escapeText(review.names[name[2]])}~~ declined by @${login}`
      open = true
    }
    if (line.includes(DECLINE))
      return decline || !open ? null : line
    return line
  })
  // The decline box sits after the names, so open is known when it comes.
  const kept = lines.filter(line => line !== null)
  if (!open)
    return { body: kept.join('\n').replace(MARKER, marker('done', review)).replace(/^### Names waiting for review/, '### Names reviewed'), done: true }
  return { body: kept.join('\n'), done: false }
}

/** A review comment that asks no more: its unticked boxes become plain
 * lines, the decline box goes and the marker says done. */
function retire(body, heading, note) {
  const review = readReview(body)
  const lines = body.split('\n').filter(line => !line.includes(DECLINE)).map(line => line.replace(/^- \[ \] /, '- '))
  lines.splice(0, 1, heading, '', note)
  return lines.join('\n').replace(MARKER, marker('done', review))
}

/** Whether review already asks about, or decided, every name of item. */
export function covers(review, item) {
  const same = (a = {}, b = {}) => Object.entries(b).every(([locale, value]) => JSON.stringify(a[locale]) === JSON.stringify(value))
  return Boolean(review) && same(review.names, item.names) && same(review.blocked, item.blocked) && same(review.descriptions, item.descriptions)
}

/** The submission issue an entry was listed from, read from the newest
 * commit that added it, 0 without one. */
export function submissionIssue(id, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  try {
    const log = git(['log', '--diff-filter=A', '--format=%B%x00', '--', `plugins/${id}.json`])
    const added = log.split('\0').map(message => message.trim()).find(Boolean) ?? ''
    return Number(added.match(/^Submitted by @\S+ in #(\d+)$/m)?.[1] ?? 0)
  }
  catch {
    return 0
  }
}

/** The issue of a plugin: its submission issue, else the one made for it,
 * else a new one. */
async function pluginIssue(github, repo, entry, git) {
  const submitted = submissionIssue(entry.id, git)
  if (submitted)
    return (await github.rest.issues.get({ ...repo, issue_number: submitted })).data
  const listed = await github.paginate(github.rest.issues.listForRepo, { ...repo, labels: LISTED_LABEL, state: 'all', per_page: 100 })
  // Not just any listed issue holding the marker: a submission body is its
  // author's text.
  const made = listed.find(issue => issue.user?.login === BOT && issue.title === `Listing of ${entry.id}` && issue.body?.includes(issueMarker(entry.id)))
  if (made)
    return made
  const author = /^[A-Za-z0-9-]+$/.test(entry.author ?? '') ? ` @${entry.author}` : ''
  const { data } = await github.rest.issues.create({
    ...repo,
    title: `Listing of ${entry.id}`,
    body: `This issue follows the catalog listing of \`${entry.id}\`, such as names that wait for review.${author}\n\n${issueMarker(entry.id)}`,
    labels: [LISTED_LABEL],
  })
  return data
}

/** The newest review comment of a plugin on an issue. */
async function latestReview(github, repo, issue, id) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issue.number, per_page: 100 })
  return comments
    .filter(comment => comment.user?.login === BOT && readReview(comment.body)?.id === id)
    .map(comment => ({ comment, review: readReview(comment.body) }))
    .at(-1)
}

async function openForReview(github, repo, issue) {
  if (issue.state !== 'open')
    await github.rest.issues.update({ ...repo, issue_number: issue.number, state: 'open' })
  if (!issue.labels?.some(label => (label.name ?? label) === PENDING_LABEL))
    await github.rest.issues.addLabels({ ...repo, issue_number: issue.number, labels: [PENDING_LABEL] })
}

/** Takes the pending label off an issue and closes it. */
export async function closeReview(github, repo, number) {
  await github.rest.issues.removeLabel({ ...repo, issue_number: number, name: PENDING_LABEL }).catch(() => {})
  await github.rest.issues.update({ ...repo, issue_number: number, state: 'closed', state_reason: 'completed' })
}

/** Asks about the pending names of one plugin, unless its newest review
 * already does. Returns what it did. */
async function askAbout(github, repo, item, entry, git) {
  const issue = await pluginIssue(github, repo, entry, git)
  const latest = await latestReview(github, repo, issue, item.id)
  const open = Object.keys(item.names).length > 0
  if (covers(latest?.review, item)) {
    if (latest.review.state === 'open')
      await openForReview(github, repo, issue)
    return []
  }
  if (latest?.review.state === 'open')
    await github.rest.issues.updateComment({ ...repo, comment_id: latest.comment.id, body: retire(latest.comment.body, '### Superseded', 'The plugin names itself differently now, see the newer list below.') })
  await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body: renderReview(item, { listed: entry.name }) })
  if (open)
    await openForReview(github, repo, issue)
  return [`${item.id}: told about ${[...Object.keys({ ...item.names, ...item.blocked }), ...Object.keys(item.descriptions ?? {}).map(locale => `the ${locale} description`)].join(', ')} on #${issue.number}`]
}

/**
 * Brings the review comments in line with a build. pending is the
 * --pending output of build-catalog.mjs, entries maps an id to its listed
 * entry (for the names shown now and its author). A plugin that fails does
 * not stop the others. Returns what it did, one line per action.
 */
export async function syncNameReviews({ github, repo, pending, entries, git }) {
  const done = []
  const asked = new Set()
  for (const item of pending.plugins) {
    asked.add(item.id)
    try {
      done.push(...await askAbout(github, repo, item, entries.get(item.id) ?? { id: item.id }, git))
    }
    catch (err) {
      done.push(`${item.id}: could not ask, ${err.message}`)
    }
  }

  // A review the build no longer needs: its names are listed or no longer named.
  const waiting = await github.paginate(github.rest.issues.listForRepo, { ...repo, labels: PENDING_LABEL, state: 'all', per_page: 100 })
  for (const issue of waiting) {
    const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issue.number, per_page: 100 })
    const open = comments.filter(comment => comment.user?.login === BOT && readReview(comment.body)?.state === 'open')
    for (const comment of open.filter(comment => !asked.has(readReview(comment.body).id)))
      await github.rest.issues.updateComment({ ...repo, comment_id: comment.id, body: retire(comment.body, '### Names no longer waiting', 'The listing shows these names now, or the plugin no longer gives them.') })
    if (!open.some(comment => asked.has(readReview(comment.body).id))) {
      await closeReview(github, repo, issue.number)
      done.push(`#${issue.number}: nothing left to review, closed`)
    }
  }
  return done
}

/** plugins/<id>.json with the approved names added, English first and the
 * other languages in order. */
export function withNames(entryText, names) {
  const entry = JSON.parse(entryText)
  const merged = { ...entry.name, ...names }
  const locales = Object.keys(merged).filter(locale => locale !== 'en').sort()
  entry.name = Object.fromEntries([['en', merged.en], ...locales.map(locale => [locale, merged[locale]])])
  return `${JSON.stringify(entry, null, 2)}\n`
}
