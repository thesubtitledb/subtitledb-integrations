#!/usr/bin/env python3
"""Generate LanguageTables.cs from the Python tables.

Five plugins have to resolve `pob`, `pt-BR` and "Brazilian Portuguese" to the same
code. Typing three hundred pairs a second time is how that stops being true, so the
C# tables are generated from plugins/python/subtitledb/languages.py and CI fails if
the checked-in file does not match what this writes.

    python3 plugins/dotnet/tools/gen-languages.py
"""

from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
PLUGINS = HERE.parents[1]
OUT = HERE.parent / "src" / "SubtitleDb.Core" / "LanguageTables.cs"

sys.path.insert(0, str(PLUGINS / "python"))

from subtitledb import languages  # noqa: E402

HEADER = '''using System.Collections.Generic;

namespace SubtitleDb.Core
{
    /// <summary>
    /// The tables, generated from plugins/python/subtitledb/languages.py so the two
    /// cannot drift. Edit that file, then rerun plugins/dotnet/tools/gen-languages.py.
    /// </summary>
    internal static partial class LanguageTables
    {
'''

FOOTER = """    }
}
"""


def block(doc: str, name: str, table: dict[str, str]) -> str:
    rows = "\n".join('            { "%s", "%s" },' % (k, v) for k, v in table.items())
    return (
        "        /// <summary>%s</summary>\n"
        "        internal static readonly Dictionary<string, string> %s"
        " = new Dictionary<string, string>\n"
        "        {\n%s\n        };\n" % (doc, name, rows)
    )


def render() -> str:
    return (
        HEADER
        + block(
            "ISO639-1, plus the four OpenSubtitles codes, to display name.",
            "Names",
            languages.NAMES,
        )
        + "\n"
        + block(
            "Three-letter forms. Both /T and /B: Jellyfin sends deu, Emby sends ger.",
            "Alpha3",
            languages.ALPHA3,
        )
        + "\n"
        + block(
            "Legacy codes, regional tags, and the names people write by hand.",
            "Aliases",
            languages.ALIASES,
        )
        + FOOTER
    )


def main() -> int:
    body = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != body:
            print("%s is stale: rerun %s" % (OUT, pathlib.Path(__file__).name))
            return 1
        print("%s is current" % OUT.name)
        return 0
    # Bytes for the same reason as build-plugins.py: write_text(newline=...) is 3.10.
    OUT.write_bytes(body.encode("utf-8"))
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
