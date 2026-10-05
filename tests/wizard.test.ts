import { describe, expect, it } from 'vitest';

import { scriptedAsk } from '../src/ask.js';
import { fromToml } from '../src/config.js';
import { PROVIDERS } from '../src/constants.js';
import { renderConfig, runWizard, type Checks } from '../src/wizard.js';

const env = { HOME: '/home/x' } as NodeJS.ProcessEnv;

function checks(over: Partial<Checks> = {}): Checks & { ran: string[] } {
	const ran: string[] = [];
	return {
		ran,
		app: async () => ({ tools: 38 }),
		llm: async () => null,
		has: () => false,
		run: async (line) => {
			ran.push(line);
			return true;
		},
		tailscaleName: async () => null,
		llmPull: async () => null,
		llmModels: async () => [],
		startSpeaches: async () => true,
		speech: async () => null,
		pull: async () => null,
		current: {},
		...over
	};
}

describe('the wizard', () => {
	it('all defaults: Ollama here, Speaches ears, the phone speaks, loopback', async () => {
		const c = checks();
		const choices = await runWizard(scriptedAsk(['', 'tok']), c);
		expect(choices.provider).toBe('ollama');
		expect(choices.llm).toEqual({ url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' });
		expect(choices.stt.kind).toBe('openai');
		expect(choices.stt.language).toBe('pt');
		expect(choices.tts.kind).toBe('browser');
		expect(choices.reach).toBe('loopback');
		expect(choices.host).toBe('127.0.0.1');
		const parsed = fromToml(renderConfig(choices), env);
		expect(parsed.ontoplano.token).toBe('tok');
		expect(parsed.llm.model).toBe('qwen2.5:7b');
		expect(parsed.assistant.language).toBe('pt-BR');
	});

	it('a cloud model: Anthropic with a key, English, behind a proxy', async () => {
		const answers = [
			'https://my.onto/', // app
			'tok',
			'4', // anthropic
			'', // endpoint
			'', // model
			'sk-ant', // key
			'4', // ears: browser
			'1', // voice: phone
			'Jarvis',
			'en',
			'2', // proxy
			'https://onto.example.com/'
		];
		const choices = await runWizard(scriptedAsk(answers), checks());
		expect(choices.appUrl).toBe('https://my.onto');
		expect(choices.provider).toBe('anthropic');
		expect(choices.llm).toEqual({ url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5', apiKey: 'sk-ant' });
		expect(choices.stt.kind).toBe('browser');
		expect(choices.stt.language).toBe('en');
		expect(choices.name).toBe('Jarvis');
		expect(choices.publicUrl).toBe('https://onto.example.com');
		const parsed = fromToml(renderConfig(choices), env);
		expect(parsed.llm.apiKey).toBe('sk-ant');
		expect(parsed.server.publicUrl).toBe('https://onto.example.com');
		expect(parsed.server.insecure).toBe(false);
	});

	it('offers to install Ollama when it is missing, and to pull the model when it is', async () => {
		let calls = 0;
		let pulled = '';
		const c = checks({
			llm: async () =>
				++calls === 1
					? 'no model runner'
					: calls === 2
						? 'model "qwen2.5:7b" is not pulled: the runner lists no models'
						: null,
			llmPull: async (_u, model) => {
				pulled = model;
				return null;
			},
			has: (cmd) => cmd === 'ollama' && calls >= 2
		});
		const log: string[] = [];
		await runWizard(scriptedAsk(['', 'tok', '', '', '', 'y', 'y'], log), c);
		expect(c.ran[0]).toMatch(/ollama\.com\/install/);
		expect(pulled).toBe('qwen2.5:7b');
		expect(log.join('\n')).toContain('✓ the model answers');
	});

	it('a refused token can be retried, and the retry is checked', async () => {
		let n = 0;
		const c = checks({ app: async (_u, token) => (token === 'good' ? { tools: 3 } : { problem: `refused ${++n}` }) });
		const log: string[] = [];
		const choices = await runWizard(scriptedAsk(['', 'bad', 'y', 'good']), c);
		expect(choices.token).toBe('good');
		expect(n).toBe(1);
		void log;
	});

	it('Tailscale: takes the tailnet name and offers `tailscale serve`', async () => {
		const c = checks({ has: (cmd) => cmd === 'tailscale', tailscaleName: async () => 'lobo.tail1234.ts.net' });
		const choices = await runWizard(scriptedAsk(['', 'tok', '', '', '', '', '', '', '', '', '', '1', 'y']), c);
		expect(choices.reach).toBe('tailscale');
		expect(choices.publicUrl).toBe('https://lobo.tail1234.ts.net');
		expect(c.ran).toContain('tailscale serve --bg 1497');
	});

	it('its own certificate opens the host', async () => {
		const choices = await runWizard(
			scriptedAsk(['', 'tok', '', '', '', '', '', '', '', '', '', '3', '/c.pem', '/k.pem', 'https://onto.lan']),
			checks()
		);
		expect(choices.reach).toBe('tls');
		expect(choices.host).toBe('0.0.0.0');
		expect(choices.tls).toEqual({ cert: '/c.pem', key: '/k.pem' });
	});

	it('keeps the current token and key when enter is pressed', async () => {
		const c = checks({
			current: {
				token: 'kept',
				provider: 'openai',
				llm: { url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: 'sk-kept' }
			}
		});
		const choices = await runWizard(scriptedAsk(['', '', '3', '', '', '']), c);
		expect(choices.token).toBe('kept');
		expect(choices.llm.apiKey).toBe('sk-kept');
	});
});

describe('one step alone', () => {
	const current = {
		appUrl: 'https://my.onto',
		token: 'kept',
		provider: 'ollama',
		llm: { url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' },
		stt: {
			kind: 'openai' as const,
			url: 'http://127.0.0.1:8000',
			model: 'Systran/faster-whisper-small',
			language: 'pt',
			apiKey: ''
		},
		tts: {
			kind: 'openai' as const,
			url: 'http://127.0.0.1:8888',
			model: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
			voice: 'af_heart',
			apiKey: '',
			piperModel: ''
		},
		name: 'Ontoagent',
		language: 'pt-BR',
		reach: 'loopback' as const,
		publicUrl: '',
		host: '127.0.0.1',
		port: 1497,
		tls: { cert: '', key: '' }
	};

	it('asks only that step and keeps the rest', async () => {
		const log: string[] = [];
		const choices = await runWizard(scriptedAsk(['1', 'http://127.0.0.1:9000'], log), checks({ current }), 'ears');
		expect(choices.stt.url).toBe('http://127.0.0.1:9000');
		expect(choices.tts.url).toBe('http://127.0.0.1:8888');
		expect(choices.name).toBe('Ontoagent');
		expect(choices.token).toBe('kept');
		expect(log.some((l) => l.includes('The model'))).toBe(false);
	});

	it('offers what the config says, and does not change it just by being asked', async () => {
		const choices = await runWizard(scriptedAsk([]), checks({ current }), 'voice');
		expect(choices.tts).toEqual(current.tts);
		expect(current.tts.url).toBe('http://127.0.0.1:8888');
	});

	it('the voice step offers the Speaches URL the ears were given', async () => {
		const choices = await runWizard(
			scriptedAsk(['', 'tok', '', '', '', '1', 'http://127.0.0.1:9000', '', '3']),
			checks()
		);
		expect(choices.stt.url).toBe('http://127.0.0.1:9000');
		expect(choices.tts.url).toBe('http://127.0.0.1:9000');
	});

	it('without a config, one step is all six', async () => {
		const log: string[] = [];
		await runWizard(scriptedAsk(['', 'tok']), checks(), 'ears');
		void log;
		const choices = await runWizard(scriptedAsk(['', 'tok'], log), checks(), 'ears');
		expect(choices.token).toBe('tok');
		expect(log.some((l) => l.includes('The model'))).toBe(true);
	});
});

describe('a runner that has other models', () => {
	it('offers them before a download, and takes the pick', async () => {
		const c = checks({
			llm: async (_u, model) =>
				model === 'qwen3.5:9b' ? null : `model "${model}" is not pulled: the runner lists qwen3.5:9b`,
			llmModels: async () => ['qwen3.5:9b']
		});
		const log: string[] = [];
		const choices = await runWizard(scriptedAsk(['', 'tok', '', '', 'qwen2.5:9b', '1'], log), c);
		expect(choices.llm.model).toBe('qwen3.5:9b');
		expect(log.join('\n')).toContain('✓ the model answers');
	});
});

describe('a Speaches that is not there', () => {
	const current = {
		token: 'kept',
		provider: 'ollama',
		llm: { url: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:9b', apiKey: '' },
		stt: {
			kind: 'openai' as const,
			url: 'http://127.0.0.1:7749',
			model: 'Systran/faster-whisper-small',
			language: 'pt',
			apiKey: ''
		},
		tts: {
			kind: 'openai' as const,
			url: 'http://127.0.0.1:7748',
			model: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
			voice: 'bm_lewis',
			apiKey: '',
			piperModel: ''
		}
	};

	it("offers the ears' server for the voice when it answers", async () => {
		const c = checks({
			current,
			speech: async (url) => (url.endsWith('7749') ? null : `nothing answers at ${url}: fetch failed`)
		});
		const choices = await runWizard(scriptedAsk(['3', '', '', '', 'y']), c, 'voice');
		expect(choices.tts.url).toBe('http://127.0.0.1:7749');
		expect(choices.stt.url).toBe('http://127.0.0.1:7749');
	});

	it('starts a container on that very port itself when docker is here', async () => {
		let started = '';
		const c = checks({
			current,
			has: (cmd) => cmd === 'docker',
			speech: async (url) => (url.endsWith('7749') || started ? null : `nothing answers at ${url}: fetch failed`),
			startSpeaches: async (url, name) => {
				started = `${name}@${url}`;
				return true;
			}
		});
		const choices = await runWizard(scriptedAsk(['3', '', '', '', 'n']), c, 'voice');
		expect(started).toBe('speaches-voice@http://127.0.0.1:7748');
		expect(choices.tts.url).toBe('http://127.0.0.1:7748');
	});
});

describe('the speech models', () => {
	it('offers to download a model the server lacks, and checks again', async () => {
		let has = false;
		const c = checks({
			speech: async (_u, model) => (has ? null : `the model ${model} is not installed on the server at x`),
			pull: async () => {
				has = true;
				return null;
			}
		});
		const log: string[] = [];
		await runWizard(scriptedAsk(['', 'tok', '', '', '', '1', '', '', 'y'], log), c);
		expect(has).toBe(true);
		expect(log.join('\n')).toMatch(/✓ Systran\/faster-whisper-small answers at/);
	});
});

describe('the providers', () => {
	it('cloud ones are https and want a key; local ones are loopback', () => {
		for (const p of PROVIDERS.filter((p) => p.key !== 'custom')) {
			if (p.local) expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1/);
			else {
				expect(p.url).toMatch(/^https:\/\//);
				expect(p.needsKey).toBe(true);
			}
		}
		expect(PROVIDERS[0]?.key).toBe('ollama');
	});
});
