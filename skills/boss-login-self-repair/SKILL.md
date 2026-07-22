---
name: boss-login-self-repair
description: Diagnose and repair boss-cli login failures after synchronizing the canonical upstream source, distinguish Git source, npm publication, and the installed CLI, and deliver verified changes through a dedicated repair branch. Use when `boss login` fails, Boss frontend availability checks reject new assets, local source or the installed CLI is behind the official release, or an interrupted Boss login repair must be safely resumed and finished with a clean `main` worktree.
---

# Boss Login Self-Repair

Repair the real login failure, not an assumed cause. Synchronize official source before diagnosis, make every change on a dedicated repair branch, update the Boss frontend baseline only when it remains the verified root cause, merge the validated result into `main`, update the installed CLI, delete the completed repair branch, and finish on a clean `main` worktree.

Do not ask for confirmation during this workflow. Do not bypass safety checks, add fallback logic, rewrite history, or discard unrelated user work.

## Source and Delivery Model

Keep these roles separate:

- `upstream`: canonical source repository `https://github.com/joohw/boss-cli.git`.
- `origin`: writable delivery repository, which may be a fork.
- npm `@joohw/boss-cli`: publication metadata and released package, never mergeable source.
- local `boss` executable: installed runtime that must be updated only after repository delivery succeeds.

Require both `origin/HEAD` and `upstream/HEAD` to resolve to `main`. Stop if either default branch is different or cannot be determined.

## Clean Worktree Invariant

The primary worktree must be on `main` and clean at every successful or failed terminal exit. Create or resume exactly one repair branch; never begin a second repair while another repair worktree is unresolved.

Start with:

```bash
git branch --show-current
git status --porcelain=v1
git worktree list
```

Classify the state before fetching, switching, or editing:

1. `main` and clean: begin a normal run.
2. A clean `codex/boss-login-repair-*` or legacy `codex/boss-login-baseline-*` branch: inspect and resume it.
3. One of those repair branches with changes only in the expected repair paths below: review the complete diff, adopt those paths as workflow-owned, and resume the same branch.
4. Any other dirty state, detached HEAD, unrelated branch, unrelated changed path, or concurrent repair worktree: stop without modifying anything and report the exact blocker.

Expected repair paths are:

- `src/common/boss_availability.ts`
- `src/common/boss_page_guards.ts`
- files directly required to fix the reproduced login root cause
- `docs/anti-detection.md`
- one dated `docs/research/boss-online-js/<date>/` directory

Do not stash, run `git reset --hard`, use broad `git clean`, or carry changes between branches. Record the starting commit, repair branch, initial status, and every path created or changed by the workflow. Cleanup may touch only those recorded workflow-owned paths.

## Phase 1: Discover Remotes and Versions

Inspect repository identity and configure the canonical source explicitly:

```bash
git remote -v
node -p "require('./package.json').repository.url"
```

- Require `origin` to be a `boss-cli` repository suitable for delivery.
- Require the package repository to identify `joohw/boss-cli`.
- If `upstream` is missing, add exactly `https://github.com/joohw/boss-cli.git`.
- If an existing `upstream` has another URL, stop; do not rewrite it silently.

Then fetch and verify both remotes:

```bash
git fetch origin --prune --tags
git fetch upstream --prune --tags
git symbolic-ref --short refs/remotes/origin/HEAD
git symbolic-ref --short refs/remotes/upstream/HEAD
```

For a normal run, synchronize only the writable default branch before creating repair work:

```bash
git switch main
git pull --ff-only origin main
git status --porcelain=v1
git switch -c "codex/boss-login-repair-$(date +%Y%m%d-%H%M%S)"
```

