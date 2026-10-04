/*
 * The command: `ontoplano-chat <verb>`.
 *
 *   serve      run the server (the systemd unit's ExecStart)
 *   pair       print a code for a phone to type — ten minutes, one use
 *   devices    the phones that are paired
 *   revoke     forget one, by name
 *   doctor     is everything reachable: the model, the ears, the voice, the app
 *   config     write the example config file, if there is none
 *   version
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { checkForServing, exampleConfig, loadConfig, ConfigError, type Config } from './config.js';
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

  ontoplano-chat serve      run the server
  ontoplano-chat pair       print a pairing code for a phone (ten minutes, one use)
  ontoplano-chat devices    the paired phones
  ontoplano-chat revoke <name>
  ontoplano-chat doctor     check the model, the ears, the voice and the app
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
	stamp(`model ${engines.llm.model} at ${c.llm.url} · ears ${engines.stt.kind} · voice ${engines.tts.kind}`);
	if (!devices.list().length) {
		const { code, expiresAt } = devices.issueCode();
		out('');
		out(`  No phone is paired yet. On the phone, open ${whereToOpen(c)} and type:`);
		out('');
		out(`      ${code}`);
		out('');
		out(`  (good until ${new Date(expiresAt).toLocaleTimeString()}; \`ontoplano-chat pair\` prints another)`);
		out('');
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

function pair(): number {
	const c = config();
	const devices = new Devices(c.dataDir);
	const { code, expiresAt } = devices.issueCode();
	out(`On the phone, open ${whereToOpen(c)} and type:`);
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
		out('No phone is paired. `ontoplano-chat pair` prints a code.');
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
	out(`forgot ${name}; the phone will be asked to pair again`);
	return 0;
}

async function doctor(): Promise<number> {
	const c = config();
	out(
		`config   ${c.configPath}${existsSync(c.configPath) ? '' : '  (missing — defaults; `ontoplano-chat config` writes one)'}`
	);
	out(`data     ${c.dataDir}`);
	let bad = 0;
	const tell = (what: string, problem: string | null): void => {
		out(`${problem ? '  ✗' : '  ✓'} ${what}${problem ? ` — ${problem}` : ''}`);
		if (problem) bad++;
	};
	for (const p of checkForServing(c)) tell('serving', p);
	const engines = buildEngines(c);
	tell(`model ${engines.llm.model} at ${c.llm.url}`, await engines.llm.check());
	tell(
		`ears ${engines.stt.kind}${engines.stt.kind === 'browser' ? ' (the phone recognises speech itself)' : ` at ${c.stt.url}`}`,
		await engines.stt.check()
	);
	tell(
		`voice ${engines.tts.kind}${engines.tts.kind === 'browser' ? ' (the phone speaks itself)' : ''}`,
		await engines.tts.check()
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
	out(`  ${paired ? '✓' : '·'} ${paired} phone${paired === 1 ? '' : 's'} paired`);
	out(bad ? `\n${bad} thing${bad === 1 ? '' : 's'} to fix.` : '\nAll good.');
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

export async function main(argv: string[]): Promise<number> {
	const [verb, ...rest] = argv;
	switch (verb) {
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
