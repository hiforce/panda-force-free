# Contributing to PandaForce Free

Contributions and independent forks are welcome under the applicable MIT terms. Maintenance and review are best effort; submitting an issue or patch does not create an SLA, priority commitment or acceptance deadline.

## Development setup

Use Bun 1.4.2, Node.js 22 and Git. From your clone:

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
bun run dev
```

The terminal worker requires Python 3, Make and a C++ compiler to build. Optional native integration checks also require the tested Codex CLI; signing in and model/API costs are your responsibility.

## Source layout

- `src/client/`: browser controllers, rendering, drafts, projects, approvals and settings.
- `src/server/`: authentication, HTTP/WS transport, native bridge, filesystem boundaries and metadata.
- `src/shared/`: protocol-independent helpers and shared view models.
- `public/`: styles, entry HTML, original PandaForce visuals and generated browser bundles.
- `scripts/`: local startup/development commands and reviewed release tools.
- `patches/`: the tracked urllib compatibility patch applied by Bun.
- `tests/`: unit, isolated integration and browser checks; some additional scripts require a prepared native environment.

Edit source modules, not generated bundles or `dist/`. Never include agent settings, credentials, logs, private prompts, account state, `.git`, private operational material or internal design records in a patch.

## Invariants to preserve

Authenticate workspace HTTP, SSE, WebSocket and terminal access. Shared daemon mode does not own the host daemon's lifecycle. Native notifications supply execution state; do not invent events, expose unavailable reasoning or resend a mutation after an uncertain acknowledgement.

Keep browser rendering sanitized, filesystem access canonicalized and bounded, review patches server-owned, pending request IDs exact, and drafts scoped to their session/project. Preserve focus during background updates, keyboard/touch access, mobile layouts, reduced-motion support and translated UI text. All code comments must be in English; translated interface text and test data are not comments.

## Validation

```bash
bun run check
bun run test:unit
bun run release:comments
bun audit
bun run build
```

For relevant browser changes, install Chromium with `bun x playwright install chromium` and run the isolated scripts listed in `.github/workflows/ci.yml`. The full `test:browser` list also contains scripts expecting a running native/authenticated service; do not run them blindly against a production endpoint. Use disposable state and test ports. Run `bun run test:integration` only after reviewing its native CLI and mock-provider prerequisites.

Explain the user-visible change, validation results, supported environment and limitations in the pull request. Include screenshots for material layout work. Do not conceal failed checks or imply that a mock protocol test proves every real-provider behavior.

## Licensing and updates

Submit only work you have permission to provide under MIT; identify third-party code/assets and retain required notices. Contributions do not transfer copyright. A fork can adopt its own contribution process while preserving existing rights and notices.

For later snapshots, follow [UPDATES.md](./UPDATES.md). Review every proposed change for MIT release eligibility; an existing public filename does not make future commercial additions automatically redistributable. Never merge private development history into this public repository. The release tools prepare patches but do not commit or push them automatically.
