/*
 * The config file: `~/.config/ontoplano-chat/config.toml`, read once at start.
 *
 * Everything per machine is here — where the model runs, which voice speaks,
 * the app's token — and nothing else is. Defaults are in `constants.ts`; this
 * file merges what the TOML says over them, lets the environment override the
 * secret, and refuses the one arrangement that is never right: listening on a
 * network address without TLS.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import {
	CONFIG_RELATIVE,
	DATA_RELATIVE,
	DEFAULT_CONFIRM,
	DEFAULT_HISTORY_TURNS,
	DEFAULT_HOST,
	DEFAULT_LLM_TIMEOUT_MS,
	DEFAULT_MAX_TOOL_ROUNDS,
	DEFAULT_PORT,
	DEFAULT_TOOLS,
	DEFAULT_TOOL_DESCRIPTION_CHARS
} from './constants.js';

export type SttKind = 'openai' | 'whispercpp' | 'browser';
export type TtsKind = 'openai' | 'piper' | 'browser';

export type Config = {
	server: {
		host: string;
		port: number;
		/** What the phone opens — printed beside the pairing code. */
		publicUrl: string;
		/** Listen on a network address without TLS anyway. Only ever for a trusted proxy on the same machine. */
		insecure: boolean;
		tls: { cert: string; key: string };
	};
	ontoplano: { url: string; token: string };
	llm: {
		url: string;
		model: string;
		apiKey: string;
		temperature: number;
		maxToolRounds: number;
		timeoutMs: number;
		toolDescriptionChars: number;
	};
	stt: { kind: SttKind; url: string; path: string; model: string; language: string; apiKey: string; prompt: string };
	tts: {
		kind: TtsKind;
		url: string;
		model: string;
		voice: string;
		/** Which of a language's voices to use when the voice follows the language spoken. */
		gender: 'male' | 'female';
		apiKey: string;
		piperCommand: string;
		piperModel: string;
	};
	assistant: {
		name: string;
		language: string;
		tools: string[];
		confirm: string[];
		historyTurns: number;
	};
	dataDir: string;
	configPath: string;
};

export class ConfigError extends Error {}

/** Where the config file is: the environment's say, or the usual place. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return expandHome(env.ONTOPLANO_CHAT_CONFIG ?? join(homedir(), CONFIG_RELATIVE));
}

/** Where the data lives: the environment's say, or the usual place. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
	return expandHome(env.ONTOPLANO_CHAT_DATA ?? join(homedir(), DATA_RELATIVE));
}

/**
 * An address as somebody types it: `127.0.0.1:7749` means http://127.0.0.1:7749,
 * and a trailing slash is noise. Every URL the config or the wizard takes
 * goes through here, so a port typed bare is not a server that cannot be
 * reached.
 */
export function normalizeUrl(raw: string): string {
	const t = raw.trim().replace(/\/+$/, '');
	if (!t) return '';
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
}

/** Null when the address parses, else what is wrong with it. */
export function urlProblem(url: string): string | null {
	try {
		new URL(url);
		return null;
	} catch {
		return `"${url}" is not an address`;
	}
}

export function expandHome(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return join(homedir(), p.slice(2));
	return p;
}

