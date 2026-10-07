# ontoplano-chat

Talk to your ontoplano. Hold a bar on your phone and say "add a task to call
the bank on Friday"; a model answers, does it, and reads the answer back.
The model can run **on your own computer** — then nothing you say leaves the
house — or at any provider you already pay for. Either way the one secret,
the app's token, never leaves the computer this runs on.

## Install

One line, on the computer that will run it (Linux or macOS, Node 22+):

```sh
curl -fsSL https://github.com/ontoplano/ontoplano-chat/raw/master/install.sh | sh
```

It clones into `~/.local/opt/ontoplano-chat`, builds, puts `ontoplano-chat`
on your PATH, and asks six questions:

1. **The app** — where your ontoplano is, and an API token from
   _Settings → AI & Integrations_. Checked on the spot: it says how many
   tools the token grants.
2. **The model** — where it should think:
   - _Ollama, on this computer_ (default): installs Ollama and pulls the
     model if asked. Everything stays local.
   - _Another local server_ — llama.cpp, LM Studio, vLLM, anything
     OpenAI-compatible with tool calling.
   - _OpenAI, Anthropic, Groq, Mistral, OpenRouter, Google Gemini_, or a
     URL of your own — with their key. The wizard says plainly that what you
     say then goes to them.
3. **The ears** — Speaches on this computer (faster-whisper in a container;
   it offers to start it), a whisper.cpp server, a cloud transcriber, or the
   phone's own recogniser.
4. **The voice** — the phone's own (zero setup, on-device on Android), piper
   on this computer, Speaches, or a cloud voice.
5. **The name and the language** it answers in.
6. **How the phone reaches this computer** — Tailscale (it reads your
   tailnet name and runs `tailscale serve` for you), a TLS proxy you run,
   its own certificate, or only this computer for now.

Then it writes `~/.config/ontoplano-chat/config.toml`, **brings the stack up**
— installs and starts Ollama and pulls the model, starts the Speaches
container(s) the config names and downloads their models — offers to run as
a service, and prints a pairing code. `ontoplano-chat stack` does that part
again any time (after a reboot, after editing the config); it finds what is
already there and leaves it. Open the address on the device — a phone,
or a browser on this computer — type the code, and on a phone add it to the
home screen. `ontoplano-chat setup` again keeps what it knows, and
`ontoplano-chat setup ears` (or `app`, `model`, `voice`, `assistant`,
`reach`) asks one step again — changing a port is one question.

```
   phone (PWA)  ──https──▶  ontoplano-chat (your computer)  ──▶  the model: Ollama here, or a provider
                               │        │
                               │        └──▶  ears: Speaches / whisper.cpp · voice: the phone / piper
                               └──▶  app.ontoplano.com/api/mcp   (your account, your token)
```

## What it does

- **Hold to talk.** The bar at the bottom records while held; a tap leaves it
  listening until the next tap. There is a text box too.
- **Acts, and shows the receipt.** Every tool call is a chip under the reply —
  "add task · #812 buy milk" — with a link that opens the thing in the app.
  The model's words are the answer; the chips are the proof.
- **Asks before anything irreversible.** Removing, dropping, cancelling: the
  turn stops and asks. Yes and No are buttons, and "sim" or "no" said aloud
  works too.
- **Stops talking when you do.** Pressing the bar while it speaks cuts the
  voice off (and a hold goes straight on to listening); so does Escape, and
  so does sending anything new.
- **Speaks your language, in the voice you chose.** `ontoplano-chat setup
assistant` can let whisper detect the language you speak each turn; the
  answer and the voice follow it. Detection is free — whisper guesses the
  language first anyway — but on a two-word clip it is sometimes wrong, so a
  fixed language is the safer choice if you only ever speak one. `setup
voice` picks a male or a female voice; Kokoro has both for most languages
  (French has only a female one).
- **Remembers the conversation** for half an hour, so "and put it on
  Friday" follows "add a task to call the bank".
- **Keeps a log** of what was heard, said and done, readable on the phone
  under _What was done_ and in `~/.local/share/ontoplano-chat/turns.jsonl`.
- **Installs on the phone** as an app: Chrome → _Add to home screen_.

## Security, in order of what matters

