/*
 * The phone's side: hold the bar, speak, watch it happen.
 *
 * One page, no framework. The server streams each turn as lines of JSON —
 * the transcript, each action as it runs, the reply, the voice — and this
 * draws them as they arrive. The device token lives in localStorage and goes
 * on every call as a bearer; a 401 means the phone was forgotten and the
 * pairing screen comes back.
 */
import { setLanguage, t } from './strings.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'onto.token';
const DEVICE_KEY = 'onto.device';
const SPEAK_KEY = 'onto.speak';
const EARS_KEY = 'onto.browserEars';
/** A press shorter than this is a tap: the bar stays listening until tapped again. */
const TAP_MS = 350;
/** A hold is sent on release; a tap-started recording stops itself after this long. */
const MAX_RECORD_MS = 60_000;
/** The second step of "forget" ignores presses for this long, so a double-press cannot confirm itself. */
const ARM_MS = 450;

const pref = {
	get(key, fallback) {
		try {
			const v = localStorage.getItem(key);
			return v === null ? fallback : v;
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			if (value === null) localStorage.removeItem(key);
			else localStorage.setItem(key, value);
		} catch {
			// private mode, cleared storage: the page still works for this visit
		}
	}
};

const state = {
	me: null,
	busy: false,
	recorder: null,
	stream: null,
	chunks: [],
	pressedAt: 0,
	tapMode: false,
	recordTimer: null,
	recordTick: null,
	recognition: null,
	audio: null,
	pendingAsk: null
};

/* ---------- the server ---------- */

async function api(path, options = {}) {
	const headers = Object.assign({}, options.headers || {});
	const token = pref.get(TOKEN_KEY, null);
	if (token) headers.Authorization = `Bearer ${token}`;
	let res;
	try {
		res = await fetch(path, Object.assign({}, options, { headers }));
	} catch {
		throw new Error('offline');
	}
	if (res.status === 401) {
		unpair();
		throw new Error('unauthorized');
	}
	return res;
}

function unpair() {
	pref.set(TOKEN_KEY, null);
	pref.set(DEVICE_KEY, null);
	state.me = null;
	showPair();
}

/* ---------- screens ---------- */

function showPair() {
	$('toggleVoice').hidden = true;
	$('screenPair').hidden = false;
	$('screenChat').hidden = true;
	$('composer').hidden = true;
	$('status').textContent = '';
	setTimeout(() => $('pairCode').focus(), 0);
}

async function showChat() {
	let res;
	try {
		res = await api('/api/me');
	} catch (e) {
		if (e.message === 'unauthorized') return;
		$('status').textContent = t('status.offline');
		$('screenPair').hidden = true;
		$('screenChat').hidden = false;
		$('composer').hidden = false;
		return;
	}
	state.me = await res.json();
	setLanguage(state.me.assistant.language);
	$('toggleVoice').hidden = false;
	updateVoiceToggle();
	$('assistantName').textContent = state.me.assistant.name;
	document.title = state.me.assistant.name;
	$('status').textContent = '';
	$('screenPair').hidden = true;
	$('screenChat').hidden = false;
	$('composer').hidden = false;
	if (state.me.pending && !state.pendingAsk) {
		const turn = addBotTurn();
		turn.bubble.remove();
		drawAsk(turn, state.me.pending.id, state.me.pending.question);
	}
	$('talk').disabled = false;
}

/* ---------- pairing ---------- */

$('pairForm').addEventListener('submit', async (event) => {
	event.preventDefault();
	const code = $('pairCode').value.replace(/\D/g, '');
	const name = $('pairName').value.trim();
	const error = $('pairError');
	error.textContent = ' ';
	const button = event.target.querySelector('button');
	button.disabled = true;
	try {
		const res = await api('/api/pair', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, name })
		});
		const body = await res.json();
		if (!res.ok) {
			const reasons = {
				'pair-wrong': 'pair.wrong',
				'pair-expired': 'pair.expired',
				'pair-burned': 'pair.burned',
				'pair-no-code': 'pair.none',
				'pair-name': 'pair.name.missing',
				'slow-down': 'pair.slow'
			};
			error.textContent = t(reasons[body.error] || 'pair.wrong');
			return;
		}
		pref.set(TOKEN_KEY, body.token);
		pref.set(DEVICE_KEY, body.device.name);
		$('pairCode').value = '';
		await showChat();
	} catch (e) {
		error.textContent = t(e.message === 'offline' ? 'pair.offline' : 'pair.wrong');
	} finally {
		button.disabled = false;
	}
});

