# ontoplano-chat

A local voice assistant for [Ontoplano](https://app.ontoplano.com). Speak or type a request; the assistant uses Ontoplano's MCP tools, shows each action, and asks before destructive changes. It runs as a small web app on your phone or computer.

## At a glance

- **Local first:** Ollama, speech recognition, and speech synthesis can run on your own computer. OpenAI-compatible hosted models are optional.
- **Scoped access:** the Ontoplano token controls what the assistant may do. The server offers only relevant granted tools to the model for each request.
- **Visible actions:** replies include links to the records changed in Ontoplano; the journal records model rounds and tool results.
- **Voice on your terms:** use the speaker button to mute replies. Browser and local voice options are available.
- **Optional traces:** Langfuse records model and MCP spans when configured. Evaluations use synthetic Ontoplano data.

```text
Browser or phone  →  ontoplano-chat  →  Ollama or another model
                         │             →  speech service (optional)
                         └────────────→  Ontoplano MCP (token scoped)
```

## Start from a checkout

Requires Node 22+ and Yarn. On Linux, `ontoplano-chat setup` can bring up Ollama and Speaches and can install a systemd user service.

```sh
make build
ontoplano-chat setup
ontoplano-chat serve           # foreground; Ctrl-C stops it
```

For the user service, run `ontoplano-chat install-service`; stop either a new foreground server or the service with `ontoplano-chat stop`. Check connections with `ontoplano-chat doctor`.

## Start with Docker Compose

```sh
cp compose.config.toml.example compose.config.toml
# Edit compose.config.toml: set the Ontoplano URL and token; add Langfuse keys if wanted.
make compose-up
make compose-pair              # prints a code for the browser
make compose-logs
```

Compose runs Chat, Ollama, and Speaches. It mounts your ignored config as a secret, keeps model and pairing data in named volumes, and publishes the browser only on `127.0.0.1:1497`. Run `make compose-down` to stop it. Stop a native service before starting Compose on the same port. The sample config uses the device's Portuguese voice; you can choose another in the config. See [Compose setup and host connectivity](docs/guide.md#docker-compose).

## Develop and evaluate

```sh
make test                     # unit and browser tests, with fake app data
make lint
make eval                     # real model, synthetic Ontoplano tools
```

`make eval` never contacts your Ontoplano account. `ontoplano-chat langfuse-check` verifies the Langfuse URL and keys; `ontoplano-chat langfuse-trace-test` sends and verifies a synthetic trace. See the [guide](docs/guide.md) for installation, configuration, voices, service and Compose operation, Langfuse, security, and evaluation details.
