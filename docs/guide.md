# ontoplano-chat

Talk to your ontoplano. Hold a bar on your phone and say "add a task to call
the bank on Friday"; a model answers, does it, and reads the answer back.
The model can run **on your own computer** or at an OpenAI-compatible provider.
The app token stays with the Chat server and is never sent to the model or the browser.

The model is a choice, not a requirement to run locally. The wizard offers
Ollama, OpenAI, Anthropic Claude's OpenAI-compatible endpoint, and other
compatible providers. A Codex-capable OpenAI API model can be selected by
model ID if it supports Chat Completions and tool calls. Chat needs a provider
API key for a hosted model; a Claude Code or Codex subscription/login is not
that key. Claude Code and Codex can also use Ontoplano's MCP server directly,
independently of this voice interface.

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
- **Can stay silent.** The speaker button in the header and the checkbox in
  Settings turn spoken replies off for that device; this also skips server
  speech synthesis. If Kokoro's Portuguese accent is unpleasant, choose the
  device's `pt-BR` voice or a [Piper Brazilian Portuguese voice](https://github.com/rhasspy/piper/blob/master/VOICES.md)
  in `ontoplano-chat setup voice`. Voice quality depends on the installed model.
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
4. **The model is offered tools relevant to each request** from the set
   allowed by `assistant.tools` and the token. The token's scopes are the
   outer fence. Tool results are data: the prompt says so,
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
ontoplano-chat stop       stop a foreground server or the systemd user service
ontoplano-chat install-service   install, enable and start the systemd user service
ontoplano-chat langfuse-check    check Langfuse reachability and project keys
ontoplano-chat langfuse-trace-test   send and verify a synthetic Langfuse trace
ontoplano-chat pair       print a pairing code (ten minutes, one use)
ontoplano-chat devices    the paired phones
ontoplano-chat revoke <name>
ontoplano-chat stack      bring up what the config names: Ollama and its model, the Speaches container(s), their models
ontoplano-chat doctor     check the model, the ears, the voice and the app
ontoplano-chat config     print-and-write a commented example of every key
```

`ontoplano-chat install-service` works after the one-line install;
`make install-service` does the same from a checkout. `ontoplano-chat stop`
uses a private control socket to stop a new foreground server or the service.
A foreground process started with an older version still needs Ctrl-C in its
terminal. `systemctl --user start ontoplano-chat` starts the service again.
`journalctl --user -u ontoplano-chat -f` follows its logs;
`loginctl enable-linger $USER` keeps it up when you are logged out.
`make demo` runs it with fake engines — no model, no ears, no app — so the
page can be looked at on any machine.

## Config

`~/.config/ontoplano-chat/config.toml`, written by `setup`; `ontoplano-chat
config` shows a commented example of every key. The sections: `[server]`
(host, port, `public_url`, `[server.tls]`), `[ontoplano]` (url, token — or
`ONTOPLANO_MCP_TOKEN`), `[llm]` (url, model, api_key), `[stt]`, `[tts]`,
`[assistant]` (name, language, `tools`, `confirm`, `history_turns`), and
optional `[langfuse]`. Data
lives in `~/.local/share/ontoplano-chat/`: `devices.json` (hashes),
`pairing.json` (a hashed code, briefly), `turns.jsonl` (the log).

[`AGENT.md`](../AGENT.md) contains the model-independent behavior rules.
The server loads it at startup and includes it in every model turn. Edit it
in your checkout and restart Chat to change how the assistant acts; never put
tokens or other secrets in this tracked file. The app's token and the actual
MCP tool list still determine what actions are possible. For a smaller model,
lower `[assistant].history_turns` to reduce context and latency; use `make eval`
with selected cases to compare behavior before relying on a model.

## From a checkout

Without the one-liner: `make build` installs, builds and links
`ontoplano-chat` into `~/.local/bin`; `make setup` then asks the questions;
`make install-service` runs it as a service. `make` alone lists the rest.

## Docker Compose

The included `compose.yaml` runs Chat, Ollama, and one Speaches service for
both speech recognition and synthesis if configured. Model downloads persist
in named volumes. It is separate from the native installation and has its own
pairing data. Compose mounts `compose.config.toml` as a secret inside Chat;
the file is ignored by Git.

```sh
cp compose.config.toml.example compose.config.toml
chmod 600 compose.config.toml
# Set [ontoplano].url and token; set [langfuse] if wanted.
make compose-up
make compose-pair
make compose-logs
make compose-down
```

The sample uses `http://ollama:11434/v1` and `http://speaches:8000` inside
Compose. It publishes only Chat on host `127.0.0.1:1497`; use Tailscale or a
trusted HTTPS proxy for a phone. Stop the native service or foreground server
before starting Compose on the same port. A service on the host's
`127.0.0.1` is **not** reachable from a container at that address. For a
hosted Ontoplano instance use its public URL. For a host-local instance,
`host.docker.internal` must reach a host interface on which the app listens;
binding the app only to host loopback will not work over Docker's bridge.
The same applies to a separately hosted Langfuse Compose project. Set its
`[langfuse].base_url` to an address reachable from the Chat container.

