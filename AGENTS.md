# ontoplano-chat — working here

One of the ontoplano repositories, beside the app at `../ontoplano`. The
app's `AGENTS.md` holds the queue, the review handshake and the git rules;
they apply here. This file is what is particular to this repository.

## What it is

A server on the person's own computer and a page on their phone. The phone
sends what was said (audio, or text); the server transcribes it, runs the
tool-calling loop against a local OpenAI-compatible model with the app's MCP
tools, acts on the app, and answers — as text, and as speech when the voice
runs here rather than on the phone. See `README.md` for the shape and the
security model; this file is about the code.

## Layout

```
src/constants.ts   every number and name — ports, limits, the default tool list
src/config.ts      the TOML config, its defaults, the serving refusal, the example file
src/pairing.ts     devices and pairing codes; hashes on disk, never tokens
src/mcp.ts         the JSON-RPC client to the app; which tools are offered; the LLM's view of them
src/llm.ts         the model: OpenAI-compatible chat completions with tools
src/speech.ts      ears (openai | whispercpp | browser) and voice (openai | piper | browser)
src/turn.ts        the loop: hear → think → act (with the confirmation gate) → answer → speak
src/describe.ts    the receipt for an action: one line and a link into the app
src/history.ts     turns.jsonl — the log and the phone's history
src/prompt.ts      the system prompt
src/server.ts      HTTP: the page, the API, the stream, the headers, the limits
src/engines.ts     the four engines from the config, or the fakes
src/fakes.ts       a model, ears, voice and app that need nothing installed
src/cli.ts         serve · pair · devices · revoke · doctor · config
web/               the phone: index.html, app.js, strings.js, style.css, sw.js, icons
tests/             vitest — every module above, with the fakes
e2e/               Playwright — the page, at phone and desktop width
```

## Rules that are this repository's own

- **The app's token is never printed, logged, or sent to the phone.** It is
  read in `config.ts`, used in `mcp.ts`, and appears nowhere else. A log line
  that could carry it is a bug.
- **The phone is authenticated on every API call but `/api/health` and
  `/api/pair`.** A new route starts from `authenticate(req)`.
- **The model may only call what it was offered.** `turn.ts` refuses a call
  to a tool outside `tools()` before it reaches the app; a new path that
  sends a tool call must go through `perform()`.
- **Anything in `assistant.confirm` stops and asks.** Never make a path that
  runs a confirm-listed tool without `pending`. The yes/no words per language
  are in `constants.ts`; a new language adds its words there and its strings
  in `web/strings.js`.
- **Every word the phone shows is in `web/strings.js`**, in every language
  there, reached through `t()`. No inline text in `app.js` or `index.html`
  beyond what `data-t` fills.
- **The page moves nothing under a press.** The error line on the pairing
  form, the status in the header, the buttons on an answered question: all
  keep their room. A new control follows the same rule.
- **Numbers live in `constants.ts`** (server) or at the top of `app.js`
  (phone), named. Nothing inline.
- **Fake engines are the test bed.** `ONTOPLANO_CHAT_ENGINES=fake` builds
  `src/fakes.ts`; the unit tests and the e2e suite run against them. A new
  tool the fake app should understand is added there, with a sentence shape
  the fake model maps to it.
- **The data directory is private**: files are written `0600` through
  `writePrivate()`, the directory `0700`. Keep it so.

## Testing

```sh
yarn vitest run tests/<one>.test.ts     # seconds
yarn playwright test --project=phone    # the page, against the fake server
make lint
```

The e2e suite starts its own server on port 14970 with a throwaway data
directory under `test-results/`, pairs through the real command, and leaves
screenshots in `test-results/shots/` — look at them after a change to the
page.

## Versions

`package.json`'s version is shown in the settings sheet and written into the
service worker's cache name, so bumping it is what makes a phone pick up a
new page. Bump the patch with any change the phone would notice.
