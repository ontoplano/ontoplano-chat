# ontoplano-chat

A voice assistant for ontoplano that runs on your own computer. You hold a bar
on your phone and talk; a model on your machine listens, decides, acts on your
ontoplano through the same MCP door any assistant uses, and answers out loud.
Nothing you say leaves the house, and the one secret — the app's token —
never leaves the computer.

```
   phone (PWA)  ──https──▶  ontoplano-chat (your computer)  ──▶  Ollama / llama.cpp
                               │        │                          (the model)
                               │        └──▶  Speaches / whisper.cpp (ears), piper (voice)
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
   arrangement is loopback behind `tailscale serve` (below).
4. **The model is offered a short list of tools** (`assistant.tools`), not the
   app's two hundred, and can only call what it was offered; the token's
   scopes are the outer fence. Tool results are data: the prompt says so,
   and nothing a note contains can grant a tool.
5. **A strict Content-Security-Policy**, no cookies (so no CSRF), ceilings on
   every request body, a turn limit per device, and a log that is written
   before the reply is spoken.

## Setting it up

You need Node 22 and a model runner. Ollama is the easy one.

```sh
# 1. The model (any OpenAI-compatible server with tool calling works)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b          # 7B holds a tool list well; 3b is quicker, 14b is better

# 2. This
cd ~/codes/ontoplano/ontoplano-chat
make setup                      # installs, builds, writes ~/.config/ontoplano-chat/config.toml
```

Then put an **API token** in the config: in the app, _Settings → AI &
Integrations_, make a token with the scopes you want the assistant to have —
reading the plan and tasks, adding tasks, ticking habits. `ontoplano-chat
doctor` says how many tools that token grants and how many are offered.

### Ears

Speech-to-text runs on the computer. Two servers are known, both local:

- **[Speaches](https://github.com/speaches-ai/speaches)** — faster-whisper
  behind an OpenAI-compatible API. `docker run -p 8000:8000
ghcr.io/speaches-ai/speaches:latest-cpu` and the defaults match
  (`stt.kind = "openai"`, port 8000, `Systran/faster-whisper-small`).
- **whisper.cpp's server** — `stt.kind = "whispercpp"`, pointing at its port.

Without either, tick _Recognise speech on this phone_ in the settings sheet:
the browser's own recogniser is used. On Android that goes through Google,
which is the one thing this project exists to avoid — it is a fallback.

### Voice

By default the phone speaks (`tts.kind = "browser"`): zero setup, and on
Android the voice is on-device. For a better one on the computer:
`tts.kind = "piper"` with a [piper](https://github.com/rhasspy/piper) binary
and a voice file, or `tts.kind = "openai"` against Speaches or Kokoro.

### Reaching it from the phone

The server listens on `127.0.0.1:1497`. Pick one:

- **Tailscale** (recommended): both devices on your tailnet, then on the
  computer `tailscale serve --bg 1497`. That gives the phone an https name
  with a real certificate and opens no port to the internet. Put the name in
  `server.public_url` so the pairing code prints it.
- **A TLS proxy you already run** (Caddy, nginx) on a name that resolves to
  the computer: proxy to `127.0.0.1:1497`.
- **Its own certificate**: `[server.tls]` with a cert and key the phone
  trusts (`mkcert` on a LAN, or Let's Encrypt), and `host = "0.0.0.0"`.

### Pairing

```sh
ontoplano-chat pair     # prints a six-digit code and the address to open
```

Open the address on the phone, type the code, name the phone. Done. The
server reads the code from its data directory; it need not be restarted.

### Running it for good

```sh
make install-service    # a systemd user unit; `make logs` follows it
loginctl enable-linger $USER
```

## The command

```
ontoplano-chat serve      run the server
ontoplano-chat pair       print a pairing code (ten minutes, one use)
ontoplano-chat devices    the paired phones
ontoplano-chat revoke <name>
ontoplano-chat doctor     check the model, the ears, the voice and the app
ontoplano-chat config     write the config file if there is none
```

`make demo` runs it with fake engines — no model, no ears, no app — so the
page can be looked at and the flow walked through on any machine.

## Config

`~/.config/ontoplano-chat/config.toml`; `ontoplano-chat config` writes a
commented one. The sections: `[server]` (host, port, `public_url`, `[server.tls]`),
`[ontoplano]` (url, token — or `ONTOPLANO_MCP_TOKEN`), `[llm]` (url, model),
`[stt]`, `[tts]`, `[assistant]` (name, language, `tools`, `confirm`,
`history_turns`). Data lives in `~/.local/share/ontoplano-chat/`:
`devices.json` (hashes), `pairing.json` (a hashed code, briefly),
`turns.jsonl` (the log).

## Developing

```sh
make test     # vitest, then Playwright at phone and desktop width with fake engines
make lint     # prettier, eslint, tsc
```

See `AGENTS.md` for how the code is laid out and what a change owes.
