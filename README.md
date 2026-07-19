# IKEA Maroc — Suivi des prix

Backend Node.js + PostgreSQL (Supabase) qui scrape quotidiennement les prix du catalogue
IKEA Maroc, garde un historique, détecte les nouveaux produits et regroupe les variantes
(couleur/taille) d'un même article. Dashboard web avec filtres, analyse des tendances,
alertes de prix.

## 1. Créer la base de données (Supabase)

1. Va sur [supabase.com](https://supabase.com) → New Project (gratuit)
2. Une fois créé : **Project Settings → Database → Connection string** → copie la chaîne
   au format `postgresql://postgres:[password]@[host]:5432/postgres`
3. Garde cette URL, elle servira de variable d'environnement `DATABASE_URL`

Pas besoin de créer les tables manuellement — le serveur les crée automatiquement au
démarrage (`db.init()` dans `server.js`).

## 2. Installation locale

```bash
npm install
```

Crée un fichier `.env` à la racine (non commité, voir `.gitignore`) :
```
DATABASE_URL=postgresql://postgres:[password]@[host]:5432/postgres
```

Puis charge-le avant de lancer (ou utilise un outil comme `dotenv` / `dotenv-cli`) :
```bash
DATABASE_URL="ta-chaine-supabase" npm start
```

## 3. Tests

```bash
npm test
```

Utilise le test runner intégré à Node.js (`node --test`), aucune dépendance de test à
installer. Couvre les fonctions critiques du scraper :
- `deriveGroupKey` — regroupement des variantes (couleur/taille)
- `parseProductPage` — extraction du prix (JSON-LD + fallback regex, y compris le piège
  "prix au m²" qui donnait de mauvais résultats avant correction)

## 4. Déploiement sur Railway

1. Push le code sur GitHub, connecte le repo sur Railway
2. **Variables** du service → ajoute `DATABASE_URL` avec la chaîne Supabase
3. Plus besoin de volume — la base est chez Supabase, pas sur le disque du conteneur

## 5. Lancer un scrape complet manuellement

```bash
npm run scrape:now
```

Sur tout le catalogue, prévoir plusieurs heures pour le premier passage (délai de
politesse entre chaque requête pour ne pas surcharger le serveur IKEA).

## Structure du projet

```
ikea-price-tracker/
├── db.js              → connexion Postgres + schéma + adaptateur de requêtes
├── scraper.js          → découverte, extraction de prix, regroupement de variantes
├── server.js            → API Express + planification cron
├── tests/scraper.test.js → tests unitaires (node:test)
├── public/index.html      → dashboard (filtres, alertes, graphiques)
└── package.json
```

## Endpoints API

- `GET /api/products?q=&category=&minPrice=&maxPrice=&sort=&promoOnly=&groupBy=` — liste filtrée
- `GET /api/products/group/:groupKey` — variantes d'un même article
- `GET /api/products/:articleNumber/history` — historique de prix
- `GET /api/products/new?days=7` — nouveaux produits
- `GET /api/products/price-drops?days=7` — changements de prix récents
- `GET /api/analysis/top-movers?direction=drop|rise&days=7` — classement des variations
- `GET /api/stats` — KPIs du dashboard
- `GET /api/categories` — catégories avec compteur
- `GET /api/export/csv` — export CSV du catalogue
- `GET/POST/DELETE /api/watchlist` — alertes de prix
- `POST /api/scrape/run-now` — découverte complète (nouveaux produits)
- `POST /api/scrape/refresh-now` — rafraîchissement rapide (produits connus)
- `GET /api/scrape-runs` — journal des exécutions
- `POST /api/admin/recompute-groups` — recalcule les regroupements de variantes

## Prochaines améliorations possibles

- Alertes par email/webhook en cas d'échec de scraping répété
- Pagination complète des catégories IKEA (actuellement limité à la 1ère page de
  chaque catégorie — voir le commentaire dans `discoverAllProductUrls`)
- Notifications automatiques (email) quand un prix cible de la watchlist est atteint
