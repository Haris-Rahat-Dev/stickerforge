# Diagrams

Self-contained SVGs (light + dark aware). Open in a browser or view on GitHub.

- [`pipeline.svg`](pipeline.svg) — the whole flow: upload → edit → encode to WebP → build pack → add to WhatsApp, with the live estimate and measured-spec side branches.
- [`encode-stage.svg`](encode-stage.svg) — inside the encode: pick frame rate → extract 512px frames → merge holds → mux down the quality ladder → size check → ship or fail-closed.

See [`../../AGENTS.md`](../../AGENTS.md) for the authoritative architecture notes these summarize.
