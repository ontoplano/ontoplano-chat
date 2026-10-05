/*
 * `ontoplano-chat setup`: the questions, in order, and the config they
 * become.
 *
 *   1. the app and its token — checked by listing the tools it grants
 *   2. the model — on this computer, or a company's API — checked
 *   3. the ears, 4. the voice
 *   5. the name and the language
 *   6. how a device reaches this computer
 *
 * Each is a step, and `setup <step>` runs one of them alone over what the
 * config already says — changing a port is one question, not six. The
 * answers are a plain object; `renderConfig` turns them into the TOML file.
 * The questions and the checks are separate from the terminal, so the whole
 * thing runs in a test with scripted answers and fake checks.
 */
import type { Ask } from './ask.js';
import { normalizeUrl } from './config.js';
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

/** The six questions, by name — what `setup <step>` takes. */
export const STEPS = ['app', 'model', 'ears', 'voice', 'assistant', 'reach'] as const;
export type Step = (typeof STEPS)[number];

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
	/** Is a speech server there with that model: null, or a problem. */
	speech(url: string, model: string, apiKey: string): Promise<string | null>;
	/** Ask a speech server to download a model: null when it did. */
	pull(url: string, model: string, apiKey: string): Promise<string | null>;
	/** What the config says now, for defaults — and for the steps not asked. */
	current: Partial<Choices>;
};

const quote = (s: string): string => JSON.stringify(s);

/** The config file these answers describe. */
export function renderConfig(c: Choices): string {
	return `# ontoplano-chat — written by \`ontoplano-chat setup\`. Edit freely; \`ontoplano-chat config\`
# prints a commented example of every key, and \`ontoplano-chat setup <step>\`
# (${STEPS.join(', ')}) asks one question again.

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

/** A speech server checked, and its model downloaded on request when it is the only thing missing. */
async function speechReady(ask: Ask, checks: Checks, url: string, model: string, apiKey: string): Promise<void> {
	let problem = await checks.speech(url, model, apiKey);
	if (problem && /not installed/.test(problem)) {
		ask.say(`   ✗ ${problem}`);
		if (await ask.yes('   Download it now? (a few hundred MB; a minute or two)', true)) {
			const pulled = await checks.pull(url, model, apiKey);
			problem = pulled ?? (await checks.speech(url, model, apiKey));
		}
	}
	ask.say(
		problem ? `   ✗ ${problem} — \`ontoplano-chat doctor\` checks again later` : `   ✓ ${model} answers at ${url}`
	);
}

/** What the config says, with a default for anything it does not: the ground every step writes over. */
function baseChoices(cur: Partial<Choices>): Choices {
	return {
		appUrl: cur.appUrl || 'https://app.ontoplano.com',
		token: cur.token || '',
		provider: cur.provider || 'ollama',
		// Copies, not the config's own objects: a step writes over them while the
		// config's answers are still the defaults of the questions after it.
		llm: cur.llm ? { ...cur.llm } : { url: PROVIDERS[0]!.url, model: PROVIDERS[0]!.model, apiKey: '' },
		stt: cur.stt
			? { ...cur.stt }
			: {
					kind: 'openai',
					url: SPEACHES_URL,
					model: 'Systran/faster-whisper-small',
					language: 'pt',
					apiKey: ''
				},
		tts: cur.tts
			? { ...cur.tts }
			: { kind: 'browser', url: SPEACHES_URL, model: '', voice: '', apiKey: '', piperModel: '' },
		name: cur.name || 'Onto',
		language: cur.language || 'pt-BR',
		reach: cur.reach ?? 'loopback',
		publicUrl: cur.publicUrl || '',
		host: cur.host || '127.0.0.1',
		port: cur.port || DEFAULT_PORT,
		tls: cur.tls ? { ...cur.tls } : { cert: '', key: '' }
	};
}

export async function runWizard(ask: Ask, checks: Checks, only?: Step): Promise<Choices> {
	const cur = checks.current;
	const c = baseChoices(cur);
	// One step alone needs a config to stand on; without one, it is all six.
	const steps: readonly Step[] = only && Object.keys(cur).length ? [only] : STEPS;
	const number = (step: Step): string => (steps.length === 1 ? '' : `${STEPS.indexOf(step) + 1}. `);
	ask.say();
	ask.say(
		steps.length === 1
			? `ontoplano-chat setup — ${only}.`
			: 'ontoplano-chat setup — six questions, then a pairing code.'
	);
	ask.say();

	for (const step of steps) {
		if (step === 'app') await stepApp(ask, checks, c, number(step));
		else if (step === 'model') await stepModel(ask, checks, c, number(step));
		else if (step === 'ears') await stepEars(ask, checks, c, number(step));
		else if (step === 'voice') await stepVoice(ask, checks, c, number(step));
		else if (step === 'assistant') await stepAssistant(ask, c, number(step));
		else await stepReach(ask, checks, c, number(step));
		if (steps.length > 1) ask.say();
	}
	return c;
}

