# T计划 v4 (prototype)

A chat-centred planner built around a small agent harness. You talk to the assistant or drop files
into the chat; it reads your data and the files, proposes a plan, and after one click writes it and
starts a segmented timer. Timing records feed a profile that the assistant plans from.

Status: the frontend runs in a browser (Chrome or Edge). The Windows shell has not been built for v4
yet, so reading a file by its path on disk is not available; drag the file in instead.

## Run

Open `index.html` in Chrome or Edge. No build step. Data is kept in the browser's `localStorage`
under `tplan.v4`. Connect a model in Settings: any OpenAI-compatible endpoint (DeepSeek, OpenAI, a
local server) or Anthropic. Without a model the assistant runs in local mode, which can only turn
typed lines into tasks and split a duration into equal segments.

## How it works

| Part | What it does |
| --- | --- |
| First-run interview | Three questions answered by clicking: focus length, daily time, best time of day |
| Files | PDF, `.docx`, `.pptx`, `.xlsx`, text and source files are parsed on this computer into text |
| Agent loop | The model answers in JSON: either one read-only tool call (`read_attachment`, `read_path`, `list_dir`, `get_history`) or a final answer. Up to 6 tool calls per turn |
| Proposal | Tasks with timed steps, goals with weekly milestones, habits. Nothing is written until confirmed |
| Timer | Walks a task's steps one by one, in the page or in a floating always-on-top window |
| Sessions | Each finished step records planned and actual minutes. Steps skipped within a minute record nothing |
| Profile | Actual-versus-planned ratio, typical focus length, time-of-day totals, difficulty feedback. A figure appears only after enough sessions |
| Memory | Facts the assistant learns are saved as notes you can read and delete |

## Layout

| File | Purpose |
| --- | --- |
| `js/core.js` | Pure rules: state, action validation, proposals, timer, profile, model context, local parser |
| `js/agent.js` | System prompt, reply protocol, tool loop |
| `js/files.js` | File-to-text parsing (ZIP/XML reader for Office files, pdf.js for PDF) |
| `js/platform.js` | Storage, model transport and local-file bridge for browser and Windows shell |
| `js/app.js` | Rendering and events |
| `vendor/pdfjs/` | pdf.js 3.11.174 (Apache-2.0) |
| `core.test.cjs` | Tests for `core.js` and `agent.js` |

## Test

```bash
node --test v4/core.test.cjs
```

## Known limits

- Old binary Office formats (`.doc`, `.ppt`, `.xls`) and scanned PDFs are not readable.
- Some PDFs that rely on predefined CJK character maps may extract as empty text.
- The floating timer window uses the Document Picture-in-Picture API; where it is missing the timer stays in the page.