/* ---------- the conversation ---------- */

const log = $('log');

function scrollDown() {
	const screen = $('screenChat');
	screen.scrollTop = screen.scrollHeight;
}

function addMeTurn(text, heard) {
	$('empty').hidden = true;
	const li = document.createElement('li');
	li.className = 'turn me';
	const bubble = document.createElement('div');
	bubble.className = 'bubble' + (heard ? ' heard' : '');
	bubble.textContent = text;
	li.appendChild(bubble);
	log.appendChild(li);
	scrollDown();
	return bubble;
}

function addBotTurn() {
	$('empty').hidden = true;
	const li = document.createElement('li');
	li.className = 'turn bot';
	const actions = document.createElement('div');
	actions.className = 'actions';
	const bubble = document.createElement('div');
	bubble.className = 'bubble thinking';
	li.append(actions, bubble);
	log.appendChild(li);
	scrollDown();
	return { li, actions, bubble, chips: new Map() };
}

function icon(name) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('class', 'icon');
	const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
	use.setAttribute('href', `#${name}`);
	svg.appendChild(use);
	return svg;
}

function drawAction(turn, event) {
	let chip = turn.chips.get(event.id);
	const link = event.status === 'done' && event.link;
	const fresh = link ? document.createElement('a') : document.createElement('span');
	if (link) {
		fresh.href = link;
		fresh.target = '_blank';
		fresh.rel = 'noopener';
	}
	fresh.className = `chip ${event.status}`;
	fresh.appendChild(icon(event.status === 'running' ? 'i-gear' : event.status === 'done' ? 'i-check' : 'i-x'));
	const label = document.createElement('span');
	label.textContent = event.summary || event.name.replace(/_/g, ' ');
	fresh.appendChild(label);
	if (link) fresh.appendChild(icon('i-link'));
	fresh.title = JSON.stringify(event.args);
	if (chip) chip.replaceWith(fresh);
	else turn.actions.appendChild(fresh);
	turn.chips.set(event.id, fresh);
	scrollDown();
}

function drawAsk(turn, id, question) {
	const ask = document.createElement('div');
	ask.className = 'ask';
	const q = document.createElement('span');
	q.textContent = question;
	const yes = document.createElement('button');
	yes.type = 'button';
	yes.className = 'btn primary';
	yes.textContent = t('chat.yes');
	const no = document.createElement('button');
	no.type = 'button';
	no.className = 'btn';
	no.textContent = t('chat.no');
	ask.append(q, yes, no);
	turn.li.appendChild(ask);
	state.pendingAsk = { id, element: ask };
	const answer = (value) => {
		if (!state.pendingAsk || state.pendingAsk.id !== id) return;
		settleAsk(value);
		runTurn('/api/confirm', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, yes: value, speak: voiceEnabled() })
		});
	};
	yes.addEventListener('click', () => answer(true));
	no.addEventListener('click', () => answer(false));
	scrollDown();
}

/** The question is answered: it stays on screen, greyed, and its buttons keep their room. */
function settleAsk(value) {
	if (!state.pendingAsk) return;
	const el = state.pendingAsk.element;
	el.classList.add('answered');
	el.firstChild.textContent += ` — ${t(value ? 'chat.yes' : 'chat.no')}`;
	state.pendingAsk = null;
}

function errorText(message) {
	const known = {
		'nothing-heard': 'chat.nothing-heard',
		'nothing-said': 'chat.nothing-said',
		'nothing-pending': 'chat.nothing-pending'
	};
	return known[message] ? t(known[message]) : message;
}