Compose uses the CPU images from [Ollama](https://docs.ollama.com/docker) and
[Speaches](https://speaches.ai/installation/). For GPU inference, adjust the
images and device reservations for your host as described by those projects.

## Developing

```sh
make test     # vitest, then Playwright at phone and desktop width with fake engines
make lint     # prettier, eslint, tsc
```

### Agent traces

For a [Docker Compose installation](https://langfuse.com/self-hosting/deployment/docker-compose), wait for Langfuse to be ready and open `http://localhost:3000`. Sign up, create an organization and project, then open **Project settings → API Keys** and create a key pair. Copy its `pk-lf-…` public key and `sk-lf-…` secret key. These are project API keys from the Langfuse UI, not values from its Compose file. The [Langfuse tracing guide](https://langfuse.com/docs/observability/get-started) uses the same keys.

Put them beside your other machine settings in `~/.config/ontoplano-chat/config.toml`:

```toml
[langfuse]
public_key = "pk-lf-your-project-key"
secret_key = "sk-lf-your-project-secret"
base_url = "http://127.0.0.1:3000"
```

Keep the file private with `chmod 600 ~/.config/ontoplano-chat/config.toml`. `base_url` is optional for Langfuse Cloud; for your self-hosted Compose installation, use its web/API origin without `/api/public`. Host `127.0.0.1:3000` works when Chat runs natively on that same host. In the Chat Compose container, use an address reachable from that container instead. `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in the process environment override the TOML values. An older `langfuse.env` file still works, including for foreground `serve`, but is no longer needed.

`ontoplano-chat langfuse-check` verifies network access and the keys; it sends no trace. `ontoplano-chat langfuse-trace-test` sends a synthetic trace, waits until the Langfuse API can read it, and prints its trace ID. It never contacts Ontoplano or the model. For actual conversations, restart the server after changing config and check its startup line for the Langfuse URL. Without both keys, tracing is off. The server flushes traces on shutdown, and a Langfuse outage does not prevent replies. `make eval-langfuse` remains separate and requires keys in its shell environment; it deliberately does not read Ontoplano's config or token.

One interaction is an agent observation, with child observations for each model generation and each client-side MCP call. The trace includes a random conversation session ID, input, output, model name, model server hostname, call arguments and results, failures, and provider-reported token usage. Confirmation creates a separate interaction in the same conversation; it never executes the destructive tool before approval. Langfuse may calculate cost for a model it knows. No cost is invented for unknown or local models.

Trace content may contain private task and note text. Use a Langfuse instance you trust. `src/observability.ts` is the single redaction policy: it removes credential-named fields, Bearer values, common key shapes, and configured app, model, speech, and Langfuse keys before export. Extend `redact()` for any additional private patterns in your deployment. Do not put secrets into tool names or model names.

### Agent evaluations

`make eval` runs 30 synthetic cases through the real model and agent loop. It never loads your Ontoplano config, token, MCP server, or account. Changing `[ontoplano].url` from `app.ontoplano.com` to `localhost:1493` does **not** change an eval run. A fresh in-memory synthetic tool backend and temporary turn history are used for each case. The model defaults to `http://127.0.0.1:11434/v1` and `qwen3.5:9b`; set `EVAL_MODEL_URL`, `EVAL_MODEL_NAME`, and optionally `EVAL_MODEL_API_KEY` to test another OpenAI-compatible model. Without Langfuse keys, the model endpoint is the only network target. The command prints both endpoints, the model probe, per-round and per-tool durations, each case's elapsed time, and reasons for failures. `make eval-check` validates the case list and tool definitions without contacting a model.

To investigate a few failures without repeating the full run, use `EVAL_CASES=today,recurring-add,goals-add,goals-progress,workouts-read make eval`. The summary then covers only those selected cases. A failed case prints its expected and observed calls and the reason it failed.

Cases live in `eval/cases.ts`; tool definitions in `eval/tools.json` are a curated snapshot of the actual Ontoplano MCP manifest. Run `node scripts/update-eval-tools.mjs` beside the app checkout to refresh schemas and mutation flags; review the descriptions and cases after a contract change. A case names expected calls in order, important argument values, forbidden calls, whether a mutation or confirmation is expected, and optional required answer concepts. `eval/evaluate.ts` scores selection, argument values, completion, and unsafe mutations deterministically. Completion requires the expected calls to succeed, a nonempty answer, and any required answer concepts; a confirmation case must stop before executing. This is a behavioral proxy, not a semantic judge. Latency is measured around the turn; tokens are reported only when the model API supplies usage. For a priced model, set `EVAL_INPUT_USD_PER_MILLION` and `EVAL_OUTPUT_USD_PER_MILLION` to show an estimated USD cost. The command exits nonzero if any case fails. `make eval-langfuse` runs the same cases as a Langfuse local-data experiment with item-level scores; it requires the Langfuse keys and sends synthetic case inputs and outputs to that instance.

See [AGENTS.md](../AGENTS.md) for the code layout and development conventions.
