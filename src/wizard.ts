/*
 * `ontoplano-chat setup`: the questions, in order, and the config they
 * become.
 *
 *   1. the app and its token — checked by listing the tools it grants
 *   2. the model — on this computer, or a company's API — checked
 *   3. the ears, 4. the voice
 *   5. the name and the language
 *   6. how the phone reaches this computer
 *
 * The answers are a plain object; `renderConfig` turns them into the TOML
 * file. The questions and the checks are separate from the terminal, so the
 * whole thing runs in a test with scripted answers and fake checks.
 */
import type { Ask } from './ask.js';
import {
	DEFAULT_PORT,
	EARS,
	OLLAMA_INSTALL,
	OPENAI_STT_MODEL,
	OPENAI_TTS_MODEL,
	OPENAI_TTS_VOICE,
	PROVIDERS,
	SPEACHES_RUN,
	SPEACHES_TTS_MODEL,
	SPEACHES_TTS_VOICE,
	SPEACHES_URL,
	VOICES,
	type Provider
} from './constants.js';

export type Choices = {
	appUrl: string;
	token: string;
	provider: string;
	llm: { url: string; model: string; apiKey: string };
	stt: { kind: 'openai' | 'whispercpp' | 'browser'; url: string; model: string; language: string; apiKey: string };
	tts: {
		kind: 'openai' | 'piper' | 'browser';
		url: string;
		model: string;
		voice: string;
		apiKey: string;
		piperModel: string;
	};
	name: string;
	language: string;
	reach: 'tailscale' | 'proxy' | 'tls' | 'loopback';
	publicUrl: string;
	host: string;
	port: number;
	tls: { cert: string; key: string };
};

/** What the wizard asks the world. Every one is replaceable in a test. */
export type Checks = {
	/** How many tools the token grants, or a problem. */
	app(url: string, token: string): Promise<{ tools: number } | { problem: string }>;
	/** Is the model reachable: null, or a problem. */
	llm(url: string, model: string, apiKey: string): Promise<string | null>;
	/** Is a command on the PATH. */
	has(command: string): boolean;
	/** Run a shell line with the terminal attached; answers whether it succeeded. */
	run(line: string): Promise<boolean>;
	/** This machine's tailnet https name, if Tailscale is up. */
	tailscaleName(): Promise<string | null>;
	/** What the config says now, for defaults. */
	current: Partial<Choices>;
};

const quote = (s: string): string => JSON.stringify(s);

/** The config file these answers describe. */
export function renderConfig(c: Choices): string {
	return `# ontoplano-chat — written by \`ontoplano-chat setup\`. Edit freely; \`ontoplano-chat config\`
# prints a commented example of every key.

[server]
host = ${quote(c.host)}
port = ${c.port}
public_url = ${quote(c.publicUrl)}
insecure = ${c.reach === 'proxy' && c.host !== '127.0.0.1' ? 'true' : 'false'}

[server.tls]
cert = ${quote(c.tls.cert)}
key = ${quote(c.tls.key)}

[ontoplano]
url = ${quote(c.appUrl)}
token = ${quote(c.token)}

[llm]
# ${PROVIDERS.find((p) => p.key === c.provider)?.name ?? c.provider}
url = ${quote(c.llm.url)}
model = ${quote(c.llm.model)}
api_key = ${quote(c.llm.apiKey)}

[stt]
kind = ${quote(c.stt.kind)}
url = ${quote(c.stt.url)}
model = ${quote(c.stt.model)}
language = ${quote(c.stt.language)}
api_key = ${quote(c.stt.apiKey)}

[tts]
kind = ${quote(c.tts.kind)}
url = ${quote(c.tts.url)}
model = ${quote(c.tts.model)}
voice = ${quote(c.tts.voice)}
api_key = ${quote(c.tts.apiKey)}
piper_model = ${quote(c.tts.piperModel)}

[assistant]
name = ${quote(c.name)}
language = ${quote(c.language)}
`;
}

const sttLanguage = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? 'en';

