/*
 * The stack this needs, brought up: the model runner, the speech server, the
 * models. `ontoplano-chat stack` runs it; `setup` runs it after writing the
 * config; a second run finds everything there and says so.
 *
 * The shell is injected so a test can watch what would be run. Nothing here
 * asks a question: a thing that is missing and can be had is had.
 */
import type { Config } from './config.js';
import {
	OLLAMA_INSTALL,
	SPEACHES_START_POLL_MS,
	SPEACHES_START_WAIT_MS,
	SPEACHES_IMAGE,
	speachesRun
} from './constants.js';
import { openAiLlm } from './llm.js';
import { speechServerCheck, speechServerPull } from './speech.js';

export type Shell = {
	/** Run a line with the terminal attached; true when it exited 0. */
	run(line: string): Promise<boolean>;
	/** Run a line and answer its stdout, or null when it failed. */
	capture(line: string): Promise<string | null>;
	has(command: string): boolean;
	say(line: string): void;
	sleep(ms: number): Promise<void>;
};

const portOf = (url: string): string => {
	try {
		return new URL(url).port || '8000';
	} catch {
		return '8000';
	}
};

/** The model runner: installed when it is Ollama and missing, started when it is a unit, the model pulled. */
export async function ensureModel(c: Config, sh: Shell): Promise<boolean> {
	const llm = openAiLlm({ url: c.llm.url, model: c.llm.model, apiKey: c.llm.apiKey, timeoutMs: 10_000 });
	const isOllama = /:11434(\/|$)/.test(c.llm.url);
	let problem = await llm.check();
	if (problem && /no model runner/.test(problem) && isOllama) {
		if (!sh.has('ollama')) {
			sh.say(`→ model: installing Ollama (${OLLAMA_INSTALL})`);
			await sh.run(OLLAMA_INSTALL);
		}
		if (sh.has('systemctl')) {
			sh.say('→ model: starting ollama.service');
			await sh.run(
				'sudo systemctl enable --now ollama 2>/dev/null || systemctl --user enable --now ollama 2>/dev/null || true'
			);
		}
		const until = Date.now() + SPEACHES_START_WAIT_MS;
		do {
			await sh.sleep(SPEACHES_START_POLL_MS);
			problem = await llm.check();
		} while (problem && /no model runner/.test(problem) && Date.now() < until);
	}
	if (problem && /not pulled/.test(problem)) {
		sh.say(`→ model: pulling ${c.llm.model} on ${c.llm.url} (a few GB; several minutes)…`);
		problem = (await llm.pull()) ?? (await llm.check());
	}
	sh.say(problem ? `  ✗ model: ${problem}` : `  ✓ model: ${c.llm.model} at ${c.llm.url}`);
	return !problem;
}

/** Is a container publishing this port? Its name, or null. */
async function containerOn(port: string, sh: Shell): Promise<string | null> {
	const out = await sh.capture("docker ps --format '{{.Names}} {{.Ports}}'");
	for (const line of (out ?? '').split('\n')) {
		const [name, ...ports] = line.trim().split(/\s+/);
		if (name && ports.join(' ').includes(`:${port}->`)) return name;
	}
	return null;
}

/** A stopped container of that name, if there is one. */
async function stoppedContainer(name: string, sh: Shell): Promise<boolean> {
	const out = await sh.capture(`docker ps -a --filter name=^${name}$ --format '{{.Names}}'`);
	return (out ?? '').trim() === name;
}

/** A Speaches on this address: started, created, or already there. */
export async function ensureSpeaches(url: string, name: string, sh: Shell): Promise<boolean> {
	let problem = await speechServerCheck(url, '', undefined);
	if (!problem) return true;
	if (!sh.has('docker')) {
		sh.say(
			`  ✗ ${url}: nothing answers, and docker is not here to start a Speaches (https://docs.docker.com/engine/install/)`
		);
		return false;
	}
	const port = portOf(url);
	const running = await containerOn(port, sh);
	if (!running) {
		if (await stoppedContainer(name, sh)) {
			sh.say(`→ ${name}: starting the container again`);
			await sh.run(`docker start ${name}`);
		} else {
			sh.say(`→ ${name}: starting a Speaches on ${port} (${SPEACHES_IMAGE})`);
			await sh.run(speachesRun(port, name));
		}
	}
	const until = Date.now() + SPEACHES_START_WAIT_MS;
	do {
		await sh.sleep(SPEACHES_START_POLL_MS);
		problem = await speechServerCheck(url, '', undefined);
	} while (problem && Date.now() < until);
	if (problem) sh.say(`  ✗ ${url}: ${problem} — docker logs ${name}`);
	return !problem;
}

/** A model on a speech server, downloaded when it is not. */
export async function ensureSpeechModel(what: string, url: string, model: string, sh: Shell): Promise<boolean> {
	let problem = await speechServerCheck(url, model, undefined);
	if (problem && /not installed/.test(problem)) {
		sh.say(`→ ${what}: downloading ${model} on ${url} (a few hundred MB)…`);
		problem = (await speechServerPull(url, model, undefined)) ?? (await speechServerCheck(url, model, undefined));
	}
	sh.say(problem ? `  ✗ ${what}: ${problem}` : `  ✓ ${what}: ${model} at ${url}`);
	return !problem;
}

/** The whole stack the config names, up: answers whether all of it is. */
export async function ensureStack(c: Config, sh: Shell): Promise<boolean> {
	let ok = await ensureModel(c, sh);
	const servers = new Map<string, string>();
	if (c.stt.kind === 'openai' && !c.stt.apiKey) servers.set(c.stt.url, 'speaches');
	if (c.tts.kind === 'openai' && !c.tts.apiKey && !servers.has(c.tts.url)) servers.set(c.tts.url, 'speaches-voice');
	for (const [url, name] of servers) ok = (await ensureSpeaches(url, name, sh)) && ok;
	if (c.stt.kind === 'openai' && !c.stt.apiKey)
		ok = (await ensureSpeechModel('ears', c.stt.url, c.stt.model, sh)) && ok;
	if (c.tts.kind === 'openai' && !c.tts.apiKey)
		ok = (await ensureSpeechModel('voice', c.tts.url, c.tts.model, sh)) && ok;
	return ok;
}
