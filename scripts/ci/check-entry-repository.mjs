#!/usr/bin/env node
// Cross-checks one plugins/<id>.json against the GitHub repository it
// declares: does a release exist, and does its tag match the version this
// catalog entry says is newest. Network-dependent, so it is only run from
// .github/workflows/validate.yml, never from scripts/validate.mjs.
//
// Usage: node scripts/ci/check-entry-repository.mjs <plugins/id.json>
// Env:   GITHUB_TOKEN  raises the GitHub API rate limit, optional.

import { readFileSync } from 'node:fs'
import { parseGithubRepoUrl, getLatestRelease } from './github.mjs'

function newestVersion(entry) {
  return [...(entry.releases ?? [])].map(r => r.version).sort().at(-1)
}

async function main() {
  const entryPath = process.argv[2]
  if (!entryPath) {
    console.error('usage: node scripts/ci/check-entry-repository.mjs <plugins/id.json>')
    process.exit(2)
  }

  const entry = JSON.parse(readFileSync(entryPath, 'utf8'))
  const token = process.env.GITHUB_TOKEN

  const repo = parseGithubRepoUrl(entry.repository_url)
  if (!repo) {
    console.log(`SKIP ${entry.id}: repository_url is not a github.com repository, cannot cross-check automatically`)
    return
  }

  const release = await getLatestRelease(repo.owner, repo.repo, token)
  if (!release) {
    console.log(`SKIP ${entry.id}: ${repo.owner}/${repo.repo} has no GitHub Release yet`)
    return
  }

  const tagVersion = release.tag_name.replace(/^v/, '')
  const catalogVersion = newestVersion(entry)

  if (tagVersion !== catalogVersion) {
    console.error(`FAIL ${entry.id}: catalog's newest release is ${catalogVersion}, but ${repo.owner}/${repo.repo}'s latest GitHub Release is ${release.tag_name} (${tagVersion})`)
    console.error('      run the poll-releases workflow, or update plugins/<id>.json by hand, before merging')
    process.exit(1)
  }

  console.log(`OK ${entry.id}: catalog matches ${repo.owner}/${repo.repo}'s latest release ${release.tag_name}`)
}

main().catch((err) => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
