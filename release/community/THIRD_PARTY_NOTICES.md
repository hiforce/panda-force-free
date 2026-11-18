# Third-party notices

## Upstream attribution

PandaForce Free derives from [Codex WebUI (lezi-fun/codex-webui)](https://github.com/lezi-fun/codex-webui). The original Copyright (c) 2026 lezi-fun and complete MIT grant are retained in [LICENSE](./LICENSE) and [LICENSES/upstream-MIT.txt](https://github.com/hiforce/panda-force-free/blob/main/LICENSES/upstream-MIT.txt). We thank the upstream contributors.

## CodeMirror 6

The source viewer and project-document code blocks use the CodeMirror 6 packages, including `codemirror`, `@codemirror/*`, and Lezer language packages. They are distributed under the MIT License. Package-specific copyright and license files are retained in the installed npm packages.

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

The README banner uses PandaForce's own brand mark and newly generated promotional artwork.

The current PandaForce mark is defined by the SVG geometry in `src/shared/brand.js`. `public/assets/panda-mark.svg` and `panda-icon.png` are generated from that geometry. Activity indicators use source-controlled SVG icons and CSS animations. The previously extracted Codex.app images and animation JSON files have been removed from the current source tree and are not included in the free snapshot.

OpenAI, Codex, Anthropic and Claude names and marks belong to their respective owners. This project is independent of and is not endorsed by those companies.

## Patched and constrained dependencies

The repository includes a small MIT-preserving patch to urllib 2.44.1's optional proxy adapter, using the public modern `proxy-agent` API. The patch is applied by Bun from `patches/`; retain it for reproducible installs. `basic-ftp` is constrained to a patched release by `package.json` overrides. Their upstream copyright and license files remain in the installed packages. The audited versions and compatibility checks are documented in the release audit.

Dependency-specific license texts must accompany distributed binary/container packages where required. This file does not replace the actual installed dependency notices.

## Document conversion and export

Read-only Hexo configuration inspection uses `yaml` 2.8.2 (ISC), copyright
Eemeli Aro. Its complete notice is retained in [LICENSES/yaml-ISC.txt](./LICENSES/yaml-ISC.txt)
and in the installed package. Project code is not executed while reading YAML.

SFTP publication uses `ssh2` 1.17.0 (MIT). Its copyright and complete license remain in
the installed package. SSH host keys are explicitly verified; no affiliation with
OpenSSH or the ssh2 maintainers is implied.

Channel adaptation uses `twitter-text` 3.1.0 (Apache-2.0) for X-compatible character counting,
`entities` 6.0.1 (BSD-2-Clause) for HTML entity decoding, and `fflate` 0.8.2 (MIT) for asset bundles.
The full dependency notices remain in installed packages. The twitter-text license is also
retained in `LICENSES/twitter-text-Apache-2.0.txt`. X adapters are independent integrations;
no endorsement by X or Twitter is implied.

## Internationalization

PandaForce uses i18next 26.7.1 (MIT), i18next-icu 2.6.1 (MIT), and
intl-messageformat 12.1.4 (BSD-3-Clause) for namespaced translations and ICU
messages. Their copyright and full license texts remain in the installed
packages and must accompany redistributed bundles and containers.

## Immer

PandaForce uses Immer 11.2.9 for transactional state edits. Copyright (c) 2017 Michel Weststrate. The complete MIT grant is retained in [LICENSES/immer-MIT.txt](./LICENSES/immer-MIT.txt) and in the installed package.

## Visual document editor

The optional visual project-document editor uses Tiptap's open-source packages
(version 3.33.0, MIT) and ProseMirror. Tiptap's complete MIT notice is retained in
[LICENSES/tiptap-MIT.txt](./LICENSES/tiptap-MIT.txt); package-specific ProseMirror
and transitive dependency notices remain in the installed packages distributed
with container images. No hosted editor, commercial extension or cloud account
is required. Markdown is a derived exchange format; the versioned rich source
remains owned by PandaForce.

## Native Office package inspection

Authored HTML source inspection uses `parse5` 7.3.0 (MIT), copyright Ivan Nikulin.
The complete notice is retained in [LICENSES/parse5-MIT.txt](./LICENSES/parse5-MIT.txt)
and in the installed package. Parsing does not execute scripts or fetch linked resources.

Native PowerPoint package inspection uses `@xmldom/xmldom` 0.9.12 (MIT).
The complete upstream notice is retained in [LICENSES/xmldom-MIT.txt](./LICENSES/xmldom-MIT.txt)
and in the installed dependency. XML parsing is bounded and does not fetch external
relationships or execute document code.

## Built-in full-text search

The isolated local search worker uses MiniSearch 7.2.0 (MIT) and
wink-porter2-stemmer 2.0.1 (MIT). Complete notices are retained in
[LICENSES/minisearch-MIT.txt](./LICENSES/minisearch-MIT.txt) and
[LICENSES/wink-porter2-stemmer-MIT.txt](./LICENSES/wink-porter2-stemmer-MIT.txt),
and in the installed packages. Language recipe packages do not execute plugin code.

## CSS syntax for authored web previews

Packaged web previews use `@csstools/css-tokenizer` 3.0.4 (MIT) to decode CSS URL tokens. Its complete upstream notice is retained in [LICENSES/css-tokenizer-MIT.txt](./LICENSES/css-tokenizer-MIT.txt) and the checksum-verified vendored module in `src/server/creative/assets/vendor/`. CSS, image and font bytes are resolved only from the saved bundle.

## PDF text extraction

The generated text parser in `src/server/materials/vendor/pdf-parser.mjs` redistributes [unpdf 2.2.1](https://github.com/unjs/unpdf) and its serverless Mozilla PDF.js build. unpdf uses the MIT License; PDF.js uses the Apache License 2.0. Included PDFium JBIG2, Mozilla decoder and OpenJPEG portions retain their Apache/BSD notices. The complete upstream notices are kept under [LICENSES/unpdf](./LICENSES/unpdf), and the pinned package integrity, build recipe and generated-source hash are recorded in `src/server/materials/vendor/provenance.json`. This application uses text extraction; optional native rendering packages are not required.

## Default editable presentation template

The application presentation template was generated with [python-pptx 1.0.2](https://github.com/scanny/python-pptx) and retains its default Office theme and layout data. python-pptx is used only while preparing the embedded template; it is not an application runtime dependency. The MIT copyright and grant are retained in [LICENSES/python-pptx-template-MIT.txt](./LICENSES/python-pptx-template-MIT.txt).

## Optional video tools and CJK fonts

Docker source builds obtain FFmpeg, Fontconfig and Noto CJK fonts from the configured Linux package repository. Their distribution notices remain installed with those packages, including `/usr/share/doc/ffmpeg/copyright` and `/usr/share/doc/fonts-noto-cjk/copyright`. Administrator-supplied tools and fonts retain their own notices.
