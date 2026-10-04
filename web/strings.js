/*
 * Every word the phone shows, in the languages the assistant speaks. The
 * language is the server's `assistant.language` once paired; before that,
 * the phone's own.
 */
export const STRINGS = {
	en: {
		'pair.title': 'Pair this phone',
		'pair.lead': 'Run ontoplano-chat pair on the computer and type the code it prints.',
		'pair.code': 'Code',
		'pair.name': "This phone's name",
		'pair.go': 'Pair',
		'pair.wrong': 'That is not the code.',
		'pair.expired': 'That code has expired. Print another with ontoplano-chat pair.',
		'pair.burned': 'Too many wrong tries; that code is gone. Print another.',
		'pair.none': 'No code is waiting. Run ontoplano-chat pair on the computer.',
		'pair.name.missing': 'Give the phone a name.',
		'pair.slow': 'Too many tries. Wait a few minutes.',
		'pair.offline': 'Cannot reach the server.',
		'chat.empty': 'Hold the bar and say something.',
		'chat.hold': 'Hold to talk',
		'chat.listening': 'Listening — release to send',
		'chat.tap.listening': 'Listening — tap to send',
		'chat.working': 'Working…',
		'chat.type': 'Or type…',
		'chat.send': 'Send',
		'chat.yes': 'Yes',
		'chat.no': 'No',
		'chat.heard': 'Heard',
		'chat.nothing-heard': 'I did not catch that.',
		'chat.nothing-said': 'Nothing was said.',
		'chat.nothing-pending': 'Nothing was waiting for an answer.',
		'chat.mic.denied': 'The microphone is not allowed. Allow it for this site, or type.',
		'chat.mic.insecure': 'The microphone only opens on https. Type instead, or open the https address.',
		'chat.offline': 'Cannot reach the server.',
		'chat.unauthorized': 'This phone is no longer paired.',
		'chat.slow': 'Too fast. Give it a moment.',
		'status.ready': '',
		'status.offline': 'offline',
		settings: 'Settings',
		'settings.title': 'This assistant',
		'settings.model': 'Model',
		'settings.ears': 'Ears',
		'settings.voice': 'Voice',
		'settings.tools': 'Tools',
		'settings.device': 'This phone',
		'settings.app': 'App',
		'settings.speak': 'Read replies aloud',
		'settings.browserEars': "Recognise speech on this phone (goes through the browser's recogniser)",
		'settings.history': 'What was done',
		'settings.forget': 'Forget this phone',
		'settings.forgetReally': 'Really forget',
		'settings.close': 'Close',
		'settings.checking': 'checking…',
		'settings.fine': 'fine',
		'settings.browser': 'this phone',
		'history.title': 'What was done',
		'history.empty': 'Nothing yet.',
		'history.asked': 'asked',
		'history.declined': 'declined'
	},
	pt: {
		'pair.title': 'Parear este telefone',
		'pair.lead': 'Rode ontoplano-chat pair no computador e digite o código que ele mostra.',
		'pair.code': 'Código',
		'pair.name': 'Nome deste telefone',
		'pair.go': 'Parear',
		'pair.wrong': 'Esse não é o código.',
		'pair.expired': 'Esse código venceu. Gere outro com ontoplano-chat pair.',
		'pair.burned': 'Erros demais; esse código já era. Gere outro.',
		'pair.none': 'Não há código esperando. Rode ontoplano-chat pair no computador.',
		'pair.name.missing': 'Dê um nome ao telefone.',
		'pair.slow': 'Tentativas demais. Espere alguns minutos.',
		'pair.offline': 'Não consigo falar com o servidor.',
		'chat.empty': 'Segure a barra e fale.',
		'chat.hold': 'Segure para falar',
		'chat.listening': 'Ouvindo — solte para enviar',
		'chat.tap.listening': 'Ouvindo — toque para enviar',
		'chat.working': 'Trabalhando…',
		'chat.type': 'Ou escreva…',
		'chat.send': 'Enviar',
		'chat.yes': 'Sim',
		'chat.no': 'Não',
		'chat.heard': 'Ouvi',
		'chat.nothing-heard': 'Não entendi.',
		'chat.nothing-said': 'Nada foi dito.',
		'chat.nothing-pending': 'Nada estava esperando resposta.',
		'chat.mic.denied': 'O microfone não está liberado. Libere para este site, ou escreva.',
		'chat.mic.insecure': 'O microfone só abre em https. Escreva, ou abra o endereço https.',
		'chat.offline': 'Não consigo falar com o servidor.',
		'chat.unauthorized': 'Este telefone não está mais pareado.',
		'chat.slow': 'Rápido demais. Espere um instante.',
		'status.ready': '',
		'status.offline': 'sem conexão',
		settings: 'Configurações',
		'settings.title': 'Este assistente',
		'settings.model': 'Modelo',
		'settings.ears': 'Ouvidos',
		'settings.voice': 'Voz',
		'settings.tools': 'Ferramentas',
		'settings.device': 'Este telefone',
		'settings.app': 'App',
		'settings.speak': 'Ler as respostas em voz alta',
		'settings.browserEars': 'Reconhecer a fala neste telefone (passa pelo reconhecedor do navegador)',
		'settings.history': 'O que foi feito',
		'settings.forget': 'Esquecer este telefone',
		'settings.forgetReally': 'Esquecer mesmo',
		'settings.close': 'Fechar',
		'settings.checking': 'verificando…',
		'settings.fine': 'ok',
		'settings.browser': 'este telefone',
		'history.title': 'O que foi feito',
		'history.empty': 'Nada ainda.',
		'history.asked': 'perguntou',
		'history.declined': 'recusado'
	}
};

let current = 'en';

export function setLanguage(tag) {
	const key = String(tag || 'en')
		.toLowerCase()
		.split(/[-_]/)[0];
	current = STRINGS[key] ? key : 'en';
	document.documentElement.lang = tag || current;
	for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
	for (const el of document.querySelectorAll('[data-placeholder]')) el.placeholder = t(el.dataset.placeholder);
	for (const el of document.querySelectorAll('[data-title]')) el.title = t(el.dataset.title);
	for (const el of document.querySelectorAll('[data-label]')) el.setAttribute('aria-label', t(el.dataset.label));
	return current;
}

export function t(key) {
	return STRINGS[current][key] ?? STRINGS.en[key] ?? key;
}

export function language() {
	return current;
}