export function defaults(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		server: {
			host: DEFAULT_HOST,
			port: DEFAULT_PORT,
			publicUrl: '',
			insecure: false,
			tls: { cert: '', key: '' }
		},
		ontoplano: { url: 'https://app.ontoplano.com', token: '' },
		llm: {
			url: 'http://127.0.0.1:11434/v1',
			model: 'qwen2.5:7b',
			apiKey: '',
			temperature: 0.2,
			maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
			timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
			toolDescriptionChars: DEFAULT_TOOL_DESCRIPTION_CHARS
		},
		stt: {
			kind: 'openai',
			url: 'http://127.0.0.1:8000',
			path: '/v1/audio/transcriptions',
			model: 'Systran/faster-whisper-small',
			language: 'pt',
			apiKey: '',
			prompt: ''
		},
		tts: {
			kind: 'browser',
			url: 'http://127.0.0.1:8000',
			model: 'speaches-ai/piper-pt_BR-faber-medium',
			voice: 'pt_BR-faber-medium',
			gender: 'male',
			apiKey: '',
			piperCommand: 'piper',
			piperModel: '~/.local/share/piper/pt_BR-faber-medium.onnx'
		},
		assistant: {
			name: 'Onto',
			language: 'pt-BR',
			// The everyday ones first, then everything else the token grants: the token
			// is the fence the person chose, and a key confined to one notebook grants
			// a different set than the everyday list names.
			tools: [...DEFAULT_TOOLS, '*'],
			confirm: [...DEFAULT_CONFIRM],
			historyTurns: DEFAULT_HISTORY_TURNS
		},
		dataDir: dataDir(env),
		configPath: configPath(env)
	};
}

type Toml = Record<string, unknown>;
const section = (t: Toml, k: string): Toml => (isRecord(t[k]) ? (t[k] as Toml) : {});
const isRecord = (v: unknown): v is Toml => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (t: Toml, k: string, d: string): string => (typeof t[k] === 'string' ? (t[k] as string) : d);
const num = (t: Toml, k: string, d: number): number =>
	typeof t[k] === 'number' && Number.isFinite(t[k]) ? (t[k] as number) : d;
const bool = (t: Toml, k: string, d: boolean): boolean => (typeof t[k] === 'boolean' ? (t[k] as boolean) : d);
const strs = (t: Toml, k: string, d: string[]): string[] =>
	Array.isArray(t[k]) && (t[k] as unknown[]).every((x) => typeof x === 'string') ? (t[k] as string[]) : d;

/** The config the TOML describes, laid over the defaults. Pure: give it the text. */
export function fromToml(text: string, env: NodeJS.ProcessEnv = process.env): Config {
	const d = defaults(env);
	let t: Toml;
	try {
		t = parseToml(text) as Toml;
	} catch (e) {
		throw new ConfigError(`config is not valid TOML: ${(e as Error).message}`);
	}
	const server = section(t, 'server');
	const tls = section(server, 'tls');
	const onto = section(t, 'ontoplano');
	const llm = section(t, 'llm');
	const stt = section(t, 'stt');
	const tts = section(t, 'tts');
	const assistant = section(t, 'assistant');
	const sttKind = str(stt, 'kind', d.stt.kind);
	const ttsKind = str(tts, 'kind', d.tts.kind);
	if (!['openai', 'whispercpp', 'browser'].includes(sttKind))
		throw new ConfigError(`stt.kind must be openai, whispercpp or browser, not "${sttKind}"`);
	if (!['openai', 'piper', 'browser'].includes(ttsKind))
		throw new ConfigError(`tts.kind must be openai, piper or browser, not "${ttsKind}"`);
	return {
		server: {
			host: str(server, 'host', d.server.host),
			port: num(server, 'port', d.server.port),
			publicUrl: normalizeUrl(str(server, 'public_url', d.server.publicUrl)),
			insecure: bool(server, 'insecure', d.server.insecure),
			tls: { cert: expandHome(str(tls, 'cert', '')), key: expandHome(str(tls, 'key', '')) }
		},
		ontoplano: {
			url: normalizeUrl(str(onto, 'url', d.ontoplano.url)),
			token: env.ONTOPLANO_MCP_TOKEN ?? str(onto, 'token', '')
		},
		llm: {
			url: normalizeUrl(str(llm, 'url', d.llm.url)),
			model: str(llm, 'model', d.llm.model),
			apiKey: env.ONTOPLANO_CHAT_LLM_KEY ?? str(llm, 'api_key', ''),
			temperature: num(llm, 'temperature', d.llm.temperature),
			maxToolRounds: num(llm, 'max_tool_rounds', d.llm.maxToolRounds),
			timeoutMs: num(llm, 'timeout_ms', d.llm.timeoutMs),
			toolDescriptionChars: num(llm, 'tool_description_chars', d.llm.toolDescriptionChars)
		},
		stt: {
			kind: sttKind as SttKind,
			url: normalizeUrl(str(stt, 'url', d.stt.url)),
			path: str(stt, 'path', sttKind === 'whispercpp' ? '/inference' : d.stt.path),
			model: str(stt, 'model', d.stt.model),
			language: str(stt, 'language', d.stt.language),
			apiKey: env.ONTOPLANO_CHAT_STT_KEY ?? str(stt, 'api_key', ''),
			prompt: str(stt, 'prompt', '')
		},
		tts: {
			kind: ttsKind as TtsKind,
			url: normalizeUrl(str(tts, 'url', d.tts.url)),
			model: str(tts, 'model', d.tts.model),
			voice: str(tts, 'voice', d.tts.voice),
			gender: str(tts, 'gender', d.tts.gender) === 'female' ? 'female' : 'male',
			apiKey: env.ONTOPLANO_CHAT_TTS_KEY ?? str(tts, 'api_key', ''),
			piperCommand: expandHome(str(tts, 'piper_command', d.tts.piperCommand)),
			piperModel: expandHome(str(tts, 'piper_model', d.tts.piperModel))
		},
		assistant: {
			name: str(assistant, 'name', d.assistant.name),
			language: str(assistant, 'language', d.assistant.language),
			tools: strs(assistant, 'tools', d.assistant.tools),
			confirm: strs(assistant, 'confirm', d.assistant.confirm),
			historyTurns: num(assistant, 'history_turns', d.assistant.historyTurns)
		},
		dataDir: dataDir(env),
		configPath: configPath(env)
	};
}

