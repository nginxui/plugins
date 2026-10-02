# Release webhook

A Cloudflare Worker that starts the deploy of the catalog as soon as a listed
plugin publishes a GitHub Release. Without it the hourly deploy picks the
release up within the hour, as it does for an edited or deleted release.

```
plugin repository --release event--> catalog GitHub App --webhook--> this Worker
this Worker --workflow_dispatch of deploy.yml--> nginxui/plugins
```

The Worker checks the webhook signature, ignores drafts and repositories the
published catalog does not list, and runs `.github/workflows/deploy.yml`. The
deploy reads every release from GitHub itself and verifies the packages, so a
delivery only decides when the deploy runs.

A repository starts the deploy at most once a minute, and no delivery starts
one while a deploy is waiting to run: that deploy reads the newest releases
when it starts.

## For plugin authors

Install the [NGINX UI Plugin Catalog](https://github.com/apps/nginx-ui-plugin-catalog)
GitHub App on the repository of your plugin to have a new release listed
within minutes instead of within the hour. It only receives release events
and holds no private key, so it cannot read your repository. The catalog
ignores the events of repositories it does not list.

## Local test

```sh
node --test src/*.test.mjs
```
