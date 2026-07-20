#!/bin/bash
# Dev launcher: uses the project-local Node 22 (system node 18 is too old for
# Electron 43 tooling) and starts the Electron app. The app spawns the sidecar
# itself if it isn't already running.
cd "$(dirname "$0")" || exit 1
export PATH="$PWD/.tools/node/bin:$PATH"
# machine-local overrides (gitignored), e.g. STEMAPP_PYTHON for a venv that
# lives outside the repo
[ -f dev.local.sh ] && . ./dev.local.sh
# otherwise prefer the self-contained env created by setup.sh
if [ -z "$STEMAPP_PYTHON" ] && [ -x .venv-sidecar/bin/python ]; then
  export STEMAPP_PYTHON="$PWD/.venv-sidecar/bin/python"
  export STEMAPP_TOOLS_BIN="$PWD/.venv-sidecar/bin"
fi
exec npm start
