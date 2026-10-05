/*
 * Every number and name the server is made of, in one place.
 *
 * Nothing below is a secret and nothing is a per-machine value — those live
 * in the config file (`config.ts`). These are the shape of the thing: how long
 * a pairing code lives, how much audio one turn may carry, which port is the
 * default. Change them here, never inline.
 */

/** The port the server listens on when the config says nothing. 1493 is the app, 1494 the docs, 1495–1496 the site. */
export const DEFAULT_PORT = 1497;

/** Where the server listens when the config says nothing: loopback, for a proxy or `tailscale serve` to front. */
export const DEFAULT_HOST = '127.0.0.1';

/** Where the config file is read from, under `$HOME`. */
export const CONFIG_RELATIVE = '.config/ontoplano-chat/config.toml';

/** Where the server keeps what it must remember, under `$HOME`: devices, pairing, the log. */
export const DATA_RELATIVE = '.local/share/ontoplano-chat';

/** The path the app answers MCP on, appended to `ontoplano.url`. */
export const MCP_PATH = '/api/mcp';

/** The MCP protocol version this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-03-26';

/** How this client introduces itself to the app. */
export const MCP_CLIENT_INFO = { name: 'ontoplano-chat', version: '0.1.7' };

/** A pairing code is this many digits. */
export const PAIRING_CODE_DIGITS = 6;

/** A pairing code lives this long, in milliseconds. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** A pairing code burns after this many wrong guesses. */
export const PAIRING_MAX_ATTEMPTS = 5;

/** Pairing attempts allowed from one address inside `PAIRING_RATE_WINDOW_MS`. */
export const PAIRING_RATE_LIMIT = 10;
export const PAIRING_RATE_WINDOW_MS = 15 * 60 * 1000;

/** Turns one device may start inside `TURN_RATE_WINDOW_MS`. */
export const TURN_RATE_LIMIT = 30;
export const TURN_RATE_WINDOW_MS = 60 * 1000;

/** A device token is this many random bytes before encoding. */
export const DEVICE_TOKEN_BYTES = 32;

/** The most audio one turn may carry, in bytes. */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/** The most JSON one request may carry, in bytes. */
export const MAX_JSON_BYTES = 16 * 1024;

/** How long a conversation is remembered after its last turn, in milliseconds. */
export const CONVERSATION_IDLE_MS = 30 * 60 * 1000;

/** How long a pending "are you sure?" waits for its answer, in milliseconds. */
export const CONFIRMATION_TTL_MS = 3 * 60 * 1000;

/** How many characters of a tool's answer the model is shown. */
export const TOOL_RESULT_CHARS = 6000;

/** How many characters of a tool's description the model is shown, when the config says nothing. */
export const DEFAULT_TOOL_DESCRIPTION_CHARS = 320;

/** How many past turns are kept as context, when the config says nothing. */
export const DEFAULT_HISTORY_TURNS = 12;

/** How many tool rounds one turn may take before the model is made to answer, when the config says nothing. */
export const DEFAULT_MAX_TOOL_ROUNDS = 6;

/** How long one model call may take, in milliseconds, when the config says nothing. */
export const DEFAULT_LLM_TIMEOUT_MS = 120 * 1000;

/** How long one transcription or synthesis may take, in milliseconds. */
export const SPEECH_TIMEOUT_MS = 60 * 1000;

/** How often the tool list is re-read from the app, in milliseconds. */
export const TOOLS_REFRESH_MS = 60 * 60 * 1000;

/** The most entries `GET /api/history` answers with. */
export const HISTORY_PAGE = 50;

/** The tools a voice assistant is offered when the config says nothing: the everyday ones, which is what a small local model can hold. */
export const DEFAULT_TOOLS = [
	'today',
	'upcoming',
	'search',
	'tasks',
	'up_next',
	'add_task',
	'finish_task',
	'reopen_task',
	'change_task',
	'schedule_task',
	'unschedule_task',
	'tag_task',
	'notebooks',
	'notebook_notes',
	'write_entry',
	'diary',
	'add_idea',
	'ideas',
	'habits',
	'tick_habit',
	'shopping_list',
	'add_inventory_item',
	'tick_bought',
	'where_is',
	'reminders',
	'set_alarm',
	'remind_task',
	'add_block',
	'goals',
	'log_goal_progress',
	'daily_wins',
	'record_win',
	'bills_due',
	'upcoming_birthdays'
];

/** Tools that ask before they run, when the config says nothing: anything that removes, drops or cancels. */
export const DEFAULT_CONFIRM = ['remove_*', 'delete_*', 'drop_*', 'cancel_*', 'unpay_*', 'skip_*'];

