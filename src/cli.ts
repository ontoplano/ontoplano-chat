/*
 * The command: `ontoplano-chat <verb>`.
 *
 *   serve      run the server (the systemd unit's ExecStart)
 *   pair       print a code for a device to type — ten minutes, one use
 *   devices    the devices that are paired
 *   revoke     forget one, by name
 *   doctor     is everything reachable: the model, the ears, the voice, the app
 *   config     write the example config file, if there is none
 *   version
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { terminalAsk } from './ask.js';
import { OntoplanoMcp } from './mcp.js';
import { openAiLlm } from './llm.js';
import { speechServerCheck, speechServerPull } from './speech.js';
import { renderConfig, runWizard, STEPS, type Checks, type Choices, type Step } from './wizard.js';

import { checkForServing, exampleConfig, loadConfig, ConfigError, type Config } from './config.js';
import { OLLAMA_INSTALL, PROVIDERS, SPEACHES_RUN } from './constants.js';
import { buildEngines } from './engines.js';
import { History } from './history.js';
import { Devices } from './pairing.js';
import { createHttpServer } from './server.js';
import { Assistant } from './turn.js';
import { VERSION } from './version.js';

const out = (line = ''): void => void process.stdout.write(line + '\n');
const err = (line: string): void => void process.stderr.write(line + '\n');
const stamp = (line: string): void => out(`${new Date().toISOString().slice(11, 19)} ${line}`);

const HELP = `ontoplano-chat ${VERSION} — a local voice assistant for ontoplano

  ontoplano-chat setup      the six questions: the app, the model, the ears, the voice, the name, how a device reaches it
  ontoplano-chat setup <step>   one of them again: app · model · ears · voice · assistant · reach
  ontoplano-chat serve      run the server
  ontoplano-chat pair       print a pairing code for a device (ten minutes, one use)
  ontoplano-chat devices    the paired devices
  ontoplano-chat revoke <name>
  ontoplano-chat doctor     check the model, the ears, the voice and the app
  ontoplano-chat models     pull the model, and the speech models, the config names onto the local servers
  ontoplano-chat config     write ~/.config/ontoplano-chat/config.toml if there is none
  ontoplano-chat version
`;

function config(): Config {
	try {
		return loadConfig();
	} catch (e) {
		if (e instanceof ConfigError) {
			err(e.message);
			process.exit(2);
		}
		throw e;
	}
}

const whereToOpen = (c: Config): string =>
	c.server.publicUrl ||
	`${c.server.tls.cert ? 'https' : 'http'}://${c.server.host === '0.0.0.0' ? '<this machine>' : c.server.host}:${c.server.port}`;

async function serve(): Promise<number> {
	const c = config();
	const fake = process.env.ONTOPLANO_CHAT_ENGINES === 'fake';
	const problems = checkForServing(c).filter((p) => !(fake && p.startsWith('ontoplano.token')));
	if (problems.length) {
		for (const p of problems) err(`refusing to serve: ${p}`);
		err(`(the config is ${c.configPath})`);
		return 2;
	}
	const engines = buildEngines(c, process.env, stamp);
	const devices = new Devices(c.dataDir);
	const history = new History(c.dataDir);
	const assistant = new Assistant({
		name: c.assistant.name,
		language: c.assistant.language,
		appUrl: c.ontoplano.url,
		confirm: c.assistant.confirm,
		historyTurns: c.assistant.historyTurns,
		maxToolRounds: c.llm.maxToolRounds,
		llm: engines.llm,
		stt: engines.stt,
		tts: engines.tts,
		mcp: engines.mcp,
		tools: () => engines.tools.current(),
		history
	});
	engines.tools.start();
	const server = createHttpServer({ config: c, devices, assistant, history, engines, version: VERSION, log: stamp });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(c.server.port, c.server.host, resolve);
	});
	stamp(`ontoplano-chat ${VERSION}${fake ? ' (fake engines)' : ''} listening on ${c.server.host}:${c.server.port}`);
	stamp(`model ${engines.llm.model} at ${c.llm.url} · ears: ${engines.stt.about} · voice: ${engines.tts.about}`);
	if (!devices.list().length) {
		// A code setup or pair printed a moment ago is the one to keep; a second
		// one here would silently replace it.
		const pending = devices.pendingCode();
		if (pending) {
			out('');
			out(
				`  No device is paired yet; the code printed by setup or pair is good until ${new Date(pending.expiresAt).toLocaleTimeString()}.`
			);
			out('');
		} else {
			const { code, expiresAt } = devices.issueCode();
			out('');
			out(`  No device is paired yet. ${whereToType(c)}`);
			out('');
			out(`      ${code}`);
			out('');
			out(`  (good until ${new Date(expiresAt).toLocaleTimeString()}; \`ontoplano-chat pair\` prints another)`);
			out('');
		}
	}
	await new Promise<void>((resolve) => {
		const stop = (): void => {
			stamp('stopping');
			engines.tools.stop();
			server.close(() => resolve());
			setTimeout(resolve, 2000).unref();
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	});
	return 0;
}

/** Where to open the page, said for the device that will: a phone, or a browser on this computer. */
const whereToType = (c: Config): string =>
	c.server.publicUrl
		? `On the device — a phone, or a browser on this computer — open ${c.server.publicUrl} and type:`
		: `In a browser on this computer, open ${whereToOpen(c)} and type (a phone cannot reach it yet; \`ontoplano-chat setup reach\` when it can):`;

