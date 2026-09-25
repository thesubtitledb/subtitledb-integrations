#!/usr/bin/env bash
# Builds and publishes the GitHub Releases. ci.yml runs `build` on every push and pull
# request, and `plan` and `publish` on main once every other job has passed.
#
#   release.sh build     every file a release publishes, in release/<tag>/, each
#                        directory with a SHA256SUMS. Needs node, python3, dotnet and
#                        `npm run build` done first.
#   release.sh plan      which of those tags has no published release yet; writes
#                        release/new.sha256, every file they publish, for the attestation
#   release.sh publish   creates those releases: draft, upload, publish
#
# One tag per thing people install, named for its own version:
#
#   loader-v<ver>    packages/loader/package.json: the cdn.thesubtitledb.org tree, zipped,
#                    with SHA256SUMS naming every file in it by its path on the CDN
#   jellyfin-v<ver>  plugins/dotnet/Directory.Build.props: the zip and manifest.json
#   emby-v<ver>      the same version: the zip
#   kodi-v<ver>      the add-on's addon.xml: the zip Kodi installs
#   vlc-v<ver>       S.VERSION in plugins/vlc/subtitledb.lua: the script itself
#   bazarr-v<ver>    plugins/python/pyproject.toml: the provider, the client, install.py
set -euo pipefail
cd "$(dirname "$0")/.."
repo=${GITHUB_REPOSITORY:-thesubtitledb/subtitledb-integrations}
out=$PWD/release

# sums <dir>: SHA256SUMS over the files in it, by their path inside it.
sums() {
  (cd "$1" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort \
    | xargs -d '\n' sha256sum > SHA256SUMS)
}

# newest <name>: the newest published <name>-v tag, or nothing if there is none. A
# failed lookup fails the build: the Jellyfin manifest would silently drop every
# earlier version.
newest() {
  local tags
  tags=$(gh release list --repo "$repo" --limit 1000 --exclude-drafts \
    --json tagName --jq '.[].tagName')
  printf '%s\n' "$tags" | sed -n "s/^$1-v//p" | sort -V | tail -1 | sed "/./s/^/$1-v/"
}

build() {
  rm -rf "$out"

  local ver dir
  ver=$(node -p "require('./packages/loader/package.json').version")
  dir=$out/loader-v$ver
  mkdir -p "$dir"
  npm run build:cdn
  (cd cdn && python3 -m zipfile -c "$dir/subtitledb-cdn-$ver.zip" ./*)
  (cd cdn && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum) > "$dir/SHA256SUMS"
  (cd "$dir" && sha256sum "subtitledb-cdn-$ver.zip" >> SHA256SUMS)

  ver=$(sed -nE 's#.*<Version>([^<]+)</Version>.*#\1#p' plugins/dotnet/Directory.Build.props)
  local history=() last
  if [ -n "${GITHUB_ACTIONS:-}" ] || command -v gh >/dev/null; then
    last=$(newest jellyfin)
    if [ -n "$last" ]; then
      gh release download "$last" --repo "$repo" --pattern manifest.json \
        --output "$out/earlier-manifest.json" --clobber
      history=(--history "$out/earlier-manifest.json")
      echo "the Jellyfin repository keeps the versions $last lists"
    fi
  fi
  python3 plugins/dotnet/tools/build-plugins.py \
    --repo "https://github.com/$repo/releases/download/jellyfin-v$ver" "${history[@]}"
  rm -f "$out/earlier-manifest.json"
  mkdir -p "$out/jellyfin-v$ver" "$out/emby-v$ver"
  cp plugins/dotnet/dist/repo/* "$out/jellyfin-v$ver/"
  cp "plugins/dotnet/dist/subtitledb-emby-$ver.zip" "$out/emby-v$ver/"

  local zip
  zip=$(cd plugins/kodi && python3 build.py)
  ver=$(basename "$zip" .zip); ver=${ver##*-}
  mkdir -p "$out/kodi-v$ver"
  cp "$zip" "$out/kodi-v$ver/"

  ver=$(sed -nE 's/^S\.VERSION = "([^"]+)".*/\1/p' plugins/vlc/subtitledb.lua)
  mkdir -p "$out/vlc-v$ver"
  cp plugins/vlc/subtitledb.lua "$out/vlc-v$ver/"

  zip=$(cd plugins/bazarr && python3 build.py)
  ver=$(basename "$zip" .zip); ver=${ver##*-}
  mkdir -p "$out/bazarr-v$ver"
  cp "$zip" "$out/bazarr-v$ver/"

  for dir in "$out"/*/; do
    [ -f "$dir/SHA256SUMS" ] || sums "$dir"
  done
  for dir in "$out"/*/; do
    [ "$(ls "$dir" | wc -l)" -ge 2 ] || { echo "$dir holds nothing to release"; exit 1; }
  done
  (cd "$out" && find . -type f | LC_ALL=C sort)
}

# The paths each release is built from, to say when one changed with no new version.
sources() {
  case $1 in
    loader) echo packages ':(exclude,glob)packages/*/test/**' ;;
    jellyfin | emby) echo plugins/dotnet/src plugins/dotnet/tools/build-plugins.py ;;
    kodi) echo plugins/kodi/service.subtitles.subtitledb plugins/kodi/build.py plugins/python/subtitledb ;;
    vlc) echo plugins/vlc/subtitledb.lua ;;
    bazarr) echo plugins/bazarr/provider.py plugins/bazarr/install.py plugins/python/subtitledb ;;
  esac
}