function setBusy(busy) {
	state.busy = busy;
	$('talk').disabled = busy;
	$('text').disabled = busy;
	$('status').textContent = busy ? t('chat.working') : '';
}

/** Send a turn and draw what comes back, line by line. */
async function runTurn(path, options, meBubble) {
	if (state.busy) return;
	setBusy(true);
	const turn = addBotTurn();
	try {
		const res = await api(path, options);
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			turn.bubble.className = 'bubble error';
			turn.bubble.textContent =
				t(res.status === 429 ? 'chat.slow' : 'chat.offline') + (body.message ? ` (${body.message})` : '');
			return;
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buffered.indexOf('\n')) >= 0) {
				const line = buffered.slice(0, nl).trim();
				buffered = buffered.slice(nl + 1);
				if (line) handle(JSON.parse(line), turn, meBubble);
			}
		}
	} catch (e) {
		if (e.message === 'unauthorized') return;
		turn.bubble.className = 'bubble error';
		turn.bubble.textContent = t('chat.offline');
	} finally {
		if (turn.bubble.classList.contains('thinking')) turn.bubble.remove();
		setBusy(false);
	}
}

function handle(event, turn, meBubble) {
	switch (event.type) {
		case 'transcript':
			if (meBubble) meBubble.textContent = event.text || '…';
			break;
		case 'thinking':
			break;
		case 'action':
			drawAction(turn, event);
			break;
		case 'confirm':
			turn.bubble.remove();
			drawAsk(turn, event.id, event.question);
			break;
		case 'reply':
			turn.bubble.className = 'bubble';
			turn.bubble.textContent = event.text;
			speak(event.text);
			scrollDown();
			break;
		case 'audio':
			play(event.mime, event.base64);
			break;
		case 'error': {
			// Nothing was heard: the waiting "…" has nothing to become.
			if (meBubble && meBubble.textContent === '…') meBubble.parentElement.remove();
			// A reply already drawn stays; the error goes under it, never over it.
			const replied = turn.bubble.isConnected && !turn.bubble.classList.contains('thinking');
			const bubble = turn.bubble.isConnected && !replied ? turn.bubble : document.createElement('div');
			bubble.className = 'bubble error';
			bubble.textContent = errorText(event.message);
			if (!bubble.isConnected) turn.li.appendChild(bubble);
			scrollDown();
			break;
		}
		case 'done':
			break;
	}
}

function sendText(text) {
	stopVoice();
	const clean = text.trim();
	if (!clean) return;
	addMeTurn(clean, false);
	runTurn('/api/turn', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text: clean, speak: voiceEnabled() })
	});
}

function sendHeard(text) {
	stopVoice();
	const clean = text.trim();
	if (!clean) return;
	const bubble = addMeTurn(clean, true);
	runTurn(
		'/api/turn',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: clean, speak: voiceEnabled() })
		},
		bubble
	);
}

function sendAudio(blob, mime) {
	stopVoice();
	const bubble = addMeTurn('…', true);
	runTurn(
		`/api/turn?speak=${voiceEnabled() ? '1' : '0'}`,
		{ method: 'POST', headers: { 'Content-Type': mime }, body: blob },
		bubble
	);
}

$('typed').addEventListener('submit', (event) => {
	event.preventDefault();
	const input = $('text');
	sendText(input.value);
	input.value = '';
});

/* ---------- the voice ---------- */

const voiceEnabled = () => pref.get(SPEAK_KEY, '1') === '1';

function updateVoiceToggle() {
	const on = voiceEnabled();
	const button = $('toggleVoice');
	button.setAttribute('aria-pressed', String(on));
	button.querySelector('use').setAttribute('href', on ? '#i-speaker' : '#i-muted');
	button.title = t(on ? 'chat.voice.on' : 'chat.voice.off');
	button.setAttribute('aria-label', button.title);
	$('speakReplies').checked = on;
}

