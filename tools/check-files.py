#!/usr/bin/env python3
"""Vérifie que chaque fichier local cité par l'application existe bien dans le dépôt.

Évite les erreurs 404 (ex. un PDF envoyé sous un autre nom) et les échecs
d'installation du service worker. Lancement : python3 tools/check-files.py
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
sources = ["index.html", "app.js", "app.css", "scan.js", "sw.js", "manifest.webmanifest"]
pattern = re.compile(r"""["'](?:\./)?((?:pdf|lib)/[^"')?#\s]+|[\w.-]+\.(?:png|pdf|css|js|webmanifest))["')?#]""")
missing = []
for name in sources:
    text = (root / name).read_text(encoding="utf-8")
    for ref in sorted(set(pattern.findall(text))):
        if ref.startswith(("http", "idb:")) or "${" in ref:
            continue
        if not ((root / ref).is_file() or (root / ref).is_dir()):
            missing.append(f"{name} → {ref}")
if missing:
    print("Fichiers référencés mais absents du dépôt :")
    print("\n".join("  - " + m for m in missing))
    sys.exit(1)
print("OK : tous les fichiers référencés existent.")