async function stepApp(ask: Ask, checks: Checks, c: Choices, n: string): Promise<void> {
	const cur = checks.current;
	ask.say(`${n}The app`);
	c.appUrl = normalizeUrl(await ask.text('Where is your ontoplano?', c.appUrl));
	ask.say(
		'   An API token from the app: Settings → AI & Integrations → new token, with the scopes the assistant may use.'
	);
	for (;;) {
		const typed = await ask.secret(cur.token ? '   Token (enter keeps the current one):' : '   Token:');
		c.token = typed || cur.token || '';
		if (!c.token) {
			ask.say('   It needs one.');
			continue;
		}
		const r = await checks.app(c.appUrl, c.token);
		if ('tools' in r) {
			ask.say(`   ✓ the token grants ${r.tools} tools`);
			return;
		}
		ask.say(`   ✗ ${r.problem}`);
		if (!(await ask.yes('   Try another?', true))) return;
	}
}

async function stepModel(ask: Ask, checks: Checks, c: Choices, n: string): Promise<void> {
	const cur = checks.current;
	ask.say(`${n}The model`);
	c.provider = await ask.choose(
		"   Where should it think? Local keeps everything on this computer; a company's API sends what you say to them.",
		PROVIDERS.map((p) => ({ key: p.key, label: p.name + (p.local ? '' : '  — cloud'), note: p.note || undefined })),
		c.provider
	);
	const p = PROVIDERS.find((x) => x.key === c.provider) as Provider;
	const same = cur.provider === c.provider;
	c.llm.url = normalizeUrl(await ask.text('   Endpoint', (same && cur.llm?.url) || p.url));
	c.llm.model = await ask.text('   Model', (same && cur.llm?.model) || p.model);
	c.llm.apiKey = '';
	if (p.needsKey || c.provider === 'custom') {
		const kept = same ? cur.llm?.apiKey || '' : '';
		const typed = await ask.secret(
			kept ? '   API key (enter keeps the current one):' : p.needsKey ? '   API key:' : '   API key (enter for none):'
		);
		c.llm.apiKey = typed || kept;
	}
	let problem = await checks.llm(c.llm.url, c.llm.model, c.llm.apiKey);
	if (c.provider === 'ollama') {
		if (problem && !checks.has('ollama')) {
			ask.say(`   ✗ ${problem}`);
			if (await ask.yes(`   Install Ollama now? (${OLLAMA_INSTALL})`, true)) {
				await checks.run(OLLAMA_INSTALL);
				problem = await checks.llm(c.llm.url, c.llm.model, c.llm.apiKey);
			}
		}
		if (problem && checks.has('ollama') && /not among/.test(problem)) {
			ask.say(`   ✗ ${problem}`);
			if (await ask.yes(`   Pull it now? (ollama pull ${c.llm.model})`, true)) {
				await checks.run(`ollama pull ${c.llm.model}`);
				problem = await checks.llm(c.llm.url, c.llm.model, c.llm.apiKey);
			}
		}
	}
	ask.say(problem ? `   ✗ ${problem} — \`ontoplano-chat doctor\` checks again later` : '   ✓ the model answers');
}

/** The Speaches address already given to the other half, if it was. */
const speachesSoFar = (c: Choices, cur: Partial<Choices>): string => {
	if (c.stt.kind === 'openai' && !c.stt.apiKey && c.stt.url) return c.stt.url;
	if (cur.tts?.kind === 'openai' && !cur.tts.apiKey && cur.tts.url) return cur.tts.url;
	return SPEACHES_URL;
};

async function stepEars(ask: Ask, checks: Checks, c: Choices, n: string): Promise<void> {
	const cur = checks.current;
	ask.say(`${n}The ears — turning what you say into words`);
	const was =
		cur.stt?.kind === 'whispercpp'
			? 'whispercpp'
			: cur.stt?.kind === 'browser'
				? 'browser'
				: cur.stt?.apiKey
					? 'cloud'
					: 'speaches';
	const ears = await ask.choose(
		'   Where?',
		EARS.map((e) => ({ key: e.key, label: e.name + (e.local ? '' : '  — not local') })),
		was
	);
	const stt: Choices['stt'] = {
		kind: 'openai',
		url: SPEACHES_URL,
		model: 'Systran/faster-whisper-small',
		language: c.stt.language,
		apiKey: ''
	};
	if (ears === 'speaches') {
		const remembered = was === 'speaches' && cur.stt?.url ? cur.stt.url : speachesSoFar(c, cur);
		stt.url = normalizeUrl(await ask.text('   Speaches URL', remembered));
		stt.model = await ask.text('   Whisper model', (was === 'speaches' && cur.stt?.model) || stt.model);
		if (checks.has('docker') && (await ask.yes(`   Start the Speaches container now? (${SPEACHES_RUN})`, false)))
			await checks.run(SPEACHES_RUN);
		await speechReady(ask, checks, stt.url, stt.model, '');
	} else if (ears === 'whispercpp') {
		stt.kind = 'whispercpp';
		stt.url = (
			await ask.text('   whisper.cpp server URL', (was === 'whispercpp' && cur.stt?.url) || 'http://127.0.0.1:8080')
		).replace(/\/+$/, '');
	} else if (ears === 'cloud') {
		stt.url = normalizeUrl(
			await ask.text('   Endpoint', (was === 'cloud' && cur.stt?.url) || 'https://api.openai.com')
		).replace(/\/+$/, '');
		stt.model = await ask.text('   Model', (was === 'cloud' && cur.stt?.model) || OPENAI_STT_MODEL);
		const kept = was === 'cloud' ? cur.stt?.apiKey || '' : '';
		stt.apiKey = (await ask.secret(kept ? '   API key (enter keeps the current one):' : '   API key:')) || kept;
	} else {
		stt.kind = 'browser';
	}
	c.stt = stt;
}

