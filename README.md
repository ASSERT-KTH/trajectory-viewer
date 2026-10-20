# trajectory-viewer

Single-page, client-side viewer for coding-agent trajectories. It fetches a trajectory from the URL hash and renders it in the browser; nothing is sent to a server.

Supported formats (auto-detected):

- [ATIF](https://harborframework.com/docs/agents/trajectory-format) (Agent Trajectory Interchange Format) JSON, v1.0–v1.7: messages, reasoning, tool calls paired with their observations, multimodal content parts, per-step metrics, embedded `subagent_trajectories`, `trajectory_path` refs and `continued_trajectory_ref` (as links).
- Claude Code session JSONL (`~/.claude/projects/<project>/<session>.jsonl`), converted to ATIF in the browser.

Live examples:

- <https://ASSERT-KTH.github.io/trajectory-viewer/#file=examples/atif-example.json>
- <https://ASSERT-KTH.github.io/trajectory-viewer/#file=examples/claude-code-example.jsonl>

## Usage

```text
https://ASSERT-KTH.github.io/trajectory-viewer/#file=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.atif.json
```

- `#file=` takes an absolute URL or a path relative to the viewer. GitHub `blob` and gist page URLs are rewritten to their raw counterparts.
- `&step=N` scrolls to and highlights step N; clicking a step number sets it.
- Without `#file=`, the landing page accepts a URL, or a local file by drag-and-drop or file picker.
- Relative paths inside an ATIF file (images, subagent trajectories) resolve against the trajectory's URL.

The target file must be reachable by the browser: cross-origin restrictions (CORS) of the source server apply. `raw.githubusercontent.com` and gists work.

Trajectory content is untrusted: markdown is sanitized with DOMPurify, everything else is escaped.

## Development

No build step: `index.html` (renderer) and `trajectory.js` (format detection and Claude Code → ATIF conversion, also loadable in Node).

```sh
npm install
npx playwright install chromium   # or: export CHROME_PATH=/path/to/chrome
npm test                          # unit tests (node:test) + end-to-end tests (Playwright)
```

## License

MIT