1. **The ontoplano token stays on the computer.** The phone never sees it; it
   gets a device token of its own, which the server stores only as a hash.
2. **Pairing is a six-digit code** printed by `ontoplano-chat pair`, good for
   ten minutes, used once, burned after five wrong guesses, and rate-limited
   per address. A phone can be forgotten from itself or with
   `ontoplano-chat revoke <name>`.
3. **HTTPS, or nothing.** The server refuses to listen on a network address
   without TLS. The phone's microphone only opens on a secure origin anyway,
   so plain HTTP would be a server nobody could talk to. The usual
   arrangement is loopback behind `tailscale serve`.
4. **The model is offered a short list of tools** (`assistant.tools`), not the
   app's two hundred, and can only call what it was offered; the token's
   scopes are the outer fence. Tool results are data: the prompt says so,
   and nothing a note contains can grant a tool.
5. **A cloud model is a choice you make by name.** The wizard marks every
   non-local option as such; with a local model, local ears and the phone's
   voice, nothing leaves your machines but the calls to your own ontoplano.
6. **A strict Content-Security-Policy**, no cookies (so no CSRF), ceilings on
   every request body, a turn limit per device, and a log that is written
   before the reply is spoken.

## Reaching it from the phone

The server listens on `127.0.0.1:1497`. The wizard sets one of these up;
here is what each means:

- **Tailscale** (recommended): both devices on your tailnet, then on the
  computer `tailscale serve --bg 1497`. That gives the phone an https name
  with a real certificate and opens no port to the internet.
- **A TLS proxy you already run** (Caddy, nginx) on a name that resolves to
  the computer: proxy to `127.0.0.1:1497`, and give the wizard that address.
