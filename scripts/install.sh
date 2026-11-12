#!/bin/sh
# Install pidea with the Node.js that pi runs on, then add it to the IDE (`pidea setup`).
# No global npm install and no sudo: pidea goes to ~/.pi/pidea, a `pidea` command to ~/.local/bin.
#
#   curl -fsSL https://github.com/JohannesKaminski/pidea/releases/latest/download/install.sh | sh
#
# Arguments are passed to `pidea setup`, e.g. `sh -s -- --name pidea-test`.
# PIDEA_VERSION=0.2.0 installs that release instead of the latest one.
# PIDEA_TARBALL, PIDEA_PREFIX and PIDEA_BIN_DIR override the tarball and the two folders.
set -eu

repo=https://github.com/JohannesKaminski/pidea
prefix=${PIDEA_PREFIX:-$HOME/.pi/pidea}
bin_dir=${PIDEA_BIN_DIR:-$HOME/.local/bin}
marker='# Written by the pidea installer.'
original_path=$PATH

fail() {
  printf 'pidea install: %s\n' "$1" >&2
  exit 1
}

case $(uname -s) in
  Linux | Darwin) ;;
  *) fail 'this installer supports macOS and Linux. On Windows, follow the README.' ;;
esac

# The same lookup as pi's own launcher: the Node.js pi's installer set up, else node on PATH.
pi_node_bin=${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin
if [ -x "$pi_node_bin/node" ]; then
  node_bin=$pi_node_bin
elif node_path=$(command -v node 2>/dev/null); then
  node_bin=$(dirname "$node_path")
else
  fail 'Node.js not found. Install pi first (https://pi.dev), then run this installer again.'
fi
PATH=$node_bin:$PATH
export PATH

node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' ||
  fail "pidea needs Node.js 22.19 or newer, but $node_bin/node is $(node --version)."
[ -x "$node_bin/npm" ] || fail "npm is missing next to $node_bin/node."

if [ -n "${PIDEA_TARBALL:-}" ]; then
  tarball=$PIDEA_TARBALL
elif [ -n "${PIDEA_VERSION:-}" ]; then
  version=${PIDEA_VERSION#v}
  tarball=$repo/releases/download/v$version/pidea-$version.tgz
else
  tarball=$repo/releases/latest/download/pidea.tgz
fi

printf 'Installing %s into %s (Node.js %s from %s)\n' "$tarball" "$prefix" "$(node --version)" "$node_bin"
npm install --global --prefix "$prefix" --no-audit --no-fund --loglevel=error "$tarball"
script=$prefix/lib/node_modules/pidea/dist/index.js
[ -f "$script" ] || fail "npm finished, but $script is missing."

# A small launcher instead of a symlink: pi's Node.js is not on PATH, so the script's
# `#!/usr/bin/env node` line would not find it.
quoted_script="'$(printf '%s' "$script" | sed "s/'/'\\\\''/g")'"
launcher=$bin_dir/pidea
if [ -e "$launcher" ] && ! grep -qF "$marker" "$launcher" 2>/dev/null; then
  printf 'pidea install: %s already exists and was not written by this installer, so it is left alone.\n' "$launcher" >&2
  printf 'To use this install, remove it and run the installer again.\n' >&2
else
  mkdir -p "$bin_dir"
  cat >"$launcher.tmp" <<EOF
#!/bin/sh
$marker
pi_node_bin=\${XDG_DATA_HOME:-\$HOME/.local/share}/pi-node/current/bin
if [ -x "\$pi_node_bin/node" ]; then
  PATH=\$pi_node_bin:\$PATH
  export PATH
fi
exec node $quoted_script "\$@"
EOF
  chmod +x "$launcher.tmp"
  mv "$launcher.tmp" "$launcher"
fi

node "$script" setup "$@"

case ":$original_path:" in
  *":$bin_dir:"*) ;;
  *) printf '\n%s is not on your PATH. Add it to run `pidea update` and the other pidea commands.\n' "$bin_dir" ;;
esac
