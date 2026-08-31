# Fonts

Two OFL-licensed variable webfonts, latin subset, vendored here so the site makes
no third-party font requests. The footer's "holds no tracking" claim depends on
that: every byte a report loads comes from this origin.

| File | Family | Source | License |
|---|---|---|---|
| `PlusJakartaSans-latin.woff2` | Plus Jakarta Sans, wght 200–800 | Google Fonts (tokotype/PlusJakartaSans) | OFL 1.1 — `OFL-PlusJakartaSans.txt` |
| `JetBrainsMono-latin.woff2` | JetBrains Mono, wght 400–500 | Google Fonts (JetBrains/JetBrainsMono) | OFL 1.1 — `OFL-JetBrainsMono.txt` |

Both are referenced from the absolute path `/fonts/...` in the stylesheet in
`lib/report-html.js`. That path resolves on the Render web service (routed in
`server.js`) and on the static site (served from `site/`). A report opened as a
bare `file://` will not find them and falls back to the system sans stack —
acceptable and intentional.

Latin subset only (~27KB and ~31KB). Non-latin characters fall back.
