#!/bin/bash
# Duplo clique abre o painel local de stories.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:/opt/homebrew/bin:$PATH"
open http://127.0.0.1:4750
exec node painel/server.mjs
