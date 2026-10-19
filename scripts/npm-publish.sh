#!/usr/bin/env bash
# Publishes @subtitledb/core to npm. ci.yml runs `check` in the build job on every push
# and pull request, and `status` in the release job on main. CI holds no npm credential
# and never publishes.
#
#   npm-publish.sh check     packs the package and fails if a file it needs is missing,
#                            or if the built entry lacks an export the README names
#   npm-publish.sh status    warns when npm lacks the version in packages/core/package.json
#   npm-publish.sh publish   publishes that version, unless npm already has it. Run by
#                            hand after `npm login` and `npm run build`; npm asks for
#                            the account's second factor.
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
  # What the README documents has to be importable from the built entry.
  node --input-type=module -e '
    const m = await import("./packages/core/dist/index.js");
    const missing = ["localeLanguages", "corpusLanguage", "languageName", "parseFilename", "query"]
      .filter((n) => typeof m[n] !== "function");
    if (missing.length) {
      console.log("the built entry does not export " + missing.join(", "));
      process.exit(1);
    }'
  echo "$pkg $ver packs $(wc -l <<< "$files") files"
}

# 0 when npm has this version, 1 when it does not. Only a 404 means unpublished;
# anything else is a registry we cannot read, and fails.
on_npm() {
  local out
  out=$(npm view "$pkg@$ver" version 2>&1) && return 0
  grep -q E404 <<< "$out" || { echo "$out" >&2; exit 1; }
  return 1
}

status() {
  if on_npm; then echo "$pkg $ver is on npm"; return; fi
  echo "::warning::$pkg $ver is not on npm yet. Publish it by hand: scripts/npm-publish.sh publish"
}

publish() {
  if on_npm; then echo "$pkg $ver is on npm"; return; fi
  npm publish --workspace "$pkg" --access public
  echo "published $pkg $ver"
}

case ${1:-} in
  check | status | publish) "$1" ;;
  *) echo "usage: npm-publish.sh check | status | publish" >&2; exit 2 ;;
esac
