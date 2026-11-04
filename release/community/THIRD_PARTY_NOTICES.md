# Third-party notices

## Upstream codex-webui

PandaForce Free derives from [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui). The original Copyright (c) 2026 lezi-fun and complete MIT grant are retained in [LICENSE](./LICENSE) and [LICENSES/upstream-codex-webui-MIT.txt](https://github.com/hiforce/panda-force-free/blob/main/LICENSES/upstream-codex-webui-MIT.txt). We thank the upstream contributors.

## CodeMirror 6

The read-only source viewer uses the CodeMirror 6 packages, including `codemirror`, `@codemirror/*`, and Lezer language packages. They are distributed under the MIT License. Package-specific copyright and license files are retained in the installed npm packages.

MIT License

Copyright (c) CodeMirror contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

## Lucide

The interface icons in `src/client/codex-icons.js` use the exact Lucide icon path data bundled with the locally installed Codex.app (`lucide-react` 0.456.0).

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

License reference: [Lucide ISC license](https://github.com/lucide-icons/lucide/blob/0.456.0/LICENSE).

## PandaForce visuals and activity indicators

The current PandaForce mark is defined by the SVG geometry in `src/shared/brand.js`. `public/assets/panda-mark.svg` and `panda-icon.png` are generated from that geometry. Activity indicators use source-controlled SVG icons and CSS animations. The previously extracted Codex.app images and animation JSON files have been removed from the current source tree and are not included in the free snapshot.

OpenAI, Codex, Anthropic and Claude names and marks belong to their respective owners. This project is independent of and is not endorsed by those companies.

## Patched and constrained dependencies

The repository includes a small MIT-preserving patch to urllib 2.44.1's optional proxy adapter, using the public modern `proxy-agent` API. The patch is applied by Bun from `patches/`; retain it for reproducible installs. `basic-ftp` is constrained to a patched release by `package.json` overrides. Their upstream copyright and license files remain in the installed packages. The audited versions and compatibility checks are documented in the release audit.

Dependency-specific license texts must accompany distributed binary/container packages where required. This file does not replace the actual installed dependency notices.
