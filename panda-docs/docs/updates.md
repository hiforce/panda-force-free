---
title: Update without internal history
---

Keep the previous clean export and its `SNAPSHOT.json` outside the working checkout. Its file hashes identify that baseline; public Git records later community edits.

For a new version or selected patch, test the reviewed result in the private development repository. Update the approved public file list only after checking ownership and license eligibility. Export the committed tree, then generate a full-index patch between the old and new clean exports.

```bash
bun scripts/release/prepare-update.mjs \
  --base /absolute/path/to/previous-export \
  --next /absolute/path/to/new-export \
  --out /absolute/path/to/update.patch \
  --repo /absolute/path/to/public-checkout --apply
```

Three-way application preserves independent public changes and stops on conflicts. The tool neither commits nor pushes. Do not merge private Git branches into the public repository. New commercial material in an existing filename still needs explicit review; a path whitelist cannot make that licensing decision.