function pair(): number {
	const c = config();
	const devices = new Devices(c.dataDir);
	const { code, expiresAt } = devices.issueCode();
	out(whereToType(c));
	out('');
	out(`    ${code}`);
	out('');
	out(
		`Good until ${new Date(expiresAt).toLocaleTimeString()}, once. The server reads it from ${c.dataDir}; it need not be restarted.`
	);
	return 0;
}

function listDevices(): number {
	const c = config();
	const list = new Devices(c.dataDir).list();
	if (!list.length) {
		out('No device is paired. `ontoplano-chat pair` prints a code.');
		return 0;
	}
	for (const d of list)
		out(
			`  ${d.name.padEnd(24)} paired ${d.createdAt.slice(0, 10)}  last seen ${d.lastSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never'}`
		);
	return 0;
}

function revoke(name: string | undefined): number {
	if (!name) {
		err('which one? ontoplano-chat revoke <name>  (ontoplano-chat devices lists them)');
		return 2;
	}
	const c = config();
	if (!new Devices(c.dataDir).revoke(name)) {
		err(`no device called "${name}"`);
		return 1;
	}
	out(`forgot ${name}; that device will be asked to pair again`);
	return 0;
}

async function doctor(): Promise<number> {
	const c = config();
	out(
		`config   ${c.configPath}${existsSync(c.configPath) ? '' : '  (missing — defaults; `ontoplano-chat config` writes one)'}`
	);
	out(`data     ${c.dataDir}`);
	let bad = 0;
	/** A line per check, and under a ✗ the thing to do about it. */
	const tell = (what: string, problem: string | null, fix?: string): void => {
		out(`${problem ? '  ✗' : '  ✓'} ${what}${problem ? ` — ${problem}` : ''}`);
		if (problem) {
			bad++;
			if (fix) out(`      ${fix}`);
		}
	};
	for (const p of checkForServing(c)) tell('serving', p);
	const engines = buildEngines(c);
	const port = (url: string): string => {
		try {
			return new URL(url).port || '8000';
		} catch {
			return '8000';
		}
	};
	const llmProblem = await engines.llm.check();
	tell(
		`model ${engines.llm.model} at ${c.llm.url}`,
		llmProblem,
		c.llm.url.includes('11434')
			? llmProblem && /not pulled/.test(llmProblem)
				? `pull it: ontoplano-chat models — or: ollama pull ${engines.llm.model}`
				: has('ollama')
					? `is Ollama running? systemctl status ollama — or: ollama serve`
					: `install it: ${OLLAMA_INSTALL} — then: ollama pull ${engines.llm.model}`
			: 'is the server up at that address? `ontoplano-chat setup model` changes it'
	);
	const sttProblem = await engines.stt.check();
	tell(
		`ears: ${engines.stt.about}`,
		sttProblem,
		sttProblem && /not installed/.test(sttProblem)
			? 'download it: `ontoplano-chat models` — or `ontoplano-chat setup ears`'
			: engines.stt.kind === 'openai' && !c.stt.apiKey
				? `nothing answers there. Speaches: ${SPEACHES_RUN.replace('-p 8000:8000', `-p ${port(c.stt.url)}:8000`)} — or \`ontoplano-chat setup ears\` with the port it really has`
				: engines.stt.kind === 'whispercpp'
					? "is whisper.cpp's server running on that port? `ontoplano-chat setup ears` changes it"
					: 'check the address and the key: `ontoplano-chat setup ears`'
	);
	const ttsProblem = await engines.tts.check();
	tell(
		`voice: ${engines.tts.about}`,
		ttsProblem,
		ttsProblem && /not installed/.test(ttsProblem)
			? 'download it: `ontoplano-chat models` — or `ontoplano-chat setup voice`'
			: engines.tts.kind === 'piper'
				? 'piper is not on the PATH: https://github.com/rhasspy/piper — or `ontoplano-chat setup voice`'
				: 'nothing answers there: `ontoplano-chat setup voice` changes it'
	);
	if (c.ontoplano.token) {
		const loaded = await engines.tools.load();
		tell(
			`app ${c.ontoplano.url}: ${engines.tools.current().length} tools offered of ${engines.tools.granted().length} granted`,
			loaded
				? engines.tools.current().length
					? null
					: 'the token grants none of the tools in assistant.tools'
				: engines.tools.lastError
		);
	}
	const paired = new Devices(c.dataDir).list().length;
	out(`  ${paired ? '✓' : '·'} ${paired} device${paired === 1 ? '' : 's'} paired`);
	out(bad ? `\n${bad} thing${bad === 1 ? '' : 's'} to fix.` : '\nAll good.');
	return bad ? 1 : 0;
}

