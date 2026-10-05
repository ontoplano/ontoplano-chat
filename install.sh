#!/bin/sh
# ontoplano-chat — install in one line, then answer six questions:
#
#   curl -fsSL https://github.com/ontoplano/ontoplano-chat/raw/master/install.sh | sh
#
# What it does: checks for git and Node 22+, clones (or updates) the
# repository into ~/.local/opt/ontoplano-chat, builds it, puts
# `ontoplano-chat` on your PATH (~/.local/bin), and runs `ontoplano-chat
# setup` — which asks where the model should run (this computer, or a
# company's API), the ears, the voice, the language, and how the phone
# reaches this computer, then prints a pairing code.
#
#   ONTOPLANO_CHAT_DIR=…    where to put it      (default ~/.local/opt/ontoplano-chat)
#   ONTOPLANO_CHAT_REPO=…   where to clone from  (default the GitHub repository)
#   ONTOPLANO_CHAT_NO_SETUP=1   install and build only
set -eu

REPO="${ONTOPLANO_CHAT_REPO:-https://github.com/ontoplano/ontoplano-chat.git}"
DIR="${ONTOPLANO_CHAT_DIR:-$HOME/.local/opt/ontoplano-chat}"
BIN="$HOME/.local/bin"
MIN_NODE=22

say() { printf '%s\n' "$*"; }
die() { printf 'ontoplano-chat: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is needed first (apt install git / brew install git)"
if ! command -v node >/dev/null 2>&1; then
	die "Node $MIN_NODE or newer is needed first — https://nodejs.org, your distribution's package, or nvm."
fi
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge "$MIN_NODE" ] || die "Node $MIN_NODE or newer is needed; this is $(node --version)."

# Run from inside a checkout, and that checkout is the one.
if [ -f ./package.json ] && [ -f ./bin/ontoplano-chat.mjs ] && grep -q '"name": "ontoplano-chat"' ./package.json 2>/dev/null; then
	DIR=$(pwd)
elif [ -d "$DIR/.git" ]; then
	say "→ updating $DIR"
	git -C "$DIR" pull --ff-only --quiet || die "could not update $DIR; is it dirty?"
else
	say "→ cloning into $DIR"
	mkdir -p "$(dirname "$DIR")"
	git clone --quiet "$REPO" "$DIR"
fi
cd "$DIR"

say "→ installing and building"
if command -v yarn >/dev/null 2>&1; then
	yarn install --frozen-lockfile --silent --non-interactive
	yarn -s build
else
	npm install --no-audit --no-fund --loglevel=error
	npm run -s build
fi

mkdir -p "$BIN"
ln -sfn "$DIR/bin/ontoplano-chat.mjs" "$BIN/ontoplano-chat"
case ":$PATH:" in
	*":$BIN:"*) ;;
	*) say "  (add $BIN to your PATH to call it as \`ontoplano-chat\`)" ;;
esac
say "✓ ontoplano-chat $(node bin/ontoplano-chat.mjs version) in $DIR"

if [ -n "${ONTOPLANO_CHAT_NO_SETUP:-}" ]; then
	say "  next: ontoplano-chat setup"
	exit 0
fi

# Piped into sh, stdin is the pipe; the questions need the terminal.
if [ -r /dev/tty ]; then
	exec node bin/ontoplano-chat.mjs setup </dev/tty
else
	say "  no terminal to ask on — run: ontoplano-chat setup"
fi
