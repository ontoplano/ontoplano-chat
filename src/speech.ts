/*
 * Ears and voice: speech to text, text to speech.
 *
 * Both are HTTP calls to something on this machine — Speaches, whisper.cpp's
 * server, LocalAI — or, for the voice, the piper binary. "browser" means the
 * phone does that half itself; the server then has nothing to do here.
 */
import { spawn } from 'node:child_process';

import { SPEECH_TIMEOUT_MS } from './constants.js';

export type Stt = {
	kind: 'openai' | 'whispercpp' | 'browser';
	/** What it is, for a person: the model and where it runs — never the API flavour alone. */
	about: string;
	transcribe(audio: Uint8Array, mime: string, language?: string): Promise<string>;
	check(): Promise<string | null>;
};

export type Spoken = { mime: string; bytes: Uint8Array };

export type Tts = {
	kind: 'openai' | 'piper' | 'browser';
	/** What it is, for a person: the voice and where it runs — never the API flavour alone. */
	about: string;
	/** `null` when the device speaks for itself. */
	speak(text: string): Promise<Spoken | null>;
	check(): Promise<string | null>;
};

export class SpeechError extends Error {}

/** What the checks send: a moment of silence to the ears, one word to the voice. */
const PROBE_SILENCE_MS = 300;
const PROBE_WORD = 'oi';

/** The message out of an error body when it is the usual JSON, else the first line — never "404: 404: Not Found". */
function saidBy(status: number, text: string): string {
	let message = text.split('\n')[0]?.slice(0, 200) ?? '';
	try {
		const parsed = JSON.parse(text) as { detail?: unknown; error?: { message?: string } | string; message?: string };
		const d = parsed.detail;
		if (typeof d === 'string') message = d;
		else if (typeof parsed.error === 'string') message = parsed.error;
		else if (parsed.error && typeof parsed.error.message === 'string') message = parsed.error.message;
		else if (typeof parsed.message === 'string') message = parsed.message;
	} catch {
		// not JSON
	}
	message = message.replace(new RegExp(`^${status}:?\\s*`), '');
	return message ? `${status} — ${message}` : String(status);
}

