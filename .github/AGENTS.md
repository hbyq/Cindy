# hbyq/Cindy fork CI maintenance

These rules apply to this fork's `.github` files, in addition to the root rules.

- All changes stay in `hbyq/Cindy`. Do not open upstream pull requests.
- Routine rebases update only `.github/cindy-customizations.json`. Its two values
  are full immutable commit SHAs retained by main. The build reads this file from
  the triggering commit, not the moving main branch.
- Do not rewrite `custom-windows-build.yml` just to update customization SHAs.
  Keep the four-job build, publish, cleanup-handoff and report-status graph.
- Never replace a workflow with a placeholder, a local path, a partial excerpt,
  or an intentionally failing stub. A transport/payload limitation is not a
  reason to overwrite a working workflow. Leave the remote file unchanged.
- For large-file changes, prepare the complete replacement blob, validate it,
  create a tree/commit using its exact blob SHA, then fast-forward the ref with
  force=false. Re-read main before updating it; reconcile concurrent changes.
- Read back the committed blob SHA and check the entire job graph after a write.
  Content parameters take actual UTF-8 text, not file paths or magic markers.
- GitHub Actions' GITHUB_TOKEN is not a workflow-editing credential. Do not ask
  a runner to push changes under `.github/workflows`. Use a connection explicitly
  authorized to write workflows; stop on a permission denial.
- Preserve read-only build credentials, allow-listed single-commit customizations,
  DCO checks, full tests, monotonic versions, SHA-256 asset validation and isolated
  publication. Do not weaken checks to obtain a green run.
- `custom-workflow-integrity` checks structural regressions independently of
  `client-ci`. A green client-ci alone is not proof of a successful custom build.
- Report successful publication only after the build and publish jobs succeed
  and `custom-update-channel/channel-state.json` identifies the same run.