export async function runWizard(ask: Ask, checks: Checks): Promise<Choices> {
	const cur = checks.current;
	ask.say();
	ask.say('ontoplano-chat setup — six questions, then a pairing code.');
	ask.say();

	// 1. the app
	ask.say('1. The app');
	const appUrl = (await ask.text('Where is your ontoplano?', cur.appUrl || 'https://app.ontoplano.com')).replace(
		/\/+$/,
		''
	);
	ask.say(
		'   An API token from the app: Settings → AI & Integrations → new token, with the scopes the assistant may use.'
	);
	let token: string;
	for (;;) {
		token = cur.token
			? (await ask.secret('   Token (enter keeps the current one):')) || cur.token
			: await ask.secret('   Token:');
		if (!token) {
			ask.say('   It needs one.');
			continue;
		}
		const r = await checks.app(appUrl, token);
		if ('tools' in r) {
			ask.say(`   ✓ the token grants ${r.tools} tools`);
			break;
		}
		ask.say(`   ✗ ${r.problem}`);
		if (!(await ask.yes('   Try another?', true))) break;
	}

	// 2. the model
	ask.say();
	ask.say('2. The model');
	const provider = await ask.choose(
		"   Where should it think? Local keeps everything on this computer; a company's API sends what you say to them.",
		PROVIDERS.map((p) => ({ key: p.key, label: p.name + (p.local ? '' : '  — cloud'), note: p.note || undefined })),
		cur.provider || 'ollama'
	);
	const p = PROVIDERS.find((x) => x.key === provider) as Provider;
	const llmUrl = (await ask.text('   Endpoint', cur.provider === provider ? cur.llm?.url || p.url : p.url)).replace(
		/\/+$/,
		''
	);
	const llmModel = await ask.text('   Model', cur.provider === provider ? cur.llm?.model || p.model : p.model);
	let llmKey = '';
	if (p.needsKey || provider === 'custom') {
		llmKey = cur.llm?.apiKey
			? (await ask.secret('   API key (enter keeps the current one):')) || cur.llm.apiKey
			: await ask.secret(p.needsKey ? '   API key:' : '   API key (enter for none):');
	}
	if (provider === 'ollama') {
		let problem = await checks.llm(llmUrl, llmModel, llmKey);
		if (problem && !checks.has('ollama')) {
			ask.say(`   ✗ ${problem}`);
			if (await ask.yes(`   Install Ollama now? (${OLLAMA_INSTALL})`, true)) {
				await checks.run(OLLAMA_INSTALL);
				problem = await checks.llm(llmUrl, llmModel, llmKey);
			}
		}
		if (problem && checks.has('ollama') && /not among/.test(problem)) {
			ask.say(`   ✗ ${problem}`);
			if (await ask.yes(`   Pull it now? (ollama pull ${llmModel})`, true)) {
				await checks.run(`ollama pull ${llmModel}`);
				problem = await checks.llm(llmUrl, llmModel, llmKey);
			}
		}
		ask.say(problem ? `   ✗ ${problem} — \`ontoplano-chat doctor\` checks again later` : '   ✓ the model answers');
	} else {
		const problem = await checks.llm(llmUrl, llmModel, llmKey);
		ask.say(problem ? `   ✗ ${problem} — \`ontoplano-chat doctor\` checks again later` : '   ✓ the model answers');
	}

	// 3. the ears
	ask.say();
	ask.say('3. The ears — turning what you say into words');
	const ears = await ask.choose(
		'   Where?',
		EARS.map((e) => ({ key: e.key, label: e.name + (e.local ? '' : '  — not local') })),
		cur.stt?.kind === 'whispercpp' ? 'whispercpp' : cur.stt?.kind === 'browser' ? 'browser' : 'speaches'
	);
	const stt: Choices['stt'] = {
		kind: 'openai',
		url: SPEACHES_URL,
		model: 'Systran/faster-whisper-small',
		language: 'pt',
		apiKey: ''
	};
	if (ears === 'speaches') {
		stt.url = await ask.text('   Speaches URL', cur.stt?.url || SPEACHES_URL);
		stt.model = await ask.text('   Whisper model', cur.stt?.model || stt.model);
		if (checks.has('docker') && (await ask.yes(`   Start the Speaches container now? (${SPEACHES_RUN})`, false)))
			await checks.run(SPEACHES_RUN);
	} else if (ears === 'whispercpp') {
		stt.kind = 'whispercpp';
		stt.url = await ask.text('   whisper.cpp server URL', cur.stt?.url || 'http://127.0.0.1:8080');
	} else if (ears === 'cloud') {
		stt.url = (await ask.text('   Endpoint', 'https://api.openai.com')).replace(/\/+$/, '');
		stt.model = await ask.text('   Model', OPENAI_STT_MODEL);
		stt.apiKey = await ask.secret('   API key:');
	} else {
		stt.kind = 'browser';
	}

	// 4. the voice
	ask.say();
	ask.say('4. The voice — reading the answers aloud');
	const voice = await ask.choose(
		'   Where?',
		VOICES.map((v) => ({ key: v.key, label: v.name + (v.local ? '' : '  — not local') })),
		cur.tts?.kind === 'piper' ? 'piper' : cur.tts?.kind === 'openai' ? 'speaches' : 'browser'
	);
	const tts: Choices['tts'] = { kind: 'browser', url: SPEACHES_URL, model: '', voice: '', apiKey: '', piperModel: '' };
	if (voice === 'piper') {
		tts.kind = 'piper';
		tts.piperModel = await ask.text(
			'   Voice file (.onnx)',
			cur.tts?.piperModel || '~/.local/share/piper/pt_BR-faber-medium.onnx'
		);
		if (!checks.has('piper')) ask.say('   (piper is not on the PATH yet — https://github.com/rhasspy/piper)');
	} else if (voice === 'speaches') {
		tts.kind = 'openai';
		tts.url = await ask.text(
			'   Speaches URL',
			stt.url.startsWith('http') && ears === 'speaches' ? stt.url : SPEACHES_URL
		);
		tts.model = await ask.text('   Model', SPEACHES_TTS_MODEL);
		tts.voice = await ask.text('   Voice', SPEACHES_TTS_VOICE);
	} else if (voice === 'cloud') {
		tts.kind = 'openai';
		tts.url = (await ask.text('   Endpoint', 'https://api.openai.com')).replace(/\/+$/, '');
		tts.model = await ask.text('   Model', OPENAI_TTS_MODEL);
		tts.voice = await ask.text('   Voice', OPENAI_TTS_VOICE);
		tts.apiKey = stt.apiKey && stt.url === tts.url ? stt.apiKey : await ask.secret('   API key:');
	}

	// 5. the name and the language
	ask.say();
	ask.say('5. The assistant');
	const name = await ask.text('   Its name', cur.name || 'Onto');
	const language = await ask.text('   The language it answers in (a tag: pt-BR, en, es…)', cur.language || 'pt-BR');
	stt.language = sttLanguage(language);

	// 6. reaching it
	ask.say();
	ask.say('6. Reaching it from the phone');
	ask.say('   The microphone only opens on https, so the phone needs an https address for this computer.');
	const tailscale = checks.has('tailscale') ? await checks.tailscaleName() : null;
	const reach = await ask.choose(
		'   How?',
		[
			{
				key: 'tailscale',
				label:
					'Tailscale' +
					(tailscale
						? ` — this computer is ${tailscale}`
						: checks.has('tailscale')
							? ' (installed; not up?)'
							: ' (not installed — https://tailscale.com/download)'),
				note: 'Both devices on your tailnet; `tailscale serve` gives an https name and opens no port to the internet.'
			},
			{
				key: 'proxy',
				label: 'A TLS proxy I run myself (Caddy, nginx) in front of 127.0.0.1',
				note: 'You give the https address the proxy answers on.'
			},
			{
				key: 'tls',
				label: "Its own certificate (mkcert on a LAN, Let's Encrypt)",
				note: 'Listens on every address with the cert and key you name.'
			},
			{
				key: 'loopback',
				label: 'Only this computer, for now',
				note: 'http://127.0.0.1 — the page works here; a phone cannot reach it yet.'
			}
		],
		cur.reach || (tailscale ? 'tailscale' : 'loopback')
	);
	const port = cur.port || DEFAULT_PORT;
	let publicUrl = '';
	let host = '127.0.0.1';
	const tls = { cert: '', key: '' };
	if (reach === 'tailscale') {
		publicUrl = tailscale
			? `https://${tailscale}`
			: await ask.text('   The https name Tailscale gives this computer', cur.publicUrl || '');
		if (checks.has('tailscale') && (await ask.yes(`   Run \`tailscale serve --bg ${port}\` now?`, true)))
			await checks.run(`tailscale serve --bg ${port}`);
	} else if (reach === 'proxy') {
		publicUrl = (await ask.text('   The https address the proxy answers on', cur.publicUrl || '')).replace(/\/+$/, '');
	} else if (reach === 'tls') {
		tls.cert = await ask.text('   Certificate file', cur.tls?.cert || '');
		tls.key = await ask.text('   Key file', cur.tls?.key || '');
		host = '0.0.0.0';
		publicUrl = (await ask.text('   The https address the phone opens', cur.publicUrl || '')).replace(/\/+$/, '');
	}

	return {
		appUrl,
		token,
		provider,
		llm: { url: llmUrl, model: llmModel, apiKey: llmKey },
		stt,
		tts,
		name,
		language,
		reach: reach as Choices['reach'],
		publicUrl,
		host,
		port,
		tls
	};
}