/** The words that answer a pending confirmation by voice, per language. */
export const YES_WORDS: Record<string, string[]> = {
	en: ['yes', 'yeah', 'yep', 'sure', 'do it', 'confirm', 'go ahead', 'ok', 'okay'],
	pt: ['sim', 'pode', 'confirma', 'confirmo', 'isso', 'manda', 'ok', 'faz', 'vai']
};
export const NO_WORDS: Record<string, string[]> = {
	en: ['no', 'nope', 'cancel', 'stop', "don't", 'do not', 'never mind'],
	pt: ['não', 'nao', 'cancela', 'para', 'deixa', 'esquece']
};

/** A place a model can run: a local server, or a company's API behind an OpenAI-compatible endpoint. */
export type Provider = {
	key: string;
	name: string;
	url: string;
	model: string;
	/** Runs on this machine: what is said never leaves it. */
	local: boolean;
	needsKey: boolean;
	note: string;
};

/** The providers the setup wizard offers, local ones first. All speak OpenAI-style chat completions with tools. */
export const PROVIDERS: Provider[] = [
	{
		key: 'ollama',
		name: 'Ollama, on this computer',
		url: 'http://127.0.0.1:11434/v1',
		model: 'qwen2.5:7b',
		local: true,
		needsKey: false,
		note: 'Everything stays here. The 7b model wants about 5 GB of memory; qwen2.5:3b is lighter, qwen2.5:14b better.'
	},
	{
		key: 'local',
		name: 'Another server on this computer (llama.cpp, LM Studio, vLLM)',
		url: 'http://127.0.0.1:8080/v1',
		model: '',
		local: true,
		needsKey: false,
		note: 'Any OpenAI-compatible endpoint that does tool calling.'
	},
	{
		key: 'openai',
		name: 'OpenAI',
		url: 'https://api.openai.com/v1',
		model: 'gpt-4.1-mini',
		local: false,
		needsKey: true,
		note: ''
	},
	{
		key: 'anthropic',
		name: 'Anthropic (Claude)',
		url: 'https://api.anthropic.com/v1',
		model: 'claude-sonnet-5',
		local: false,
		needsKey: true,
		note: ''
	},
	{
		key: 'groq',
		name: 'Groq',
		url: 'https://api.groq.com/openai/v1',
		model: 'llama-3.3-70b-versatile',
		local: false,
		needsKey: true,
		note: ''
	},
	{
		key: 'mistral',
		name: 'Mistral',
		url: 'https://api.mistral.ai/v1',
		model: 'mistral-small-latest',
		local: false,
		needsKey: true,
		note: ''
	},
	{
		key: 'openrouter',
		name: 'OpenRouter',
		url: 'https://openrouter.ai/api/v1',
		model: 'openai/gpt-4.1-mini',
		local: false,
		needsKey: true,
		note: ''
	},
	{
		key: 'gemini',
		name: 'Google Gemini',
		url: 'https://generativelanguage.googleapis.com/v1beta/openai',
		model: 'gemini-2.5-flash',
		local: false,
		needsKey: true,
		note: ''
	},
	{ key: 'custom', name: 'A URL of my own', url: '', model: '', local: false, needsKey: false, note: '' }
];

/** Where the ears can be. */
export const EARS = [
	{ key: 'speaches', name: 'Speaches, on this computer (faster-whisper; a Docker container)', local: true },
	{ key: 'whispercpp', name: "whisper.cpp's server, already running here", local: true },
	{ key: 'cloud', name: 'A cloud transcriber (OpenAI whisper-1, or any OpenAI-compatible one)', local: false },
	{ key: 'browser', name: "The device's own recogniser (zero setup; on Android it goes through Google)", local: false }
] as const;

/** Where the voice can be. */
export const VOICES = [
	{ key: 'browser', name: "The device's own voice (zero setup; on-device on Android)", local: true },
	{ key: 'piper', name: 'piper, on this computer', local: true },
	{ key: 'speaches', name: 'Speaches on this computer (Kokoro or piper voices over HTTP)', local: true },
	{ key: 'cloud', name: 'A cloud voice (OpenAI, or any OpenAI-compatible one)', local: false }
] as const;

/** How to install Ollama, and the Speaches container, when the wizard is asked to. */
export const OLLAMA_INSTALL = 'curl -fsSL https://ollama.com/install.sh | sh';
export const SPEACHES_RUN =
	'docker run -d --name speaches --restart unless-stopped -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu';
export const SPEACHES_URL = 'http://127.0.0.1:8000';
export const OPENAI_STT_MODEL = 'whisper-1';
export const OPENAI_TTS_MODEL = 'tts-1';
export const OPENAI_TTS_VOICE = 'alloy';
export const SPEACHES_TTS_MODEL = 'speaches-ai/Kokoro-82M-v1.0-ONNX';
export const SPEACHES_TTS_VOICE = 'af_heart';