/** The config from disk — or the defaults, when there is no file yet. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const path = configPath(env);
	const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
	return fromToml(text, env);
}

/**
 * What must be true before the server listens.
 *
 * The one refusal: a network address without TLS. The phone's microphone only
 * opens on a secure origin, and a device token on plain HTTP is a token on the
 * wire; `insecure = true` exists for a TLS proxy on the same machine and says
 * so by name.
 */
export function checkForServing(c: Config): string[] {
	const problems: string[] = [];
	const hasTls = Boolean(c.server.tls.cert && c.server.tls.key);
	if (hasTls) {
		if (!existsSync(c.server.tls.cert)) problems.push(`server.tls.cert: no file at ${c.server.tls.cert}`);
		if (!existsSync(c.server.tls.key)) problems.push(`server.tls.key: no file at ${c.server.tls.key}`);
	} else if (!isLoopback(c.server.host) && !c.server.insecure) {
		problems.push(
			`server.host is ${c.server.host} and there is no TLS: the phone would send its token in the clear and its microphone would not open. ` +
				'Keep host = "127.0.0.1" behind `tailscale serve` or a TLS proxy, give [server.tls] a cert and key, or say insecure = true on purpose.'
		);
	}
	if (!c.ontoplano.token)
		problems.push(
			'ontoplano.token is empty: make an API token in the app (Settings → AI & Integrations) and put it here or in ONTOPLANO_MCP_TOKEN'
		);
	if (c.server.port < 1 || c.server.port > 65535) problems.push(`server.port ${c.server.port} is not a port`);
	for (const [name, url] of [
		['ontoplano.url', c.ontoplano.url],
		['llm.url', c.llm.url],
		['stt.url', c.stt.kind === 'browser' ? '' : c.stt.url],
		['tts.url', c.tts.kind === 'openai' ? c.tts.url : ''],
		['server.public_url', c.server.publicUrl]
	] as const) {
		const problem = url && urlProblem(url);
		if (problem) problems.push(`${name}: ${problem}`);
	}
	if (!isAbsolute(c.dataDir)) problems.push(`data directory ${c.dataDir} is not an absolute path`);
	return problems;
}

