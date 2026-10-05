import { describe, expect, it } from 'vitest';

import { checkForServing, exampleConfig, fromToml, normalizeUrl, ConfigError } from '../src/config.js';
import { DEFAULT_PORT, DEFAULT_TOOLS } from '../src/constants.js';

const env = { HOME: '/home/x' } as NodeJS.ProcessEnv;

describe('config', () => {
	it('an empty file is the defaults', () => {
		const c = fromToml('', env);
		expect(c.server.port).toBe(DEFAULT_PORT);
		expect(c.server.host).toBe('127.0.0.1');
		expect(c.assistant.tools).toEqual(DEFAULT_TOOLS);
		expect(c.tts.kind).toBe('browser');
	});

	it('what the file says wins, and trailing slashes go', () => {
		const c = fromToml(
			`[server]\nport = 2000\npublic_url = "https://onto.example/"\n[ontoplano]\nurl = "https://my.app/"\ntoken = "abc"\n[llm]\nmodel = "x:1b"\n[assistant]\ntools = ["*"]\nlanguage = "en-GB"`,
			env
		);
		expect(c.server.port).toBe(2000);
		expect(c.server.publicUrl).toBe('https://onto.example');
		expect(c.ontoplano.url).toBe('https://my.app');
		expect(c.ontoplano.token).toBe('abc');
		expect(c.llm.model).toBe('x:1b');
		expect(c.assistant.tools).toEqual(['*']);
		expect(c.assistant.language).toBe('en-GB');
	});

	it('the environment overrides the token', () => {
		const c = fromToml(`[ontoplano]\ntoken = "file"`, { ...env, ONTOPLANO_MCP_TOKEN: 'env' });
		expect(c.ontoplano.token).toBe('env');
	});

	it('an address typed without a scheme is http', () => {
		expect(normalizeUrl('127.0.0.1:7749')).toBe('http://127.0.0.1:7749');
		expect(normalizeUrl('https://x.example/')).toBe('https://x.example');
		expect(normalizeUrl('  ')).toBe('');
		const c = fromToml(`[stt]\nurl = "127.0.0.1:7749"\n[tts]\nkind = "openai"\nurl = "localhost:8888/"`, env);
		expect(c.stt.url).toBe('http://127.0.0.1:7749');
		expect(c.tts.url).toBe('http://localhost:8888');
	});

	it('an address that is not one is named before serving', () => {
		const problems = checkForServing(fromToml(`[ontoplano]\ntoken = "t"\n[stt]\nurl = "http://not a host"`, env));
		expect(problems.join(' ')).toMatch(/stt.url: "http:\/\/not a host" is not an address/);
	});

	it('whisper.cpp gets its own path by default', () => {
		expect(fromToml(`[stt]\nkind = "whispercpp"`, env).stt.path).toBe('/inference');
		expect(fromToml(`[stt]\nkind = "openai"`, env).stt.path).toBe('/v1/audio/transcriptions');
	});

	it('refuses a kind it does not know, and bad TOML', () => {
		expect(() => fromToml(`[stt]\nkind = "cloud"`, env)).toThrow(ConfigError);
		expect(() => fromToml(`[tts]\nkind = "siri"`, env)).toThrow(ConfigError);
		expect(() => fromToml(`[server\nport = 1`, env)).toThrow(ConfigError);
	});

	it('the example config parses to the defaults', () => {
		const c = fromToml(exampleConfig(), env);
		expect(c.server.port).toBe(DEFAULT_PORT);
		expect(c.assistant.tools).toEqual(DEFAULT_TOOLS);
	});
});

describe('serving', () => {
	const base = `[ontoplano]\ntoken = "t"\n`;

	it('loopback without TLS is fine', () => {
		expect(checkForServing(fromToml(base, env))).toEqual([]);
	});

	it('a network address without TLS is refused', () => {
		const problems = checkForServing(fromToml(base + `[server]\nhost = "0.0.0.0"`, env));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/no TLS/);
	});

	it('…unless said on purpose', () => {
		expect(checkForServing(fromToml(base + `[server]\nhost = "0.0.0.0"\ninsecure = true`, env))).toEqual([]);
	});

	it('TLS files must exist', () => {
		const problems = checkForServing(fromToml(base + `[server.tls]\ncert = "/nope.pem"\nkey = "/nope.key"`, env));
		expect(problems.join(' ')).toMatch(/no file at \/nope.pem/);
	});

	it('an empty token is named', () => {
		expect(checkForServing(fromToml('', env)).join(' ')).toMatch(/ontoplano.token is empty/);
	});
});
