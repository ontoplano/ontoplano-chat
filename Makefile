# ontoplano-chat — the local voice assistant.
#
#   make              what these commands are
#   make setup        install, build, write the config, check what is missing
#   make serve        run it here, in the foreground
#   make pair         a code for a phone
#   make doctor       is the model there, the ears, the voice, the app
#   make install-service   run it as a user service, from now on
#
# Defaults live in defaults.env, the one place to look.
include defaults.env

.DEFAULT_GOAL := help
.PHONY: help setup build link dev serve demo pair devices doctor config test test-unit test-e2e lint format icons install-service uninstall-service logs

help:
	@echo "ontoplano-chat — the local voice assistant for ontoplano"
	@echo
	@echo "  make setup             install, build, then the six questions (the model, the ears, the voice, the phone)"
	@echo "  make serve             run it here (Ctrl-C stops it)"
	@echo "  make demo              run it with fake engines — nothing installed, the screen can be looked at"
	@echo "  make pair              print a pairing code for a phone"
	@echo "  make devices           the paired phones"
	@echo "  make doctor            check the model, the ears, the voice and the app"
	@echo "  make install-service   run it as a user service from now on (make logs follows it)"
	@echo "  make test              unit tests, then the browser suite"
	@echo "  make lint              prettier, eslint, tsc"
	@echo
	@echo "  make link              put \`ontoplano-chat\` on your PATH (build does it too)"
	@echo
	@echo "  Switches: DEMO_PORT=$(DEMO_PORT) BIN_DIR=$(BIN_DIR)"

## install, build, and ask the six questions
setup: build
	@node bin/ontoplano-chat.mjs setup

build: link
	@[ -d node_modules ] || yarn install --frozen-lockfile
	@yarn -s build

## the command on your PATH: ~/.local/bin/ontoplano-chat → this checkout
link:
	@mkdir -p $(BIN_DIR)
	@ln -sfn $(CURDIR)/bin/ontoplano-chat.mjs $(BIN_DIR)/ontoplano-chat
	@case ":$$PATH:" in *":$(BIN_DIR):"*) ;; *) echo "  $(BIN_DIR) is not on your PATH: add it, or call $(CURDIR)/bin/ontoplano-chat.mjs";; esac

dev:
	@yarn -s dev

serve: build
	@node bin/ontoplano-chat.mjs serve

## run with fake engines, so the page can be looked at without a model, ears or voice
demo: build
	@mkdir -p $(DEMO_DIR)
	@printf '[server]\nport = $(DEMO_PORT)\n' > $(DEMO_DIR)/config.toml
	@ONTOPLANO_CHAT_ENGINES=fake ONTOPLANO_CHAT_DATA=$(DEMO_DIR) ONTOPLANO_CHAT_CONFIG=$(DEMO_DIR)/config.toml node bin/ontoplano-chat.mjs serve

pair: build
	@node bin/ontoplano-chat.mjs pair

devices: build
	@node bin/ontoplano-chat.mjs devices

doctor: build
	@node bin/ontoplano-chat.mjs doctor

config: build
	@node bin/ontoplano-chat.mjs config

test: test-unit test-e2e

test-unit:
	@yarn -s test:unit

test-e2e:
	@yarn -s test:e2e

lint:
	@yarn -s lint

format:
	@yarn -s format

icons:
	@node scripts/make-icons.mjs

## run as a systemd user service, enabled now and on every login
install-service: build
	@mkdir -p $(HOME)/.config/systemd/user
	@sed 's|%h/codes/ontoplano/ontoplano-chat|$(CURDIR)|' systemd/ontoplano-chat.service > $(HOME)/.config/systemd/user/ontoplano-chat.service
	@systemctl --user daemon-reload
	@systemctl --user enable --now ontoplano-chat
	@systemctl --user --no-pager status ontoplano-chat | head -5
	@echo
	@echo "  make logs follows it. loginctl enable-linger $$USER keeps it up when you are logged out."

uninstall-service:
	@systemctl --user disable --now ontoplano-chat || true
	@rm -f $(HOME)/.config/systemd/user/ontoplano-chat.service
	@systemctl --user daemon-reload

logs:
	@journalctl --user -u ontoplano-chat -f