For a resumed repair branch, do not create another branch. Review its scope first:

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git status --short
```

If `origin/main` is not an ancestor of the repair branch, merge it with `--no-commit`, validate the merge, and commit it as `同步默认分支更新`. Abort and cleanly exit on conflicts.

Build a version matrix after both fetches:

```bash
pkg_name="$(node -p "require('./package.json').name")"
npm_version="$(npm view "$pkg_name" version --registry=https://registry.npmjs.org/)"
npm_git_head="$(npm view "$pkg_name@$npm_version" gitHead --registry=https://registry.npmjs.org/)"
node -p "require('./package.json').version"
git show origin/main:package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"
git show upstream/main:package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"
boss --version
```

Verify that npm's `gitHead` exists in fetched upstream history and is an ancestor of `upstream/main`. If not, stop and report a publication/source mismatch. Never download an npm tarball into the repository or edit `package.json` merely to match npm metadata.

## Phase 2: Synchronize Official Source First

Before diagnosing login, integrate `upstream/main` into the repair branch. Never merge upstream directly into local `main` before repair validation.

```bash
git merge-base --is-ancestor upstream/main HEAD
git merge --no-ff --no-commit upstream/main
npm ci
npm run build
```

- Exit code `0` from the ancestry check means no upstream merge is needed.
- Exit code `1` means perform the merge shown above.
- Treat other exit codes as errors.
- If the merge conflicts, run `git merge --abort`, execute Clean Exit, and expose the conflicting paths.
- If dependency installation or build fails, abort the pending merge, execute Clean Exit, and expose the root error.
- When the synchronized source builds, commit the pending merge as `同步官方仓库更新`.

This phase may already contain the login fix. Do not update the frontend baseline until the synchronized source is tested.

## Phase 3: Reproduce and Classify Login

Use the synchronized local build, not the stale globally installed CLI:

```bash
npm run build
rg -n "assertBossCliAvailable|boss_availability|Boss CLI 已禁用" src
node dist/cli/index.js login
```

Classify the observed failure:

1. Login now succeeds: deliver the upstream synchronization; do not modify the baseline.
2. Exact Boss frontend baseline mismatch: continue to Baseline Repair.
3. Chrome/CDP/session/navigation/selector failure: trace and fix that root cause with the smallest necessary change.
4. Authentication or user interaction is required and cannot be validated automatically: stop after preserving the exact observable state; do not claim success.
5. Unrelated build or environment failure: expose it and do not change the Boss baseline.

Do not use `assertBossCliAvailable()` as a proxy for login unless the synchronized login path still calls it or the reproduced error is the availability rejection. If the official source removed that runtime call, do not reintroduce it.

Before changing navigation, command entry points, current-page checks, or help text, read and update `docs/boss-url-map.md`. Keep Puppeteer `page.evaluate` and `page.waitForFunction` code as string scripts, never callback functions.

If login succeeds and the repair branch has no diff relative to `origin/main`, delete the empty repair branch and execute Clean Exit without creating a merge commit.

## Baseline Repair

Run this section only after the synchronized login still fails with the exact Boss frontend baseline mismatch.

1. Locate the current guard state:

```bash
rg -n "boss_availability|VERIFIED_BOSS|VERIFIED_ZHIPIN|Boss CLI 已禁用|zhipin-boss/index|zhipin-sign" src docs skills
```

2. Capture the current frontend from the repair branch:

```bash
node skills/boss-frontend-analysis/scripts/capture_boss_frontend.mjs
```

If today's directory already exists in a resumed repair, inspect `analysis.md`, `manifest.json`, and file completeness. Use `--force` only when refreshing that same workflow-owned capture intentionally.

3. Review the generated analysis and manifest. Extract Boss index, Boss bundle, and Zhipin sign versions, entry URLs, and SHA-256 hashes for all guarded assets.

4. Compare against the previous verified baseline after normalizing `zhipin-boss/index/v*`, `zhipin-boss/bundle/v*`, `zhipin-sign/v*`, and chunk fingerprints. Explicitly review:

- `risk-detection.js`
- sign `vendors~app` and `iframe-core`
- `99001`, `99002`, `99004`, `99005`
- `srcdoc`, `MutationObserver`, `isTrusted`, `sendAction`, `Function(`, `constructor`
- `setInterval`, `console`, `devtools`, `security`, `403.html`

5. Confirm that `src/common/boss_page_guards.ts` covers every observed risk/security script and risky navigation/report URL. Change guards only for a concrete uncovered URL.

6. Only after accepting the review, update:

- `VERIFIED_CAPTURE_LABEL`
- `VERIFIED_BOSS_INDEX_VERSION`
- `VERIFIED_BOSS_BUNDLE_VERSION`
- `VERIFIED_ZHIPIN_SIGN_VERSION`
- `REQUIRED_ENTRY_SCRIPT_URLS`
- `REQUIRED_LOGIN_SCRIPT_URLS`
- guarded URL/hash pairs in `GUARDED_SCRIPT_HASHES`
- the dated review at the top of `docs/anti-detection.md`

If online scripts cannot be accepted, leave login disabled, execute Clean Exit, and report the exact risk difference. Do not add bypasses, fallback behavior, or environment switches.

## Phase 4: Validate the Repair Branch

Validate the actual changed behavior:

```bash
npm ci
npm run build
node dist/cli/index.js login
```

If the baseline was changed or remains part of a supported manual diagnostic, also run:

```bash
node -e "import('./dist/common/boss_availability.js').then(m=>m.assertBossCliAvailable()).then(()=>console.log('available'))"
```

Require every applicable command to pass. Fix the root cause of failures; do not weaken validation.

Stage only reviewed repair paths and commit local fixes with a Chinese message. Then review the complete delivery scope:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Stop and execute Clean Exit if unrelated content appears or the branch has no meaningful diff.

## Phase 5: Deliver Through the Repair Branch

Push and merge only after repair-branch validation passes:

```bash
git push -u origin "$(git branch --show-current)"
repair_branch="$(git branch --show-current)"
git switch main
git pull --ff-only origin main
git status --porcelain=v1
git merge --no-ff --no-commit "$repair_branch"
```

Require the status output before the merge to be empty. If it is not empty, do not merge or clean those unexpected paths; retain the repair branch and stop.

If the merge conflicts, run `git merge --abort`, remain on clean `main`, retain the repair branch for diagnosis, and stop.

Validate the pending merge before committing:

```bash
npm ci
npm run build
node dist/cli/index.js login
```

Run the availability diagnostic too when the baseline changed. If validation fails, run `git merge --abort`, verify clean `main`, retain the repair branch, and stop.

When validation passes:

```bash
git commit -m "合并 Boss 登录修复"
git push origin main
git push origin --delete "$repair_branch"
git branch -d "$repair_branch"
```

Do not force-push, rebase shared history, create a PR as a fallback, force-delete a branch, or leave a pending merge.

## Phase 6: Update the Installed CLI

Run this only after `main` was pushed successfully. Rebuild final `main`, then choose one explicit installation source:

- If package-relevant files on final `main` are identical to npm's verified `gitHead`, install the exact npm version: `npm install -g "$pkg_name@$npm_version"`.
- If final `main` contains a verified login repair not yet published to npm, install from final local `main`: `npm install -g .`.

Verify:

```bash
boss --version
command -v boss
git status --porcelain=v1
```

Report whether the installed runtime came from npm or final local `main`. An installation failure does not undo a successful repository delivery, but it must be reported as incomplete and must not dirty the repository.

## Clean Exit

Run this before every final response, including failures.

1. Abort any pending merge created by this workflow.
2. If uncommitted changes belong entirely to this workflow, report their diff summary, restore only the recorded tracked paths, and remove only the exact recorded capture directory. Use path-scoped commands such as `git restore --staged --worktree -- <recorded-tracked-paths>` and `git clean -fd -- <exact-recorded-capture-directory>`. Never pass `.`, a repository root, a glob, or an unrecorded path to either cleanup command. Never clean an unresolved unrelated path.
3. Switch to `main`.
4. Delete an empty, unpushed repair branch with `git branch -d`; retain a committed or pushed unmerged repair branch for diagnosis.
5. Verify:

```bash
git branch --show-current
git status --porcelain=v1
git worktree list
```

Success requires the current branch to be exactly `main` and `git status --porcelain=v1` to be empty. If concurrent or unrelated changes make this impossible, stop and report that the clean-worktree invariant could not be satisfied; do not erase them.

## Output Requirements

Report:

- reproduced login failure and root cause
- `origin`, `upstream`, npm, local source, and installed CLI versions
- official commits synchronized before diagnosis
- repair branch and all commits created
- captured online versions and risk review when baseline repair ran
- exact files, guards, URLs, hashes, selectors, or commands changed
- branch and pending-merge validation results
- repair-branch push, `main` merge/push, and branch cleanup results
- installed CLI source and version
- final branch, final commit, and proof that the primary worktree is clean
