# Vault Gardener System

Un agent Claude qui observe un vault Obsidian, l'organise progressivement, et dialogue avec toi via des notes dédiées. Vault-first : tout l'état vit dans des fichiers markdown versionnés.

Deux modes :
- **Exécutant** (`dispatch.js`) : tu écris `@agent:live` ou `@agent:bg` dans une note, un dispatcher les fire.
- **Jardinier** (`gardener.js`) : un agent séparé qui observe le vault entier et l'organise selon la philosophy.

## Setup

```sh
cd ~/vault-gardener-system
npm install
```

Ouvre le dossier `vault/` dans Obsidian (File → Open vault → `~/vault-gardener-system/vault`).

Le vault est déjà un repo git. Tous les runs du gardener commitent leurs changements automatiquement, donc tu peux revenir en arrière à tout moment avec `npm run rollback`.

## Usage

### Lancer le jardinier

```sh
npm run gardener
```

Ça snapshot le vault, passe la philosophy + l'état courant à Claude Code, stream la sortie en live, et commit le résultat. Si rien n'a changé, pas de commit. Relis `_gardener/log.md` pour voir ce qu'il a fait.

### Revenir en arrière

```sh
npm run rollback
```

Liste les 20 derniers commits et te laisse choisir. Utile quand le gardener part en vrille.

### Dispatcher une tâche depuis une note

Une note-projet avec un frontmatter `repo:` et des tâches `@agent:` :

```markdown
---
repo: ~/code/mon-projet
---

# Mon projet

- [ ] @agent:bg Ajoute un test pour le cas où l'input est vide
- [ ] @agent:live Refactore la fonction `parseX` pour qu'elle retourne un Result
```

Puis depuis la racine du projet :

```sh
npm run dispatch -- vault/projets/mon-projet.md
```

- `live` → ouvre une fenêtre iTerm, cd dans le repo, lance `claude` en interactif.
- `bg` → spawn `claude -p` en background avec cwd=repo. La ligne passe de `- [ ]` à `- [~]` pendant le run puis `- [x]` + un lien vers le rapport écrit dans `<repo>/_tmp/agent-reports/`.

Concurrence max : 2 tâches bg en parallèle (garde-fou rate limit).

### Binder le dispatch à un raccourci Obsidian

Installe le plugin [Shell Commands](https://github.com/Taitava/obsidian-shellcommands) dans Obsidian, puis crée une commande :

```
cd ~/vault-gardener-system && npm run dispatch -- "{{file_path:absolute}}"
```

Assigne-la à un raccourci clavier (ex. `Cmd+Shift+D`). Quand tu es dans une note avec des `@agent:` non cochés, appuie sur le raccourci.

Idem pour le gardener :

```
cd ~/vault-gardener-system && npm run gardener
```

## Structure

```
vault-gardener-system/
├── package.json
├── README.md
├── scripts/
│   ├── dispatch.js   # mode exécutant
│   ├── gardener.js   # mode jardinier
│   └── rollback.js   # utilitaire git reset interactif
└── vault/            # le vault Obsidian lui-même (repo git)
    ├── inbox.md
    └── _gardener/
        ├── philosophy.md       # constitution du jardinier
        ├── log.md              # trace de chaque run
        ├── proposals.md        # réorganisations qui demandent ton feu vert
        ├── insights/           # patterns remarqués
        └── dialogue/
            ├── open.md         # questions ouvertes du jardinier
            ├── profile.md      # miroir vivant — ce qu'il a appris sur toi
            └── archive/        # Q+A traitées
```

## Conventions (résumé)

- Le gardener peut librement : créer des notes/dossiers, ajouter des liens `[[wikilinks]]`, tagger, écrire des insights.
- Il doit proposer (pas exécuter) : déplacements, renames, fusions, découpages.
- Il ne supprime jamais. Notes obsolètes → `_archive/`.
- Il loggue tout dans `_gardener/log.md`.
- Il pose au plus **une question par run** et maintient au plus **deux questions ouvertes** simultanément.

Le reste est dans `vault/_gardener/philosophy.md` — c'est la vraie source de vérité.

## Notes d'implémentation

- Node 20+, ESM, pas de TypeScript.
- Le dispatcher utilise `REPORT_PATH` comme env var pour indiquer à l'agent où écrire son rapport. Si l'agent ne l'écrit pas, on capture stdout en fallback.
- Le gardener tronque les fichiers > 50KB pour ne pas exploser le prompt. À ajuster si tu as des notes longues.
- Le tail de `log.md` ne garde que les 20 dernières sections H2 — au-delà, historique complet dans le fichier.
