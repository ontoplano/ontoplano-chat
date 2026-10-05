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

Then it writes `~/.config/ontoplano-chat/config.toml`, offers to run as a
service, and prints a pairing code. Open the address on the phone, type the
code, add it to the home screen. Run `ontoplano-chat setup` again any time;
it keeps what it knows.

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

## The command

```
ontoplano-chat setup      the six questions; writes the config, prints a pairing code
ontoplano-chat serve      run the server
ontoplano-chat pair       print a pairing code (ten minutes, one use)
ontoplano-chat devices    the paired phones
ontoplano-chat revoke <name>
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

## Developing

```sh
make test     # vitest, then Playwright at phone and desktop width with fake engines
make lint     # prettier, eslint, tsc
```

See `AGENTS.md` for how the code is laid out and what a change owes.
