# Vendored: xterm.js

Copied byte for byte from the npm tarballs. No build, no npm, no CDN: this folder is what the page loads.

| File | From | sha256 |
|---|---|---|
| `xterm.mjs` | `@xterm/xterm@6.0.0` `lib/xterm.mjs` | `b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59` |
| `xterm.css` | `@xterm/xterm@6.0.0` `css/xterm.css` | `854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6` |
| `addon-fit.mjs` | `@xterm/addon-fit@0.11.0` `lib/addon-fit.mjs` | `2d87e1bddc73be9111de8beee5370c3bb7aac9c94e18e6f245f02ca741ef1769` |

Tarball integrity:
- `@xterm/xterm@6.0.0`: `sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==`
- `@xterm/addon-fit@0.11.0`: `sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==`

Both are MIT (`LICENSE-xterm`, `LICENSE-addon-fit`).

Check: `sha256sum -c` against the table, or `cd js/vendor/xterm && sha256sum xterm.mjs xterm.css addon-fit.mjs`.

Only the `Terminal` and `FitAddon` APIs are used (`js/shells/term.js`), so swapping in another engine is one import.
Don't add `@xterm/addon-clipboard`: it can read the clipboard into the shell.
