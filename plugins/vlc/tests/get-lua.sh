#!/usr/bin/env bash
# Build the Lua the tests run on, into tests/.lua/bin/lua.
#
# VLC embeds Lua 5.1 and this builds 5.4, which is a real difference: 5.4 has
# integers, goto and a utf8 library that 5.1 does not. The extension is written to
# the 5.1 subset for that reason, and tests/run.lua turns the differences that
# matter into failures rather than trusting the note.
#
# From source rather than from a package, because a test suite that only runs where
# someone remembered to apt-get install is a test suite that stops being run.
set -euo pipefail

VERSION="${LUA_VERSION:-5.4.7}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="$HERE/.lua"
BIN="$PREFIX/bin/lua"

if [ -x "$BIN" ]; then
  echo "already built: $("$BIN" -v 2>&1)"
  exit 0
fi

# /mnt/c is slow enough that a build there takes minutes instead of seconds, so
# the unpack and compile happen on the native filesystem and only the binary is
# copied back.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL "https://www.lua.org/ftp/lua-$VERSION.tar.gz" -o "$WORK/lua.tar.gz"
tar -xzf "$WORK/lua.tar.gz" -C "$WORK"
make -C "$WORK/lua-$VERSION" -s posix -j"$(nproc)"

mkdir -p "$PREFIX/bin"
cp "$WORK/lua-$VERSION/src/lua" "$BIN"
echo "built: $("$BIN" -v 2>&1)"
