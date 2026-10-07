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
src/tool-selection.ts   choose relevant granted tool schemas for one request
src/control.ts     private socket for stopping foreground or service processes
src/describe.ts    the receipt for an action: one line and a link into the app
src/history.ts     turns.jsonl — the log and the phone's history
src/prompt.ts      the system prompt
ASSISTANT_INSTRUCTIONS.md   runtime rules sent to every model; separate from this developer file
src/server.ts      HTTP: the page, the API, the stream, the headers, the limits
src/engines.ts     the four engines from the config, or the fakes
src/fakes.ts       a model, ears, voice and app that need nothing installed
src/ask.ts         questions on a terminal; a scripted one for the tests
src/wizard.ts      `setup`: the six questions and the config they become
src/cli.ts         setup · serve · pair · devices · revoke · doctor · config
src/langfuse-trace-test.ts   synthetic trace delivery check
install.sh         the one-line install: clone, build, PATH, then `setup`
Dockerfile / compose.yaml   container stack for Chat, Ollama, and Speaches
compose.config.toml.example   private Compose config template; copy to ignored compose.config.toml
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
- **Agent evals use synthetic data.** `make eval` sends 30 cases from
  `eval/cases.ts` through the real model and a disposable in-memory tool backend;
  it never connects to a real Ontoplano account. `make eval-check` validates the
  fixtures without a model. Refresh `eval/tools.json` from the sibling app's
  static MCP manifest with `node scripts/update-eval-tools.mjs`, then review
  descriptions and expectations.
- **Compose is a separate runtime.** `make compose-up` builds Chat and starts
  Ollama and Speaches; it uses `compose.config.toml` as a secret and named
  volumes. `make compose-pair` prints its pairing code. Do not assume a host
  `127.0.0.1` service is reachable from a Compose container.
- **Say "device", not "phone", wherever the thing pairing could be this
  computer's own browser** — the command's words, the wizard's, the page's.
  The first real run paired the computer and read "now pair the phone" after
  "a phone cannot reach it yet", which contradicted itself.
- **The wizard remembers.** Every step's defaults are what the config says
  now, and `setup <step>` redoes one step over the rest. A question that
  forgets an answer given a step earlier (the Speaches URL, say) is a bug.
- **One pairing code at a time.** `serve` prints a code only when none is
  pending; `setup` issues its code before starting the service. Two codes
  printed in a row means the first is dead.
- **A readout names the thing, never the API flavour.** `openai` is the
  config's `kind` — "an OpenAI-compatible server" — and a person reading
  "voice openai" learns nothing. Every Stt and Tts carries `about` (the
  model or voice, and where it runs); doctor, the start banner and the
  phone's settings sheet print that.
- **A local speech server is checked for the model, not only for a pulse.**
  Speaches answers 404 on the first turn when the model is not downloaded;
  `speechServerCheck` asks `/v1/models` first, and setup, doctor and
  `ontoplano-chat models` offer the download.
- **The installer owns the stack.** Ollama and its model, the Speaches
  container(s) and their models are brought up by `ontoplano-chat stack`
  (`src/stack.ts`), which `setup` and `make install-service` run. Nothing —
  not doctor, not the wizard, not a reply — hands the person a `docker run`
  or an `ollama pull` to type; a thing that is missing and can be had is had.
- **The token is the fence; the tool list only orders.** `assistant.tools`
  defaults to the everyday ones first and then `*`. A key confined to one
  notebook grants a different set than any fixed list names, and a fixed
  list silently hid the notebook tools from the model.
- **Every step of a turn is in the journal** — heard, each model round with
  its duration and thinking, each tool and its answer. A turn that hangs on
  "…" must be explainable from `journalctl --user -u ontoplano-chat`.
- **MCP is the source of agent context.** Chat reads the server's instructions
  and access boundary during initialize, then uses its live tool schemas for
  arguments. A clear action answered without a tool gets one retry with the
  full available list. Keep this behavior general across tools.
- **The voice speaks the assistant's language.** Kokoro's first letter is its
  language; the default follows `assistant.language` and doctor fails a
  mismatch.
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
