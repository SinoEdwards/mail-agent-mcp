#!/usr/bin/env sh
# Compatibility wrapper. Public releases do not pipe remote scripts into a shell.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"
exec sh ./install.sh
