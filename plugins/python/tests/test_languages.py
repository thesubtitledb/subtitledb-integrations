"""Regional tags resolve to the code the API files them under."""

from __future__ import annotations

import pytest
from subtitledb.languages import language_name, to_code

NOT_ISO = {
    "pb": "Portuguese (Brazil)",
    "zt": "Chinese (Traditional)",
    "ze": "Chinese and English",
    "ea": "Spanish (Latin America)",
    "sp": "Spanish (Spain)",
    "pm": "Portuguese (Mozambique)",
}


@pytest.mark.parametrize(("code", "name"), NOT_ISO.items())
def test_the_corpus_codes_that_are_not_iso_have_names(code: str, name: str) -> None:
    assert language_name(code) == name
    # The name resolves back to the code, the way Kodi hands it over.
    assert to_code(name) == code


# Checked live with ?lang= on 2026-10-18: these answer the ea files, the rest es.
@pytest.mark.parametrize(
    "tag", ["es-419", "es-MX", "es-AR", "es-CO", "es-US", "es-PR", "es_MX", "es-Latn-MX"]
)
def test_latin_american_spanish_is_ea(tag: str) -> None:
    assert to_code(tag) == "ea"


@pytest.mark.parametrize("tag", ["es", "es-ES", "es-GQ", "es-013", "es-Latn", "ES-es", "spa"])
def test_any_other_spanish_is_es(tag: str) -> None:
    assert to_code(tag) == "es"


def test_a_script_subtag_is_skipped_before_the_region() -> None:
    assert to_code("zh-Hant-TW") == "zt"
    assert to_code("sr-Latn-RS") == "sr"