export function isLoopback(host: string): boolean {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** The config file as it should be written the first time: every key, explained. */
export function exampleConfig(): string {
	return `# ontoplano-chat — the local voice assistant.
#
# Everything about THIS machine is here. Defaults are what the comments say;
# a line left out keeps its default. The one secret is ontoplano.token, which
# may also come from the ONTOPLANO_MCP_TOKEN environment variable.

[server]
# Listen on loopback and let \`tailscale serve\` or a TLS proxy front it (the
# usual arrangement), or give [server.tls] a certificate and open the host.
host = "${DEFAULT_HOST}"
port = ${DEFAULT_PORT}
# What the phone opens. Printed beside the pairing code.
public_url = ""
# insecure = true lets a network address listen without TLS. Only for a TLS
# proxy on this same machine; the phone cannot use a plain-HTTP origin anyway.
insecure = false

[server.tls]
# A certificate the phone trusts. \`tailscale cert <name>\` writes one; so does
# a Let's Encrypt client; mkcert does for a LAN.
cert = ""
key = ""

[ontoplano]
url = "https://app.ontoplano.com"
# An API token from Settings → AI & Integrations, with the scopes the
# assistant may use. It never leaves this machine.
token = ""

[llm]
# Any OpenAI-compatible chat endpoint with tool calling: Ollama, llama.cpp's
# server, LM Studio, vLLM. Ollama is the default.
url = "http://127.0.0.1:11434/v1"
model = "qwen2.5:7b"
api_key = ""
temperature = 0.2
max_tool_rounds = ${DEFAULT_MAX_TOOL_ROUNDS}
timeout_ms = ${DEFAULT_LLM_TIMEOUT_MS}
# How much of each tool's description the model reads. Shorter is faster.
tool_description_chars = ${DEFAULT_TOOL_DESCRIPTION_CHARS}

[stt]
# "openai": an OpenAI-compatible /v1/audio/transcriptions — Speaches or LocalAI
#           on this machine, or a cloud one with an api_key.
# "whispercpp": whisper.cpp's own server (/inference).
# "browser": the phone's own recogniser — zero setup, but on Android it goes
# through Google, which is the one thing this project exists to avoid.
kind = "openai"
url = "http://127.0.0.1:8000"
model = "Systran/faster-whisper-small"
# "auto" lets whisper detect the language you speak, each turn; the answer and
# the voice follow it.
language = "pt"
# Only a cloud transcriber wants one.
api_key = ""
# Words the recogniser should expect. Empty means the app's and the assistant's names.
prompt = ""

[tts]
# "browser": the phone's own voices — zero setup, on-device on Android.
# "openai": an OpenAI-compatible /v1/audio/speech (Speaches, Kokoro).
# "piper": the piper binary on this machine, one voice file.
kind = "browser"
url = "http://127.0.0.1:8000"
model = "speaches-ai/piper-pt_BR-faber-medium"
voice = "pt_BR-faber-medium"
# male or female, when the voice follows the language spoken.
gender = "male"
api_key = ""
piper_command = "piper"
piper_model = "~/.local/share/piper/pt_BR-faber-medium.onnx"

[assistant]
name = "Onto"
# The language it answers in and the phone's interface language.
language = "pt-BR"
# Which of the app's tools the model is offered. A small local model holds a
# few dozen well; the app has two hundred. ["*"] offers every tool the token
# grants; the default is the everyday ones first and then "*", everything
# else the token grants. A name may carry a * wildcard.
tools = ${JSON.stringify([...DEFAULT_TOOLS, '*'], null, 2)}
# Tools that ask "are you sure?" before running.
confirm = ${JSON.stringify(DEFAULT_CONFIRM)}
# How many past turns the model is reminded of.
history_turns = ${DEFAULT_HISTORY_TURNS}
`;
}