- **Its own certificate**: `[server.tls]` with a cert and key the phone
  trusts (`mkcert` on a LAN, or Let's Encrypt), and `host = "0.0.0.0"`.

## What runs where, and its logs

| thing              | what it is                                                           | where it lives                                                                                                                                   | logs                                                                                                                       |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **ontoplano-chat** | this server: the page, the pairing, the turn loop                    | code in the checkout; `~/.config/ontoplano-chat/config.toml`; `~/.local/share/ontoplano-chat/` (devices, pairing code, `turns.jsonl`); port 1497 | `journalctl --user -u ontoplano-chat -f` (`make logs`); every turn in `turns.jsonl` and on the phone under _What was done_ |
| **the page**       | what the device opens                                                | served by the server from `web/`                                                                                                                 | the browser's console; the settings sheet says what each engine is and what is wrong with it                               |
| **the model**      | Ollama, or the provider chosen                                       | Ollama: `ollama.service` (system), models under `/usr/share/ollama/.ollama/models` (or `~/.ollama` when run by hand), port 11434                 | `journalctl -u ollama -f`; `ollama list`, `ollama ps`                                                                      |
| **the ears**       | Speaches (faster-whisper), or whisper.cpp, or a cloud, or the device | a Docker container: `docker ps`; its models in the container's Hugging Face cache; API docs at `http://127.0.0.1:<port>/docs`                    | `docker logs -f <container>`                                                                                               |
| **the voice**      | the device's own, piper, Speaches (Kokoro), or a cloud               | same as the ears when it is Speaches: `docker ps -a` (a stopped one shows there)                                                                 | `docker logs -f <container>`; piper writes to the server's log                                                             |
| **the app**        | your ontoplano, reached over MCP with the token                      | wherever it is served — not this computer                                                                                                        | its own box's journal                                                                                                      |

`ontoplano-chat doctor` asks each of them the question a turn asks — a one-word
completion, a moment of silence transcribed, a word spoken, the tool list — and
says what to do under anything that fails.

## The command

```
ontoplano-chat setup      the six questions; writes the config, prints a pairing code
ontoplano-chat setup <step>   one of them again: app · model · ears · voice · assistant · reach
ontoplano-chat serve      run the server
ontoplano-chat pair       print a pairing code (ten minutes, one use)
ontoplano-chat devices    the paired phones
ontoplano-chat revoke <name>
ontoplano-chat stack      bring up what the config names: Ollama and its model, the Speaches container(s), their models
ontoplano-chat doctor     check the model, the ears, the voice and the app
ontoplano-chat config     print-and-write a commented example of every key
```

`make install-service` runs it as a systemd user unit (`make logs` follows
it; `loginctl enable-linger $USER` keeps it up when you are logged out).
`make demo` runs it with fake engines — no model, no ears, no app — so the
page can be looked at on any machine.

## Config

`~/.config/ontoplano-chat/config.toml`, written by `setup`; `ontoplano-chat
config` shows a commented example of every key. The sections: `[server]`
(host, port, `public_url`, `[server.tls]`), `[ontoplano]` (url, token — or
`ONTOPLANO_MCP_TOKEN`), `[llm]` (url, model, api_key), `[stt]`, `[tts]`,
`[assistant]` (name, language, `tools`, `confirm`, `history_turns`). Data
lives in `~/.local/share/ontoplano-chat/`: `devices.json` (hashes),
`pairing.json` (a hashed code, briefly), `turns.jsonl` (the log).

## From a checkout

Without the one-liner: `make build` installs, builds and links
`ontoplano-chat` into `~/.local/bin`; `make setup` then asks the questions;
`make install-service` runs it as a service. `make` alone lists the rest.

## Developing

```sh
make test     # vitest, then Playwright at phone and desktop width with fake engines
make lint     # prettier, eslint, tsc
```

### Agent traces

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in the service environment to enable Langfuse. `LANGFUSE_BASE_URL` selects a self-hosted or regional endpoint; without it the SDK uses Langfuse Cloud's default. Without both keys, tracing is off and the assistant works normally. The server flushes traces on shutdown. An unavailable Langfuse endpoint does not gate a reply.

One interaction is an agent observation, with child observations for each model generation and each client-side MCP call. The trace includes a random conversation session ID, input, output, model name, model server hostname, call arguments and results, failures, and provider-reported token usage. Confirmation creates a separate interaction in the same conversation; it never executes the destructive tool before approval. Langfuse may calculate cost for a model it knows. No cost is invented for unknown or local models.

Trace content may contain private task and note text. Use a Langfuse instance you trust. `src/observability.ts` is the single redaction policy: it removes credential-named fields, Bearer values, common key shapes, and configured app, model, speech, and Langfuse keys before export. Extend `redact()` for any additional private patterns in your deployment. Do not put secrets into tool names or model names.

### Agent evaluations

`make eval` runs 29 synthetic cases through the real model and agent loop. It never loads your Ontoplano config, token, MCP server, or account. A fresh in-memory synthetic tool backend and temporary turn history are used for each case, and the runner has no Ontoplano MCP HTTP client. The model defaults to `http://127.0.0.1:11434/v1` and `qwen2.5:7b`; set `EVAL_MODEL_URL`, `EVAL_MODEL_NAME`, and optionally `EVAL_MODEL_API_KEY` to test another OpenAI-compatible model. The model endpoint is the only network target. `make eval-check` validates the case list and tool definitions without contacting a model.

Cases live in `eval/cases.ts`; tool definitions in `eval/tools.json` are a curated snapshot of the actual Ontoplano MCP manifest. Run `node scripts/update-eval-tools.mjs` beside the app checkout to refresh schemas and mutation flags; review the descriptions and cases after a contract change. A case names expected calls in order, important argument values, forbidden calls, whether a mutation or confirmation is expected, and optional required answer concepts. `eval/evaluate.ts` scores selection, argument values, completion, and unsafe mutations deterministically. Completion requires the expected calls to succeed, a nonempty answer, and any required answer concepts; a confirmation case must stop before executing. This is a behavioral proxy, not a semantic judge. Latency is measured around the turn; tokens are reported only when the model API supplies usage. For a priced model, set `EVAL_INPUT_USD_PER_MILLION` and `EVAL_OUTPUT_USD_PER_MILLION` to show an estimated USD cost. The command exits nonzero if any case fails. Failure details remain in the per-case PASS/FAIL output and traces when Langfuse is enabled. `make eval-langfuse` runs the same cases as a Langfuse local-data experiment with item-level scores; it requires the Langfuse keys and sends synthetic case inputs and outputs to that instance.

See `AGENTS.md` for how the code is laid out and what a change owes.
