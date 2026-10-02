## What is this

<!-- New plugin submission, a change to an existing entry, a yank, a partner
     key change, or a catalog infrastructure change? -->

## Checklist

- [ ] I ran `node scripts/validate.mjs` locally and it passes.
- [ ] JSON files are pretty-printed with 2-space indentation and end with a
      trailing newline (matches `.editorconfig`).

### If this adds or updates a `plugins/<id>.json`

- [ ] `repository_url` is the GitHub repository whose Releases publish the
      plugin, and its newest release carries the packages with a `.sha256`
      file next to each.
- [ ] Every package carries `plugin.sums` and `plugin.sums.minisig` at its
      root (see `docs/signing.md`), and a `community` entry has the
      `author_public_key` that signed them.

### If this yanks a release

- [ ] Only the version was added to `"yanked"`, the GitHub Release itself
      stays.
- [ ] The reason is described below (link a security advisory instead of
      exploit details for anything actively exploitable).

## Additional context

<!-- Anything reviewers should know: linked issue, release notes, etc. -->