plan() {
  local new=() dir tag draft paths
  : > "$out/new.sha256"
  for dir in "$out"/*/; do
    tag=$(basename "$dir")
    if draft=$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft 2>/dev/null) \
        && [ "$draft" = false ]; then
      read -ra paths <<< "$(sources "${tag%-v*}")"
      if ! git diff --quiet "$tag" HEAD -- "${paths[@]}"; then
        echo "::warning::${tag%-v*} changed since $tag and its version did not, so none of it is released. Bump the version to release it."
      fi
      echo "$tag is released"
      continue
    fi
    if [ -z "${draft:-}" ] && git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
      echo "::error::the tag $tag exists with no release, so a release would not name the commit it was built from"
      exit 1
    fi
    new+=("$tag")
    cat "$dir/SHA256SUMS" >> "$out/new.sha256"
  done
  echo "new: ${new[*]:-none}"
  echo "tags=${new[*]:-}" >> "${GITHUB_OUTPUT:-/dev/null}"
}

title() {
  case ${1%-v*} in
    loader) echo "CDN loader ${1##*-v}" ;;
    jellyfin) echo "Jellyfin plugin ${1##*-v}" ;;
    emby) echo "Emby plugin ${1##*-v}" ;;
    kodi) echo "Kodi add-on ${1##*-v}" ;;
    vlc) echo "VLC extension ${1##*-v}" ;;
    bazarr) echo "Bazarr provider ${1##*-v}" ;;
  esac
}

notes() {
  local run=${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/${GITHUB_RUN_ID:-0}
  cat <<EOF
Built from ${GITHUB_SHA:-$(git rev-parse HEAD)} by [this run]($run), after every test in it passed.

Check a file against this release, whether it came from here or from cdn.thesubtitledb.org:

\`\`\`bash
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify <file> --repo $repo
\`\`\`
EOF
}

publish() {
  local tag latest
  for tag in ${TAGS:?TAGS lists the tags to publish}; do
    [ -d "$out/$tag" ] || { echo "no files for $tag"; exit 1; }
    # The loader is the one most people use, so it is the one /releases/latest names.
    latest=false
    [ "${tag%-v*}" = loader ] && latest=true
    if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
      # A draft left by a run that stopped part way: bring its files up to date.
      gh release upload "$tag" "$out/$tag"/* --repo "$repo" --clobber
    else
      notes > "$out/notes.md"
      gh release create "$tag" "$out/$tag"/* --repo "$repo" --draft --target "${GITHUB_SHA:?}" \
        --title "$(title "$tag")" --notes-file "$out/notes.md"
    fi
    gh release edit "$tag" --repo "$repo" --draft=false --latest="$latest"
    echo "published $tag"
  done
}

case ${1:-} in
  build | plan | publish) "$1" ;;
  *) echo "usage: release.sh build | plan | publish" >&2; exit 2 ;;
esac
