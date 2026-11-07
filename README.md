# Cats — suivi de mes chats (PWA)

Application web installable (iPhone : Safari → Partager → « Sur l'écran d'accueil »).

## Fichiers
| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `app.js` | Toute la logique (calendrier, CR, poids, FR, calories, sauvegarde, mises à jour) |
| `app.css` | Styles |
| `sw.js` | Service worker : hors-ligne + cache |
| `scan.js` | Remplissage automatique d'un aliment (code-barres, photo d'étiquette, estimation kcal) |
| `lib/pdfjs/` | Lecteur PDF intégré (fonctionne hors-ligne) |
| `lib/zxing/` | Lecture de codes-barres |
| `lib/tesseract/` | Lecture de texte sur photo (OCR, sur le téléphone) |
| `pdf/` | Comptes rendus |
| `tools/check-files.py` | Vérifie que tous les fichiers cités existent |

## Publier une mise à jour
1. Modifier / envoyer les fichiers sur la branche `main`.
2. **Garder exactement le nom de fichier attendu** (ex. `pdf/CONTESSE_Prise_de_sang_18-06-2026.pdf`).
   La vérification automatique (onglet *Actions*) passe au rouge si un fichier cité est absent.
3. Sur le téléphone, un bandeau **« Nouvelle version disponible — Actualiser »** apparaît
   (au lancement, au retour dans l'app, ou toutes les 15 min).

Ajouter un nouveau PDF : l'ajouter dans `pdf/`, le citer dans `app.js`, et dans la liste `PDFS` de `sw.js`
pour qu'il soit disponible hors-ligne.

## Données
Les données saisies restent sur le téléphone (stockage local). Faire régulièrement
**Apparence → Exporter JSON** ; l'app le rappelle si la dernière sauvegarde date de plus d'un mois.