function setVoiceEnabled(on) {
	pref.set(SPEAK_KEY, on ? '1' : '0');
	if (!on) stopVoice();
	updateVoiceToggle();
}

$('toggleVoice').addEventListener('click', () => setVoiceEnabled(!voiceEnabled()));

/** The voice is talking: the bar says so, and pressing it cuts the voice off. */
function voiceStarted() {
	if (!isListening()) $('talkLabel').textContent = t('chat.speaking');
}

function voiceEnded() {
	if (!isListening() && $('talkLabel').textContent === t('chat.speaking')) $('talkLabel').textContent = t('chat.hold');
}

const isSpeaking = () =>
	Boolean(state.audio && !state.audio.paused && !state.audio.ended) ||
	('speechSynthesis' in window && speechSynthesis.speaking);

/** Cut the voice off, wherever it is coming from. */
function stopVoice() {
	if (state.audio) {
		state.audio.pause();
		state.audio = null;
	}
	if ('speechSynthesis' in window) speechSynthesis.cancel();
	voiceEnded();
}

function speak(text) {
	if (!state.me || state.me.tts !== 'browser') return;
	if (!voiceEnabled()) return;
	if (!('speechSynthesis' in window)) return;
	speechSynthesis.cancel();
	const u = new SpeechSynthesisUtterance(text);
	u.lang = state.me.assistant.language;
	const voices = speechSynthesis.getVoices();
	const tag = u.lang.toLowerCase();
	const family = tag.split('-')[0];
	const voice =
		voices.find((v) => v.lang.toLowerCase() === tag && v.localService) ??
		voices.find((v) => v.lang.toLowerCase() === tag) ??
		voices.find((v) => v.lang.toLowerCase().startsWith(family) && v.localService);
	if (voice) u.voice = voice;
	u.onstart = voiceStarted;
	u.onend = voiceEnded;
	speechSynthesis.speak(u);
}

function play(mime, base64) {
	if (!voiceEnabled()) return;
	stopVoice();
	const audio = new Audio(`data:${mime};base64,${base64}`);
	state.audio = audio;
	audio.addEventListener('playing', voiceStarted);
	audio.addEventListener('ended', () => {
		if (state.audio === audio) state.audio = null;
		voiceEnded();
	});
	audio.play().catch(() => {});
}

/* ---------- the ears ---------- */

const usesBrowserEars = () => (state.me && state.me.stt === 'browser') || pref.get(EARS_KEY, '0') === '1';

function recordingMime() {
	if (typeof MediaRecorder === 'undefined') return null;
	for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'])
		if (MediaRecorder.isTypeSupported(m)) return m;
	return '';
}

async function startListening() {
	const talk = $('talk');
	if (usesBrowserEars()) return startRecognition();
	if (!window.isSecureContext) {
		flash(t('chat.mic.insecure'));
		return false;
	}
	try {
		if (!state.stream) state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		flash(t('chat.mic.denied'));
		return false;
	}
	const mime = recordingMime();
	if (mime === null) {
		flash(t('chat.mic.denied'));
		return false;
	}
	state.chunks = [];
	state.recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
	state.recorder.ondataavailable = (e) => {
		if (e.data.size) state.chunks.push(e.data);
	};
	state.recorder.onstop = () => {
		const type = state.recorder.mimeType || mime || 'audio/webm';
		const blob = new Blob(state.chunks, { type });
		state.recorder = null;
		if (blob.size > 0) sendAudio(blob, type.split(';')[0]);
	};
	state.recorder.start();
	talk.setAttribute('aria-pressed', 'true');
	startTimer();
	return true;
}

