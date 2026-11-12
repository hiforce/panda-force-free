---
title: Build-time static CDN
---

PandaForce can publish its compiled browser resources to Amazon S3 or an S3-compatible service and load them through a separate HTTPS CDN domain. Without `PANDA_FORCE_CDN_BASE_URL`, builds use local resources and do not contact object storage.

The upload includes every static file emitted into `public`, including feature bundles, lazy modules, CSS, images, language packs, workers, WebAssembly and vendor fonts. Static dependencies are rewritten before hashing. New objects use `<prefix>/YYYY/MM/<sha256>.<extension>`. A persistent `<prefix>/_index/` content index lets subsequent builds reuse identical files from previous months. Reused files are checked against their actual stored bytes. Cyclic imports between separate output files must be bundled together; a cycle or missing dependency stops the build.

HTML, authentication, API requests and the web-app manifest remain on the application origin. Manifest icons load from the CDN while installation scope and launch routes remain local. Runtime-computed static paths should use `staticAssetUrl()` from `src/client/static-assets.js`; it resolves paths using the verified URL map embedded in the page. API paths and user content must not use this helper.

## Storage and CDN

Keep the bucket private and use CloudFront Origin Access Control to read it. The build identity needs `s3:GetObject` and `s3:PutObject` on the configured prefix, including `_index/*`. Allow `s3:ListBucket` with an appropriate prefix condition so missing object lookups return 404 instead of an ambiguous access-denied error. No ACL changes or delete permissions are required.

The CDN must return correct MIME types and `Access-Control-Allow-Origin: *` for these public application resources, including requests carrying browser priority headers. CloudFront's managed `CORS-With-Preflight` response headers policy is suitable and can be selected on the free flat-rate plan. Uploads go to S3; browsers use the CDN viewer domain. Set the base URL to the CDN root that maps to the bucket root, without the object prefix.

Every build verifies uploaded or reused objects through S3 and the actual CDN, including final byte hashes, MIME types and cross-origin headers. Any failure stops the CDN build. Objects are immutable and use a one-year cache lifetime. Retain previous objects and their index records for rollbacks; do not remove old month directories during publication.

## Local build

Supply credentials through the build environment or a private environment file excluded from version control:

```bash
export PANDA_FORCE_CDN_BASE_URL=https://cdn.example.com
export PANDA_FORCE_CDN_BUCKET=example-static-bucket
export PANDA_FORCE_CDN_PREFIX=pandaforce/static
export AWS_REGION=ap-southeast-1
# Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY through your secret manager.
# Set AWS_SESSION_TOKEN as well when using temporary credentials.
bun run build:client
```

Optional `PANDA_FORCE_CDN_S3_ENDPOINT` selects an S3-compatible endpoint. A successful build writes `dist/cdn-public/index.html`, the local web-app manifest and `cdn-manifest.json` containing only URLs, object keys, hashes and verification counts. Production source startup selects this compiled directory when it exists. A subsequent build without CDN configuration removes the previous CDN output and returns to local resources. Source HTML and CSS are never rewritten in place.

## Container build

Create a private file outside the build context, readable only by its owner, containing shell-compatible assignments for `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and optionally `AWS_SESSION_TOKEN`. Supply it as a BuildKit secret:

```bash
docker build \
  --build-arg VERIFICATION_PROFILE=cdn \
  --build-arg PANDA_FORCE_CDN_BASE_URL=https://cdn.example.com \
  --build-arg PANDA_FORCE_CDN_BUCKET=example-static-bucket \
  --build-arg PANDA_FORCE_CDN_PREFIX=pandaforce/static \
  --build-arg AWS_REGION=ap-southeast-1 \
  --secret id=cdn_credentials,src=/secure/build-cdn.env \
  -t panda-force:cdn .
```

Credentials are mounted only for the upload step and are not copied into image layers or exposed as build arguments. The final image contains the verified CDN references and needs no upload credentials at runtime. Container rollout should happen only after the CDN build succeeds. Changing runtime environment variables cannot change references already compiled into an image; rebuild it instead.

The `cdn` verification profile checks CDN dependency rewriting, final hashes, deduplication, error handling, static transfer behavior and complete application loading in Chromium and WebKit. It records a targeted certificate with the unrun suites listed. Use `VERIFICATION_PROFILE=full` when full verification is required.

This option covers public application build resources. Session attachments, generated images, thumbnails, previews and exports retain their current storage and access controls; runtime storage settings are configured independently.
