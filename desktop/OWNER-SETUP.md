# Owner setup: GitHub settings for Vaani for Mac

Plain steps for the repository owner. Do them once, in this order.

**Do not add any Apple signing secrets until steps 1 to 4 are done.** The
workflow already says `environment: release`, but GitHub creates that
environment automatically with **no protection at all** the first time it is
used. Until you set it up below, the protection exists only on paper.

You need: owner access to the `vaani` repository on GitHub. No Apple account
is needed for steps 1 to 4.

## 1. Create the protected "release" environment

1. Open the repository on GitHub, then **Settings**.
2. In the left menu, click **Environments**, then **New environment**.
3. Name it exactly `release` and click **Configure environment**.
4. Tick **Required reviewers**, add yourself, and click **Save protection rules**.
   Now every signing run waits until you approve it.
5. Under **Deployment branches and tags**, choose **Selected branches and tags**, then:
   - **Add deployment branch or tag rule**, type `main`, choose **Branch**, **Add rule**.
   - **Add deployment branch or tag rule** again, type `desktop-v*`, choose **Tag**, **Add rule**.
6. Leave **Allow administrators to bypass** unticked if GitHub shows it.

## 2. Protect the release tags

Only you should be able to create tags that start a signed build.

1. **Settings**, then **Rules**, then **Rulesets**, then **New ruleset**, then **New tag ruleset**.
2. Name: `desktop release tags`. Enforcement status: **Active**.
3. **Target tags**: **Add target**, **Include by pattern**, type `desktop-v*`.
4. **Bypass list**: add yourself (Repository admin role) only.
5. Tick **Restrict creations**, **Restrict updates** and **Restrict deletions**.
6. Click **Create**.

## 3. Protect the main branch

1. **Settings**, **Rules**, **Rulesets**, **New ruleset**, **New branch ruleset**.
2. Name: `main`. Enforcement: **Active**. Target: **Include default branch**.
3. Tick **Restrict deletions**, **Block force pushes** and **Require a pull request before merging**.
4. Click **Create**.

## 4. Require approval for outside contributors' workflow runs

1. **Settings**, then **Actions**, then **General**.
2. Under **Approval for running fork pull request workflows from contributors**,
   choose **Require approval for all external contributors**.
3. Under **Workflow permissions**, choose **Read repository contents and packages permissions**.
4. Click **Save**.

## 5. Only now: add the signing secrets (later, with an Apple Developer account)

1. **Settings**, **Environments**, click `release`.
2. Under **Environment secrets**, click **Add environment secret** for each of these six:
   `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`,
   `NOTARY_API_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID`.
3. Make sure none of them exists under **Settings**, **Secrets and variables**,
   **Actions**, **Repository secrets**. If any does, delete it there: repository
   secrets can be read by workflows on any branch.

## 6. Which build to install

- Install only builds from a **push to `main`** (Actions, Desktop macOS, filter
  Branch `main` and Event `push`) or, later, a **GitHub Release**. Check the
  `.sha256` file matches.
- Never install a build from a pull request (they upload nothing anyway).
- The **NO-SANDBOX diagnostic** build is made only when someone runs the
  workflow by hand with "diagnostic" ticked. It is called **Vaani DIAGNOSTIC**,
  shows "Diagnostic build, sandbox off, not for daily use." in its menu and
  window title, stores nothing, and cannot be signed. Use it only when asked,
  for one test, then delete it.

## Checklist

- [ ] 1. `release` environment with you as required reviewer, branches `main` and tags `desktop-v*` only
- [ ] 2. Tag ruleset for `desktop-v*` (only you can create, update, delete)
- [ ] 3. Branch ruleset for `main`
- [ ] 4. Approval required for all outside contributors; workflow permissions read-only
- [ ] 5. Signing secrets only as `release` environment secrets, none at repository level
