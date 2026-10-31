# Contributing to junto-inbox

## Branches and merges

- New work goes on a **`feat/<topic>`** or **`fix/<topic>`** branch. Push it freely.
- **`main` is the released line.** Every install pulls its plugin pin from
  `main`'s `.claude-plugin/marketplace.json`, so anything on `main` is shipped.
- Merge to `main` only through a pull request, once the work is proven
  (boot-tested, and verified live where possible):
  ```
  gh pr create --base main --fill
  gh pr merge <n> --merge
  ```
- `main` is protected: a PR is required, force-pushes and deletion are blocked.

## ⚠️ Merge commits only — never squash or rebase

`.claude-plugin/marketplace.json` pins the plugin to a **content commit SHA**,
not to a branch or tag. A squash or rebase merge rewrites the commits, so it
gives them **new SHAs**. The pinned SHA would then no longer be on `main`'s
history, and the pin breaks.

Always merge with **`gh pr merge --merge`**. A merge commit keeps the branch's
original commits, with their SHAs, in `main`'s history.

## Release procedure (on the branch)

1. Change the code (`server.ts`, `statusline.ts`, `hook.ts`, `schema.ts`).
2. In the **same commit**, do the version bookkeeping:
   - bump `version` in `.claude-plugin/plugin.json` (the version of record)
     and in `package.json`, keeping the two in lockstep;
   - bump the in-code client version strings in `server.ts`;
   - add an entry at the top of `CHANGELOG.md`.
   This commit is the **content commit**.
3. In a second commit, set `.claude-plugin/marketplace.json` `sha` to the full
   SHA of the content commit (run `git rev-parse HEAD` right after making the
   content commit).
4. Push the branch, open a PR, and merge it with `--merge`.
5. Update installs:
   ```
   claude plugin marketplace update tlemmons-junto-inbox
   claude plugin update junto-inbox@tlemmons-junto-inbox
   ```
   Then restart Claude Code, and confirm that `claude plugin list` shows the
   new version.

You can also pin after the merge, in a follow-up PR. Either way the pinned
SHA must be the content commit, and that commit must be reachable from `main`.

## License

Contributions are accepted under the repository's MIT license (see `LICENSE`).
