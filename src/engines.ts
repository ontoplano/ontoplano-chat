/*
 * The four things the server talks to, built from the config — or faked,
 * when `ONTOPLANO_CHAT_ENGINES=fake` asks for a server that runs with nothing
 * installed.
 */
import type { Config } from './config.js';
import { TOOLS_REFRESH_MS } from './constants.js';
import { FAKE_TOOLS, FakeOntoplano, fakeLlm, fakeStt, fakeTts } from './fakes.js';
import type { Llm } from './llm.js';
import { openAiLlm } from './llm.js';
import { OntoplanoMcp, offeredTools, type McpTool } from './mcp.js';
import { browserStt, browserTts, httpStt, openAiTts, piperTts, type Stt, type Tts } from './speech.js';
import type { ToolCaller } from './turn.js';

export type Engines = {
	llm: Llm;
	stt: Stt;
	tts: Tts;
	mcp: ToolCaller & { listTools?: () => Promise<McpTool[]> };
	tools: ToolBox;
	fake: boolean;
};

/** The tools on offer, re-read from the app now and then, and nothing until the first read lands. */
export class ToolBox {
	private offered: McpTool[] = [];
	private all: McpTool[] = [];
	private timer: NodeJS.Timeout | null = null;
	lastError: string | null = null;
	loadedAt: Date | null = null;

	constructor(
		private readonly source: () => Promise<McpTool[]>,
		private readonly allow: readonly string[],
		private readonly descriptionChars: number,
		private readonly log: (line: string) => void = () => {}
	) {}

	current(): readonly McpTool[] {
		return this.offered;
	}

	/** Every tool the token grants, offered or not. */
	granted(): readonly McpTool[] {
		return this.all;
	}

	async load(): Promise<boolean> {
		try {
			this.all = await this.source();
			this.offered = offeredTools(this.all, this.allow, this.descriptionChars);
			this.loadedAt = new Date();
			this.lastError = null;
			this.log(`tools: ${this.offered.length} offered of ${this.all.length} granted`);
			return true;
		} catch (e) {
			this.lastError = (e as Error).message;
			this.log(`tools: not loaded — ${this.lastError}`);
			return false;
		}
	}

	/** Keep them fresh: hourly once loaded, every half minute until then. */
	start(): void {
		const tick = async (): Promise<void> => {
			const ok = await this.load();
			this.timer = setTimeout(tick, ok ? TOOLS_REFRESH_MS : 30_000);
			this.timer.unref();
		};
		void tick();
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
	}
}

export function buildEngines(
	c: Config,
	env: NodeJS.ProcessEnv = process.env,
	log: (l: string) => void = () => {}
): Engines {
	if (env.ONTOPLANO_CHAT_ENGINES === 'fake') {
		const mcp = new FakeOntoplano();
		return {
			llm: fakeLlm(),
			stt: fakeStt,
			tts: fakeTts,
			mcp,
			tools: new ToolBox(
				async () => FAKE_TOOLS,
				c.assistant.tools.length ? [...c.assistant.tools, 'remove_notebook'] : ['*'],
				c.llm.toolDescriptionChars,
				log
			),
			fake: true
		};
	}
	const mcp = new OntoplanoMcp(c.ontoplano.url, c.ontoplano.token);
	const llm = openAiLlm({
		url: c.llm.url,
		model: c.llm.model,
		apiKey: c.llm.apiKey,
		temperature: c.llm.temperature,
		timeoutMs: c.llm.timeoutMs
	});
	const stt: Stt =
		c.stt.kind === 'browser'
			? browserStt
			: httpStt({
					kind: c.stt.kind,
					url: c.stt.url,
					path: c.stt.path,
					model: c.stt.model,
					language: c.stt.language,
					apiKey: c.stt.apiKey,
					prompt: c.stt.prompt || `${c.assistant.name}. ontoplano.`
				});
	const tts: Tts =
		c.tts.kind === 'browser'
			? browserTts
			: c.tts.kind === 'piper'
				? piperTts({ command: c.tts.piperCommand, model: c.tts.piperModel })
				: openAiTts({ url: c.tts.url, model: c.tts.model, voice: c.tts.voice, apiKey: c.tts.apiKey });
	return {
		llm,
		stt,
		tts,
		mcp,
		tools: new ToolBox(() => mcp.listTools(), c.assistant.tools, c.llm.toolDescriptionChars, log),
		fake: false
	};
}
