#!/usr/bin/env bash
# Search and download through VLC, one VLC per sample video.
#
#   run.sh <videos.txt> <result directory>
#
# videos.txt is what media.py prints: path, title, languages, expectation, the count
# per language to set and the languages holding more, tab separated. Each VLC runs the extension under sdb_live.lua and writes one result
# file; a line of PASS or FAIL first, then what it saw. VLC is cvlc unless $VLC
# names another binary. On Windows that is vlc.exe, the script directory is the one
# under APPDATA, and the paths VLC gets are Windows ones.
set -u
list="$1"
out="$2"
vlc="${VLC:-cvlc}"
here="$(cd "$(dirname "$0")" && pwd)"
extension="$here/../../vlc/subtitledb.lua"

if command -v cygpath > /dev/null 2>&1; then
  intf="$(cygpath -u "$APPDATA")/vlc/lua/intf"
  for_vlc() { cygpath -w "$1"; }
else
  intf="$HOME/.local/share/vlc/lua/intf"
  for_vlc() { printf '%s' "$1"; }
fi
mkdir -p "$intf" "$out"
cp "$here/sdb_live.lua" "$intf/"

status=0
n=0
while IFS=$'\t' read -r video title languages expect per_language many; do
  # Python on Windows ends each printed line with CR LF, and the CR lands on the
  # last field.
  many="${many%$'\r'}"
  n=$((n + 1))
  result="$out/vlc-$n.txt"
  echo "${video##*[/\\]}:"
  # The title as hex, so a non-ASCII one reaches the script intact on Windows too.
  SDB_EXTENSION="$(for_vlc "$extension")" SDB_RESULT="$(for_vlc "$result")" \
    SDB_TITLE="$(printf '%s' "$title" | od -An -tx1 -v | tr -d ' \n')" \
    SDB_LANGUAGES="$languages" SDB_EXPECT="$expect" \
    SDB_PER_LANGUAGE="$per_language" SDB_MANY="$many" \
    timeout 180 "$vlc" -I luaintf --lua-intf sdb_live --vout dummy --aout dummy \
    --no-video-title-show "$video" < /dev/null > "$out/vlc-$n.log" 2>&1 || true
  if [ -f "$result" ]; then
    sed 's/^/  /' "$result"
  else
    echo "  no result: VLC stopped before the script finished"
    tail -30 "$out/vlc-$n.log"
  fi
  grep -q '^PASS' "$result" 2>/dev/null || status=1
done < "$list"
exit "$status"