function stopListening() {
	const talk = $('talk');
	talk.setAttribute('aria-pressed', 'false');
	stopTimer();
	if (state.recognition) {
		state.recognition.stop();
		return;
	}
	if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

function startRecognition() {
	const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Recognition) {
		flash(t('chat.mic.denied'));
		return false;
	}
	const r = new Recognition();
	r.lang = state.me ? state.me.assistant.language : navigator.language;
	r.interimResults = false;
	r.maxAlternatives = 1;
	let heard = '';
	r.onresult = (e) => {
		heard = Array.from(e.results)
			.map((x) => x[0].transcript)
			.join(' ');
	};
	r.onerror = () => {};
	r.onend = () => {
		state.recognition = null;
		$('talk').setAttribute('aria-pressed', 'false');
		stopTimer();
		if (heard) sendHeard(heard);
		else flash(t('chat.nothing-heard'));
	};
	state.recognition = r;
	r.start();
	$('talk').setAttribute('aria-pressed', 'true');
	startTimer();
	return true;
}

function startTimer() {
	const started = Date.now();
	const timer = $('talkTimer');
	timer.textContent = '0s';
	state.recordTick = setInterval(() => (timer.textContent = `${Math.round((Date.now() - started) / 1000)}s`), 500);
	state.recordTimer = setTimeout(() => stopListening(), MAX_RECORD_MS);
}

function stopTimer() {
	clearInterval(state.recordTick);
	clearTimeout(state.recordTimer);
	$('talkTimer').textContent = '';
	$('talkLabel').textContent = t('chat.hold');
}

function flash(text) {
	const status = $('status');
	status.textContent = text;
	setTimeout(() => {
		if (status.textContent === text) status.textContent = '';
	}, 4000);
}

const talk = $('talk');
const isListening = () => talk.getAttribute('aria-pressed') === 'true';

talk.addEventListener('pointerdown', async (e) => {
	if (talk.disabled) return;
	e.preventDefault();
	talk.setPointerCapture(e.pointerId);
	// Talking over it cuts it off — and a hold goes straight on to listening.
	if (isSpeaking()) stopVoice();
	if (isListening()) {
		// A tap while listening (tap mode) sends.
		state.tapMode = false;
		stopListening();
		return;
	}
	state.pressedAt = Date.now();
	state.tapMode = false;
	const ok = await startListening();
	if (ok) $('talkLabel').textContent = t('chat.listening');
});
talk.addEventListener('pointerup', (e) => {
	e.preventDefault();
	if (!isListening()) return;
	if (Date.now() - state.pressedAt < TAP_MS) {
		state.tapMode = true;
		$('talkLabel').textContent = t('chat.tap.listening');
		return;
	}
	stopListening();
});
talk.addEventListener('pointercancel', () => {
	if (isListening() && !state.tapMode) stopListening();
});

window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && isSpeaking()) {
		stopVoice();
		return;
	}
	const tag = (e.target.tagName || '').toLowerCase();
	if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
	if (e.key === ' ' && !talk.disabled && state.me) {
		e.preventDefault();
		if (isListening()) stopListening();
		else {
			state.pressedAt = 0;
			state.tapMode = true;
			startListening().then((ok) => {
				if (ok) $('talkLabel').textContent = t('chat.tap.listening');
			});
		}
	}
	if (e.key === 'y' && state.pendingAsk) state.pendingAsk.element.querySelector('.btn.primary').click();
	if (e.key === 'n' && state.pendingAsk) state.pendingAsk.element.querySelectorAll('.btn')[1].click();
});

document.addEventListener('visibilitychange', () => {
	if (document.hidden && state.stream) {
		for (const track of state.stream.getTracks()) track.stop();
		state.stream = null;
		if (isListening()) stopListening();
	}
});

/* ---------- settings ---------- */

const settings = $('settings');
$('openSettings').addEventListener('click', () => openSettings());
$('closeSettings').addEventListener('click', () => settings.close());

