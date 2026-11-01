# Vendored libraries

Copied verbatim from npm so the site has no runtime CDN dependency.

| File | Package | Version | License |
|---|---|---|---|
| `preact-htm.js` | `htm/preact/standalone.module.js` (Preact + hooks + htm in one ES module) | htm 3.1.1 | MIT / Apache-2.0 |
| `supabase.js` | `@supabase/supabase-js/dist/umd/supabase.js` (sets `window.supabase`) | 2.118.0 | MIT |
| `peerjs.min.js` | `peerjs/dist/peerjs.min.js` (sets `window.peerjs`) | 1.5.5 | MIT |

Only `preact-htm.js` is loaded up front. The other two are injected lazily by
`js/net/*.js`, only when that transport is used.