async function stepVoice(ask: Ask, checks: Checks, c: Choices, n: string): Promise<void> {
	const cur = checks.current;
	ask.say(`${n}The voice — reading the answers aloud`);
	const was =
		cur.tts?.kind === 'piper'
			? 'piper'
			: cur.tts?.kind === 'openai'
				? cur.tts.apiKey
					? 'cloud'
					: 'speaches'
				: 'browser';
	const voice = await ask.choose(
		'   Where?',
		VOICES.map((v) => ({ key: v.key, label: v.name + (v.local ? '' : '  — not local') })),
		was
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
		const remembered = was === 'speaches' && cur.tts?.url ? cur.tts.url : speachesSoFar(c, cur);
		tts.url = await ask.text('   Speaches URL', remembered);
		tts.model = await ask.text('   Model', (was === 'speaches' && cur.tts?.model) || SPEACHES_TTS_MODEL);
		tts.voice = await ask.text('   Voice', (was === 'speaches' && cur.tts?.voice) || SPEACHES_TTS_VOICE);
		await speechReady(ask, checks, tts.url, tts.model, '');
	} else if (voice === 'cloud') {
		tts.kind = 'openai';
		tts.url = normalizeUrl(
			await ask.text('   Endpoint', (was === 'cloud' && cur.tts?.url) || 'https://api.openai.com')
		).replace(/\/+$/, '');
		tts.model = await ask.text('   Model', (was === 'cloud' && cur.tts?.model) || OPENAI_TTS_MODEL);
		tts.voice = await ask.text('   Voice', (was === 'cloud' && cur.tts?.voice) || OPENAI_TTS_VOICE);
		const kept = was === 'cloud' ? cur.tts?.apiKey || '' : '';
		tts.apiKey =
			c.stt.apiKey && c.stt.url === tts.url
				? c.stt.apiKey
				: (await ask.secret(kept ? '   API key (enter keeps the current one):' : '   API key:')) || kept;
	}
	c.tts = tts;
}

async function stepAssistant(ask: Ask, c: Choices, n: string): Promise<void> {
	ask.say(`${n}The assistant`);
	c.name = await ask.text('   Its name', c.name);
	c.language = await ask.text('   The language it answers in (a tag: pt-BR, en, es…)', c.language);
	c.stt.language = sttLanguage(c.language);
}

async function stepReach(ask: Ask, checks: Checks, c: Choices, n: string): Promise<void> {
	const cur = checks.current;
	ask.say(`${n}Reaching it from another device`);
	ask.say("   In this computer's own browser the page works as it is. A phone needs an https address for this");
	ask.say('   computer: its microphone only opens on https.');
	const tailscale = checks.has('tailscale') ? await checks.tailscaleName() : null;
	c.reach = (await ask.choose(
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
				note: `http://127.0.0.1:${c.port}, in a browser on this computer. No other device can reach it yet.`
			}
		],
		cur.reach || (tailscale ? 'tailscale' : 'loopback')
	)) as Choices['reach'];
	c.publicUrl = '';
	c.host = '127.0.0.1';
	c.tls = { cert: '', key: '' };
	if (c.reach === 'tailscale') {
		c.publicUrl = tailscale
			? `https://${tailscale}`
			: normalizeUrl(await ask.text('   The https name Tailscale gives this computer', cur.publicUrl || ''));
		if (checks.has('tailscale') && (await ask.yes(`   Run \`tailscale serve --bg ${c.port}\` now?`, true)))
			await checks.run(`tailscale serve --bg ${c.port}`);
	} else if (c.reach === 'proxy') {
		c.publicUrl = (await ask.text('   The https address the proxy answers on', cur.publicUrl || '')).replace(
			/\/+$/,
			''
		);
	} else if (c.reach === 'tls') {
		c.tls.cert = await ask.text('   Certificate file', cur.tls?.cert || '');
		c.tls.key = await ask.text('   Key file', cur.tls?.key || '');
		c.host = '0.0.0.0';
		c.publicUrl = await ask.text('   The https address the device opens', cur.publicUrl || '');
	}
}