const bearer = (apiKey?: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

/** The models an OpenAI-compatible server lists, or null when it does not list any (a cloud, or not that kind of server). */
async function modelsOn(url: string, apiKey: string | undefined, fetchImpl: typeof fetch): Promise<string[] | null> {
	try {
		const res = await fetchImpl(`${url}/v1/models`, { headers: bearer(apiKey), signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: { id?: string }[] };
		return Array.isArray(body.data) ? body.data.map((m) => m.id ?? '').filter(Boolean) : null;
	} catch {
		return null;
	}
}

/**
 * Is the server there, and does it have the model? A local server (Speaches,
 * LocalAI) answers 404 to a turn whose model is not downloaded, so the check
 * asks first. Null when all is well.
 */
export async function speechServerCheck(
	url: string,
	model: string,
	apiKey: string | undefined,
	fetchImpl: typeof fetch = fetch
): Promise<string | null> {
	try {
		const res = await fetchImpl(url, { method: 'GET', headers: bearer(apiKey), signal: AbortSignal.timeout(5000) });
		if (res.status >= 500) return `${url} answered ${res.status}`;
	} catch (e) {
		return `nothing answers at ${url}: ${(e as Error).message}`;
	}
	if (apiKey || !model) return null;
	const have = await modelsOn(url, apiKey, fetchImpl);
	if (have && !have.includes(model)) return `the model ${model} is not installed on the server at ${url}`;
	return null;
}

/** Ask a local server to download a model (Speaches: POST /v1/models/{id}). Null when it did, else why not. */
export async function speechServerPull(
	url: string,
	model: string,
	apiKey: string | undefined,
	fetchImpl: typeof fetch = fetch
): Promise<string | null> {
	try {
		const res = await fetchImpl(`${url}/v1/models/${encodeURIComponent(model)}`, {
			method: 'POST',
			headers: bearer(apiKey),
			signal: AbortSignal.timeout(30 * 60 * 1000)
		});
		if (res.ok || res.status === 201) return null;
		return `the server answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
	} catch (e) {
		return `could not ask ${url} to download it: ${(e as Error).message}`;
	}
}

type SttOptions = {
	kind: 'openai' | 'whispercpp';
	url: string;
	path: string;
	model: string;
	language: string;
	apiKey?: string;
	/** Words the recogniser should expect — the app's name, the assistant's — so "ontoplano" is not heard as "on top land". */
	prompt?: string;
	fetchImpl?: typeof fetch;
};

const extensionOf = (mime: string): string => {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('ogg')) return 'ogg';
	if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
	if (mime.includes('wav')) return 'wav';
	if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
	return 'bin';
};

export function httpStt(o: SttOptions): Stt {
	const fetchImpl = o.fetchImpl ?? fetch;
	const headers: Record<string, string> = o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {};
	return {
		kind: o.kind,
		about:
			o.kind === 'whispercpp'
				? `whisper.cpp at ${o.url}`
				: `${o.model} at ${o.url}${o.apiKey ? '' : ' (an OpenAI-compatible server)'}`,
		async transcribe(audio, mime, language = o.language) {
			const form = new FormData();
			form.append('file', new Blob([audio], { type: mime }), `turn.${extensionOf(mime)}`);
			form.append('response_format', 'json');
			if (language) form.append('language', language);
			if (o.prompt) form.append('prompt', o.prompt);
			if (o.kind === 'openai') form.append('model', o.model);
			let res: Response;
			try {
				res = await fetchImpl(`${o.url}${o.path}`, {
					method: 'POST',
					headers,
					body: form,
					signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS)
				});
			} catch (e) {
				throw new SpeechError(`no transcriber at ${o.url}: ${(e as Error).message}`);
			}
			if (!res.ok)
				throw new SpeechError(
					`the transcriber at ${o.url} answered ${saidBy(res.status, await res.text())}${res.status === 404 ? ` to POST ${o.path} — is that a Speaches / whisper server?` : ''}`
				);
			const body = (await res.json()) as { text?: string };
			return (body.text ?? '').trim();
		},
		async check() {
			if (o.kind === 'whispercpp') {
				try {
					const res = await fetchImpl(o.url, { method: 'GET', signal: AbortSignal.timeout(5000) });
					return res.status >= 500 ? `${o.url} answered ${res.status}` : null;
				} catch (e) {
					return `no transcriber at ${o.url}: ${(e as Error).message}`;
				}
			}
			const listed = await speechServerCheck(o.url, o.model, o.apiKey, fetchImpl);
			if (listed) return listed;
			// The listing is what the server says; a transcription is what a turn
			// does. A moment of silence is enough to find out.
			try {
				await this.transcribe(silentWav(PROBE_SILENCE_MS), 'audio/wav');
				return null;
			} catch (e) {
				return (e as Error).message;
			}
		}
	};
}

export const browserStt: Stt = {
	kind: 'browser',
	about: 'the device recognises speech itself',
	transcribe: async () => {
		throw new SpeechError('speech is recognised on the phone (stt.kind = "browser"); send text');
	},
	check: async () => null
};

export const browserTts: Tts = {
	kind: 'browser',
	about: 'the device speaks itself',
	speak: async () => null,
	check: async () => null
};

type OpenAiTtsOptions = { url: string; model: string; voice: string; apiKey?: string; fetchImpl?: typeof fetch };

export function openAiTts(o: OpenAiTtsOptions): Tts {
	const fetchImpl = o.fetchImpl ?? fetch;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
	return {
		kind: 'openai',
		about: `${o.voice || o.model} at ${o.url}${o.apiKey ? '' : ' (an OpenAI-compatible server)'}`,
		async speak(text) {
			let res: Response;
			try {
				res = await fetchImpl(`${o.url}/v1/audio/speech`, {
					method: 'POST',
					headers,
					signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
					body: JSON.stringify({ model: o.model, voice: o.voice, input: text, response_format: 'mp3' })
				});
			} catch (e) {
				throw new SpeechError(`no voice at ${o.url}: ${(e as Error).message}`);
			}
			if (!res.ok)
				throw new SpeechError(
					`the voice at ${o.url} answered ${saidBy(res.status, await res.text())}${res.status === 404 ? ' to POST /v1/audio/speech — is that a server with a voice (Speaches with TTS, Kokoro-FastAPI)?' : ''}`
				);
			const mime = res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
			return { mime, bytes: new Uint8Array(await res.arrayBuffer()) };
		},
		async check() {
			const listed = await speechServerCheck(o.url, o.model, o.apiKey, fetchImpl);
			if (listed) return listed;
			// And one word spoken, which is what a turn asks for.
			try {
				await this.speak(PROBE_WORD);
				return null;
			} catch (e) {
				return (e as Error).message;
			}
		}
	};
}

type PiperOptions = { command: string; model: string };

export function piperTts(o: PiperOptions): Tts {
	return {
		kind: 'piper',
		about: `piper, voice ${o.model}`,
		speak(text) {
			return new Promise<Spoken>((resolve, reject) => {
				const child = spawn(o.command, ['--model', o.model, '--output_file', '-'], {
					stdio: ['pipe', 'pipe', 'pipe']
				});
				const chunks: Buffer[] = [];
				let err = '';
				const timer = setTimeout(() => {
					child.kill();
					reject(new SpeechError(`piper took longer than ${SPEECH_TIMEOUT_MS / 1000}s`));
				}, SPEECH_TIMEOUT_MS);
				child.stdout.on('data', (c: Buffer) => chunks.push(c));
				child.stderr.on('data', (c: Buffer) => (err += c.toString()));
				child.on('error', (e) => {
					clearTimeout(timer);
					reject(new SpeechError(`cannot run ${o.command}: ${e.message}`));
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					if (code !== 0) return reject(new SpeechError(`piper exited ${code}: ${err.slice(0, 200)}`));
					resolve({ mime: 'audio/wav', bytes: new Uint8Array(Buffer.concat(chunks)) });
				});
				child.stdin.end(text);
			});
		},
		check() {
			return new Promise((resolve) => {
				const child = spawn(o.command, ['--help'], { stdio: 'ignore' });
				child.on('error', (e) => resolve(`cannot run ${o.command}: ${e.message}`));
				child.on('close', () => resolve(null));
			});
		}
	};
}

/** A WAV of silence, `ms` long, 8kHz mono 16-bit. */
export function silentWav(ms: number): Uint8Array {
	const rate = 8000;
	const samples = Math.round((rate * ms) / 1000);
	const data = samples * 2;
	const buf = Buffer.alloc(44 + data);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + data, 4);
	buf.write('WAVE', 8);
	buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(data, 40);
	return new Uint8Array(buf);
}
