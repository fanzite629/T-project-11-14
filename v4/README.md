# T计划 v4 (prototype)

A chat-centred rewrite of the planner. The assistant reads your tasks, habits, long-term memory and
recent conversation, then **proposes** changes; nothing is written until you confirm.

Status: the frontend runs in a browser. The Windows shell has not been built for v4 yet;
`js/platform.js` already speaks the v3 shell's bridge (SQLite host object + `ai-request` messages).

## Run

Open `index.html` in Chrome or Edge. No build step and no dependencies. Data is kept in the
browser's `localStorage` under `tplan.v4`. Without a model configured the assistant runs in local
mode: each line you type becomes a proposed task (`明天 复习第三章 45分钟`).

To connect a model, open Settings and choose an OpenAI-compatible endpoint (DeepSeek, OpenAI, a
local server) or Anthropic, then enter the model name and API key.

## Layout

| File | Purpose |
| --- | --- |
| `js/core.js` | Pure rules: state shape, action validation, proposal confirm, model context, local parser |
| `js/platform.js` | Storage and model transport for browser and Windows shell |
| `js/app.js` | Rendering and events |
| `styles.css` | Styles, light and dark |
| `core.test.cjs` | Tests for `core.js` |

## Test

```bash
node --test v4/core.test.cjs
```