async function openSettings() {
	updateVoiceToggle();
	$('browserEars').checked = pref.get(EARS_KEY, '0') === '1';
	$('browserEars').parentElement.hidden = !state.me || state.me.stt === 'browser';
	$('forget').hidden = false;
	$('forgetReally').hidden = true;
	$('version').textContent = state.me ? `ontoplano-chat ${state.me.version}` : '';
	const facts = $('facts');
	facts.textContent = '';
	$('toolDetails').hidden = true;
	const row = (key, value, bad) => {
		const dt = document.createElement('dt');
		dt.textContent = t(key);
		const dd = document.createElement('dd');
		dd.textContent = value;
		if (bad) dd.className = 'bad';
		facts.append(dt, dd);
	};
	if (state.me) {
		row('settings.device', state.me.device.name);
		row('settings.app', state.me.app);
		row('settings.model', t('settings.checking'));
		row('settings.ears', t('settings.checking'));
		row('settings.voice', t('settings.checking'));
		row('settings.tools', t('settings.checking'));
	}
	settings.showModal();
	if (!state.me) return;
	try {
		const res = await api('/api/status');
		const s = await res.json();
		const dds = facts.querySelectorAll('dd');
		const say = (dd, value, problem) => {
			dd.textContent = problem ? `${value} — ${problem}` : value;
			dd.className = problem ? 'bad' : '';
		};
		say(dds[2], s.llm.model, s.llm.problem);
		say(dds[3], s.stt.kind === 'browser' ? t('settings.browser') : s.stt.about, s.stt.problem);
		say(dds[4], s.tts.kind === 'browser' ? t('settings.browser') : s.tts.about, s.tts.problem);
		say(dds[5], `${s.tools.offered} / ${s.tools.granted}`, s.tools.problem);
		$('toolNames').textContent = s.tools.names.join(', ');
		$('toolDetails').hidden = !s.tools.names.length;
	} catch {
		// the sheet still shows what it knows
	}
}

$('speakReplies').addEventListener('change', (e) => setVoiceEnabled(e.target.checked));
$('browserEars').addEventListener('change', (e) => pref.set(EARS_KEY, e.target.checked ? '1' : '0'));

$('forget').addEventListener('click', () => {
	$('forget').hidden = true;
	const really = $('forgetReally');
	really.hidden = false;
	really.dataset.armedAt = String(Date.now());
});
$('forgetReally').addEventListener('click', async (e) => {
	if (Date.now() - Number(e.target.dataset.armedAt || 0) < ARM_MS) return;
	try {
		await api('/api/forget', { method: 'POST' });
	} catch {
		// forgotten locally either way
	}
	settings.close();
	log.textContent = '';
	$('empty').hidden = false;
	unpair();
});

const history = $('history');
$('showHistory').addEventListener('click', async () => {
	settings.close();
	const list = $('historyList');
	list.textContent = '';
	try {
		const res = await api('/api/history');
		const body = await res.json();
		if (!body.turns.length) {
			const li = document.createElement('li');
			li.textContent = t('history.empty');
			list.appendChild(li);
		}
		for (const turn of body.turns) {
			const li = document.createElement('li');
			const time = document.createElement('time');
			time.dateTime = turn.at;
			time.textContent = new Date(turn.at).toLocaleString();
			const heard = document.createElement('div');
			heard.textContent = `› ${turn.heard}`;
			li.append(time, heard);
			for (const a of turn.actions) {
				const line = document.createElement('div');
				line.className = 'muted';
				line.textContent = `${a.ok ? '✓' : '✗'} ${a.summary}`;
				li.appendChild(line);
			}
			if (turn.asked) {
				const line = document.createElement('div');
				line.className = 'muted';
				line.textContent = `? ${t('history.asked')}: ${turn.asked}`;
				li.appendChild(line);
			}
			if (turn.reply) {
				const reply = document.createElement('div');
				reply.textContent = turn.reply;
				li.appendChild(reply);
			}
			if (turn.error) {
				const err = document.createElement('div');
				err.className = 'error';
				err.textContent = errorText(turn.error);
				li.appendChild(err);
			}
			list.appendChild(li);
		}
	} catch {
		// nothing to show
	}
	history.showModal();
});
$('closeHistory').addEventListener('click', () => history.close());

/* ---------- start ---------- */

setLanguage(navigator.language);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (pref.get(TOKEN_KEY, null)) showChat();
else showPair();
