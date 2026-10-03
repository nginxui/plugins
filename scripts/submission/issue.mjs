#!/usr/bin/env node
// The issue form front end of a submission: reads the "Submit a plugin" issue
// of an issues event, drafts its entry with scripts/submission/core.mjs and
// writes the outcome to $GITHUB_OUTPUT for .github/workflows/submit-issue.yml.
//
// Usage: node scripts/submission/issue.mjs <path-to-issue-event.json>
//
// Outputs: result (ok or rejected), message, id, path, drafts (a JSON object
// of the entry file and its content), entry, eligible, eligibility and
// body_sha256, the digest of the issue body the draft was made from.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { checkEligibility, draftEntry } from './core.mjs'

// Labels of the form fields, see .github/ISSUE_TEMPLATE/submit-plugin.yml.
const FIELD_REPOSITORY = 'Repository URL'
const FIELD_KEY = 'Primary public key'
const FIELD_CATEGORIES = 'Categories'

/** Issue forms render as "### Label\n\nvalue" sections; an empty optional
 * field reads "_No response_". */
export function parseFormFields(body) {
  const fields = {}
  for (const section of body.split(/^### /m).slice(1)) {
    const newline = section.indexOf('\n')
    const label = section.slice(0, newline === -1 ? undefined : newline).trim()
    const value = newline === -1 ? '' : section.slice(newline + 1).trim()
    fields[label] = value === '_No response_' ? '' : value
  }
  return fields
}

/** The submission an issue body describes. */
export function submissionFromIssue(issue) {
  const fields = parseFormFields(issue.body ?? '')
  const key = (fields[FIELD_KEY] ?? '').replace(/^```\w*\n?|\n?```$/g, '').trim()
  const categories = (fields[FIELD_CATEGORIES] ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return {
    repository_url: (fields[FIELD_REPOSITORY] ?? '').trim(),
    author_public_key: key,
    categories,
    submitter: { login: issue.user.login, id: issue.user.id },
  }
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file)
    return
  const delimiter = `EOF_${randomBytes(8).toString('hex')}`
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

async function main() {
  const eventPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.error('usage: node scripts/submission/issue.mjs <path-to-issue-event.json>')
    process.exit(2)
  }
  const { issue } = JSON.parse(readFileSync(eventPath, 'utf8'))
  const token = process.env.GITHUB_TOKEN
  setOutput('body_sha256', createHash('sha256').update(issue.body ?? '').digest('hex'))

  const submission = submissionFromIssue(issue)
  const draft = await draftEntry(submission, { token })
  if (draft.rejection) {
    console.log(`rejected: ${draft.rejection}`)
    setOutput('result', 'rejected')
    setOutput('message', draft.rejection)
    return
  }

  const { entry, repository, tag } = draft
  const eligibility = await checkEligibility(repository, submission.submitter, { token })
  const file = `plugins/${entry.id}.json`
  const content = `${JSON.stringify(entry, null, 2)}\n`
  console.log(`drafted ${file} from ${repository.full_name}@${tag}, ${eligibility.eligible ? 'eligible' : 'not eligible'}: ${eligibility.reason}`)
  setOutput('result', 'ok')
  setOutput('message', `Drafted \`${file}\` from ${repository.full_name}@${tag}.`)
  setOutput('id', entry.id)
  setOutput('path', file)
  setOutput('entry', content)
  setOutput('drafts', JSON.stringify({ [file]: content }))
  setOutput('eligible', String(eligibility.eligible))
  setOutput('eligibility', eligibility.reason)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message || err)
    process.exit(1)
  })
}