/** Download the speech models the config names onto the local speech server(s). */
async function pullModels(): Promise<number> {
	const c = config();
	let bad = 0;
	const wanted: { what: string; url: string; model: string }[] = [];
	if (c.stt.kind === 'openai' && !c.stt.apiKey) wanted.push({ what: 'ears', url: c.stt.url, model: c.stt.model });
	if (c.tts.kind === 'openai' && !c.tts.apiKey) wanted.push({ what: 'voice', url: c.tts.url, model: c.tts.model });

	// The model itself first, when the runner can pull it (Ollama can).
	const llm = buildEngines(c).llm;
	const llmProblem = await llm.check();
	if (!llmProblem) out(`  ✓ model: ${llm.model} is on ${c.llm.url}`);
	else if (/not pulled/.test(llmProblem)) {
		out(`  → model: pulling ${llm.model} on ${c.llm.url} (a few GB; several minutes)…`);
		const problem = (await llm.pull()) ?? (await llm.check());
		out(problem ? `  ✗ model: ${problem}` : `  ✓ model: ${llm.model} is on ${c.llm.url}`);
		if (problem) bad++;
	} else {
		out(`  ✗ model: ${llmProblem}`);
		bad++;
	}
	for (const w of wanted) {
		const already = await speechServerCheck(w.url, w.model, undefined);
		if (!already) {
			out(`  ✓ ${w.what}: ${w.model} is on ${w.url}`);
			continue;
		}
		if (!/not installed/.test(already)) {
			out(`  ✗ ${w.what}: ${already}`);
			bad++;
			continue;
		}
		out(`  → ${w.what}: downloading ${w.model} on ${w.url} (a minute or two)…`);
		const problem =
			(await speechServerPull(w.url, w.model, undefined)) ?? (await speechServerCheck(w.url, w.model, undefined));
		out(problem ? `  ✗ ${w.what}: ${problem}` : `  ✓ ${w.what}: ${w.model} is on ${w.url}`);
		if (problem) bad++;
	}
	return bad ? 1 : 0;
}

function writeConfig(): number {
	const c = config();
	if (existsSync(c.configPath)) {
		out(`${c.configPath} exists; not touching it`);
		return 0;
	}
	mkdirSync(dirname(c.configPath), { recursive: true, mode: 0o700 });
	writeFileSync(c.configPath, exampleConfig(), { mode: 0o600 });
	out(`wrote ${c.configPath} — put the app's token in it, then \`ontoplano-chat doctor\``);
	return 0;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A shell line, with the terminal attached — for installs the wizard offers. */
function shell(line: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn('sh', ['-c', line], { stdio: 'inherit' });
		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
}

function has(command: string): boolean {
	return (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, command)));
}

