# Updating a history-free source snapshot

This public repository starts with an exported source tree. It has its own public commits; private development commits and design/operating records are not part of that history.

## Baseline and provenance

Keep the original clean export and `SNAPSHOT.json` as an immutable baseline outside the working checkout. Its content hashes identify exported files. The maintainer keeps the private source-commit-to-public-commit mapping separately, outside the public snapshot. Do not put private commit messages, branch names or internal issue links into public release notes.

A snapshot manifest verifies the imported source tree; it is not a live checksum of every subsequent community edit. Public Git commits record those later edits. Do not rewrite community changes merely to make them match the old manifest.

## Preparing an update

1. In the maintained development repository, select a complete reviewed version. For selected patches, first apply the desired private commits in an isolated development branch/worktree based on the previous source version. Resolve dependencies and conflicts there, then test that result.
2. Review `release/community/public-files.json`: it freezes the approved public target paths. New files require explicit addition after license and content review; an existing filename is not proof that new commercial code is eligible. Export that exact committed tree with the same allowlist and metadata exclusions. The exporter reads Git blobs, not `.git` or a live filesystem copy. It excludes internal design/deployment/commercial documents and all agent or credential directories.
3. Verify both the previous clean export and the new export. Run tests and audit the dependency set. Preserve the clean export directories outside the public checkout.
4. Generate a full-index binary patch from the two verified exports:

```bash
bun scripts/release/prepare-update.mjs \
  --base /absolute/path/to/previous-export \
  --next /absolute/path/to/new-export \
  --out /absolute/path/to/update.patch
```

5. On a new branch in a clean public checkout, apply with three-way merging:

```bash
git switch -c update/reviewed-patch
bun scripts/release/prepare-update.mjs \
  --base /absolute/path/to/previous-export \
  --next /absolute/path/to/new-export \
  --out /absolute/path/to/reviewed-update.patch \
  --repo /absolute/path/to/public-checkout --apply
```

The tool writes no commit and pushes nothing. It imports baseline file blobs to support three-way merging without importing private commit history. Local changes, untracked files, secrets, extra snapshot files or modified export baselines stop the workflow. Merge conflicts remain visible for manual review; there is no automatic overwrite or conflict dismissal.

6. Review changes, resolve conflicts, run checks and create a public commit describing only the published behavior. Publish through the public repository's normal review process. Keep the new clean export and private mapping for the next update.

## Boundaries

Do not merge an internal branch into this public Git repository. Do not blindly cherry-pick internal commits: their messages, paths and dependencies may contain private material, and their parent history is unrelated. Preserve community changes through the three-way process.

Do not copy `.codex`, `.claude`, other agent settings, work memories, credentials, `.git`, build output, logs, private documentation or real deployment configuration into a release. The release path/content verifier is an additional gate, not a claim that every kind of secret can be recognized automatically. Review staged files and the final archive before publishing.

Maintenance and patch acceptance are best effort, without an SLA, guaranteed response time or resolution deadline. Commercial forks may use the MIT baseline under its terms; a future commercial policy cannot retroactively restrict this public baseline or its MIT-derived forks.
