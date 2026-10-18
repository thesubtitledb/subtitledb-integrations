#!/usr/bin/env bash
# Publishes @subtitledb/core to npm. ci.yml runs `check` in the build job on every push
# and pull request, and `publish` in the release job on main.
#
#   npm-publish.sh check     packs the package and fails if a file it needs is missing
#   npm-publish.sh publish   publishes the version in packages/core/package.json, unless
#                            npm already has it
#
# No token: npm trusts this workflow (ci.yml in thesubtitledb/subtitledb-integrations)
# as the package's trusted publisher and gives the job a short-lived one over OIDC.
# Provenance comes from the same identity.
set -euo pipefail
cd "$(dirname "$0")/.."
pkg=@subtitledb/core
ver=$(node -p "require('./packages/core/package.json').version")

check() {
  local files
  files=$(npm pack --workspace "$pkg" --dry-run --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () =>
      console.log(JSON.parse(s)[0].files.map((f) => f.path).join("\n")));')
  for f in package.json README.md LICENSE dist/index.js dist/index.d.ts; do
    grep -qx "$f" <<< "$files" || { echo "$pkg $ver would ship without $f"; exit 1; }
  done
  if grep -q '\.map$' <<< "$files"; then echo "$pkg $ver would ship source maps"; exit 1; fi
  echo "$pkg $ver packs $(wc -l <<< "$files") files"
}

publish() {
  local out
  if out=$(npm view "$pkg@$ver" version 2>&1); then
    echo "$pkg $ver is on npm"
    return
  fi
  # Only a 404 means unpublished. Anything else is a registry we cannot read, and
  # publishing blind would fail on an existing version anyway.
  grep -q E404 <<< "$out" || { echo "$out"; exit 1; }
  npm publish --workspace "$pkg" --provenance --access public
  echo "published $pkg $ver"
}

case ${1:-} in
  check | publish) "$1" ;;
  *) echo "usage: npm-publish.sh check | publish" >&2; exit 2 ;;
esac