async function tailscaleName(): Promise<string | null> {
	return new Promise((resolve) => {
		const child = spawn('tailscale', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		child.stdout.on('data', (c: Buffer) => (out += c.toString()));
		child.on('error', () => resolve(null));
		child.on('close', () => {
			try {
				const name = (JSON.parse(out) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '');
				resolve(name || null);
			} catch {
				resolve(null);
			}
		});
	});
}

/** What the config says now, as the wizard's defaults. */
function currentChoices(c: Config): Partial<Choices> {
	const provider = PROVIDERS_BY_URL(c.llm.url);
	return {
		appUrl: c.ontoplano.url,
		token: c.ontoplano.token,
		provider,
		llm: { url: c.llm.url, model: c.llm.model, apiKey: c.llm.apiKey },
		stt: { kind: c.stt.kind, url: c.stt.url, model: c.stt.model, language: c.stt.language, apiKey: c.stt.apiKey },
		tts: {
			kind: c.tts.kind,
			url: c.tts.url,
			model: c.tts.model,
			voice: c.tts.voice,
			apiKey: c.tts.apiKey,
			piperModel: c.tts.piperModel
		},
		name: c.assistant.name,
		language: c.assistant.language,
		publicUrl: c.server.publicUrl,
		port: c.server.port,
		tls: c.server.tls,
		reach: c.server.tls.cert
			? 'tls'
			: c.server.publicUrl
				? c.server.publicUrl.includes('.ts.net')
					? 'tailscale'
					: 'proxy'
				: undefined
	};
}

function PROVIDERS_BY_URL(url: string): string | undefined {
	return PROVIDERS.find((p) => p.url && p.url === url)?.key ?? (url ? 'custom' : undefined);
}

async function setup(step?: string): Promise<number> {
	const c = config();
	if (step && !(STEPS as readonly string[]).includes(step)) {
		err(`no step called "${step}": one of ${STEPS.join(', ')}`);
		return 2;
	}
	const ask = terminalAsk();
	const checks: Checks = {
		async app(url, token) {
			try {
				const tools = await new OntoplanoMcp(url, token).listTools();
				return { tools: tools.length };
			} catch (e) {
				return { problem: (e as Error).message };
			}
		},
		llm: (url, model, apiKey) => openAiLlm({ url, model, apiKey, timeoutMs: 10_000 }).check(),
		llmPull: (url, model, apiKey) => openAiLlm({ url, model, apiKey, timeoutMs: 10_000 }).pull(),
		llmModels: (url, apiKey) => openAiLlm({ url, model: '', apiKey, timeoutMs: 10_000 }).models(),
		speech: (url, model, apiKey) => speechServerCheck(url, model, apiKey || undefined),
		pull: (url, model, apiKey) => speechServerPull(url, model, apiKey || undefined),
		has,
		run: shell,
		tailscaleName,
		current: existsSync(c.configPath) ? currentChoices(c) : {}
	};
	const choices = await runWizard(ask, checks, step as Step | undefined);
	mkdirSync(dirname(c.configPath), { recursive: true, mode: 0o700 });
	writeFileSync(c.configPath, renderConfig(choices), { mode: 0o600 });
	out('');
	out(`✓ wrote ${c.configPath}`);
	out('');
	const fresh = config();
	const problems = checkForServing(fresh);
	for (const p of problems) out(`  ✗ ${p}`);
	const devices = new Devices(fresh.dataDir);
	// The code first, so a service started next finds one waiting and prints no second one.
	const code = devices.list().length ? null : devices.issueCode();
	// Already a service: restarted with the new config, not asked again.
	const enabled = has('systemctl') && (await shell('systemctl --user is-enabled --quiet ontoplano-chat 2>/dev/null'));
	const service = enabled || (await ask.yes('Run it as a service from now on (systemd --user)?', has('systemctl')));
	const running = enabled
		? await shell('systemctl --user restart ontoplano-chat').then((ok) => {
				out(
					ok ? '✓ the service was restarted with this config' : '✗ the service did not restart; `make logs` says why'
				);
				return ok;
			})
		: service
			? await installService()
			: false;
	out('');
	if (code) {
		out(`Now pair a device. ${whereToType(fresh)}`);
		out('');
		out(`    ${code.code}`);
		out('');
		out(`Good until ${new Date(code.expiresAt).toLocaleTimeString()}, once. \`ontoplano-chat pair\` prints another.`);
	} else {
		const n = devices.list().length;
		out(`${n} device${n === 1 ? ' is' : 's are'} paired already; \`ontoplano-chat pair\` adds another.`);
	}
	out('');
	if (!running) out('Start it with: ontoplano-chat serve');
	else out('It is running as a service with this config.');
	process.stdin.destroy();
	return problems.length ? 1 : 0;
}

/** The systemd user unit, pointed at this checkout, enabled now. */
async function installService(): Promise<boolean> {
	const unit = readFileSync(join(ROOT, 'systemd', 'ontoplano-chat.service'), 'utf8').replace(
		'%h/codes/ontoplano/ontoplano-chat',
		ROOT.replace(/\/$/, '')
	);
	const dir = join(process.env.HOME ?? '', '.config', 'systemd', 'user');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'ontoplano-chat.service'), unit);
	const ok =
		(await shell('systemctl --user daemon-reload')) &&
		(await shell('systemctl --user enable --now ontoplano-chat')) &&
		(await shell('systemctl --user restart ontoplano-chat'));
	out(
		ok
			? '✓ running as a service — journalctl --user -u ontoplano-chat -f follows it'
			: '✗ systemd did not take it; `make install-service` says more'
	);
	return ok;
}

export async function main(argv: string[]): Promise<number> {
	const [verb, ...rest] = argv;
	switch (verb) {
		case 'setup':
			return setup(rest[0]);
		case 'serve':
			return serve();
		case 'pair':
			return pair();
		case 'devices':
			return listDevices();
		case 'revoke':
			return revoke(rest[0]);
		case 'doctor':
			return doctor();
		case 'models':
			return pullModels();
		case 'config':
			return writeConfig();
		case 'version':
			out(VERSION);
			return 0;
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			out(HELP);
			return 0;
		default:
			err(`unknown command "${verb}"\n`);
			out(HELP);
			return 2;
	}
}

// Run directly — `node dist/cli.js serve`, `tsx src/cli.ts serve` — as well as imported by bin/.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
