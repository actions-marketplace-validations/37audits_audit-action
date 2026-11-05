# 37 Audits GitHub Action

Audit a website from a GitHub Actions workflow with
[37 Audits](https://www.37audits.com) and fail the job when security,
performance, SEO or accessibility checks regress.

```yaml
name: Audit
on:
  deployment_status:
jobs:
  audit:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: 37audits/audit-action@v1
        with:
          api-key: ${{ secrets.THIRTYSEVENAUDITS_API_KEY }}
          url: https://www.example.com
```

The results appear in the job summary and stay on 37audits.com, next to the
URL's history. Each run is noted with the repository and commit.

## Setup

1. Add the URL to a project on [37audits.com](https://www.37audits.com) and
   choose its auditors. The action audits a monitored URL, so it must exist
   first.
2. Create an API key under *Organization → API keys*.
3. Store the key as the repository secret `THIRTYSEVENAUDITS_API_KEY`.

Every run spends credits from your organization, as a run from the website
does. Limit it with `auditors`, or with a `branches` or `paths` filter on the
workflow.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | 37 Audits API key |
| `url` | one of these | | Address of the monitored URL |
| `url-id` | one of these | | Id of the monitored URL |
| `auditors` | no | every enabled auditor | Auditor ids, separated by commas or new lines |
| `fail-on` | no | `fail` | `fail` (fail and error), `warning` (also warnings) or `never` |
| `timeout` | no | `5m` | How long to wait for the auditors |
| `note` | no | `<repository>@<sha>` | Note stored with the run |

With a `fail-on` gate, auditors still running at the timeout fail the step.
With `never` they produce a warning, and the results still land on
37audits.com.

## Outputs

| Output | Description |
| --- | --- |
| `group_id` | Id of the audit run |
| `success_count` | Auditors that passed |
| `warning_count` | Auditors that reported a warning |
| `fail_count` | Auditors that reported a fail or an error |
| `results` | Every auditor result, as JSON |

## More

The action wraps the [37 Audits CLI](https://github.com/37audits/37audits-cli).
`dist/cli.cjs` is the bundle of the published npm package, currently
`37audits-cli@1.0.2`. Use the CLI directly to wrap a deploy in a maintenance
window.

## License

MIT
