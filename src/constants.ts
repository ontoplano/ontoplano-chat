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
export const MCP_CLIENT_INFO = { name: 'ontoplano-chat', version: '0.1.0' };

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
