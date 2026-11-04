---
title: Package and publish manually
---

Maintainers build a tested source export and push versioned images to the selected registry. End users should pull a published image; local builds are a separate source-development path. The current public release is `hiforceai/panda-force:0.0.3`. Verify a release digest after pushing and test a pristine container before announcing it.

```bash
PANDA_FORCE_IMAGE=hiforceai/panda-force:VERSION
export PANDA_FORCE_IMAGE
docker build -t "$PANDA_FORCE_IMAGE" .
docker push "$PANDA_FORCE_IMAGE"
```

Replace the example with your actual authenticated registry and reviewed version. Authenticate using your own registry tooling. Keep credentials outside source and build context. This command is a manual example, not evidence of a published image.

Users can set `PANDA_FORCE_IMAGE` to that exact tag and run:

```bash
docker compose pull panda-force
docker compose up -d --no-build
docker compose logs panda-force
```

Review source, dependency licenses, English comments and the explicit public inventory before exporting. Verify the final clean tree, then review staged files. No internal Git history, old help, design records or agent directories belong in the public snapshot. Release changes go to the private repository for review first.

## 0.0.3

Host-connected sessions now preserve asynchronous question tools as interactive cards. Choose an option or enter a custom answer, select **Add answer to message**, then send the message. Answer preparation preserves existing drafts; later replies collapse previous questionnaires into history.
