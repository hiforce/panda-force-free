# CSS tokenizer compatibility distribution

This directory carries the upstream ES module and declarations from
`@csstools/css-tokenizer` 3.0.4. It keeps all application builds independent of a new
installed package while preserving the reviewed standard CSS parser.
The module body and declarations are unchanged upstream bytes. The generated
module header identifies the vendor boundary; application formatting, linting
and JavaScript type inference do not rewrite that upstream implementation.
The upstream TypeScript declarations still check application calls.

The full MIT grant and attribution are in `LICENSES/css-tokenizer-MIT.txt`.
`scripts/vendor-css-tokenizer.mjs` checks the exact upstream package version,
module, declarations and license hashes before regenerating the files:

```sh
node scripts/vendor-css-tokenizer.mjs /path/to/@csstools/css-tokenizer
```

The original NJ lockfile, installation profile, base recipes, registry and
delivered image tags remain unchanged. Ordinary source integration does not
require installing or replacing dependency images.
