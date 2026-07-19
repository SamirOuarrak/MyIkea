// db.js — connexion PostgreSQL (Supabase) + schéma + petit adaptateur de requêtes
//
// Pourquoi Postgres plutôt que SQLite : évite complètement les soucis de volume/mount
// path qu'on a rencontrés sur Railway, permet des sauvegardes automatiques via Supabase,
// et donne un vrai tableau de bord web pour explorer/corriger les données à la main.
//
// Ce module expose un petit adaptateur (`query`, `queryOne`, `run`) qui accepte des
// requêtes écrites avec des `?` comme placeholders (comme avec SQLite) et les convertit
// automatiquement en `$1, $2, ...` (syntaxe Postgres) — ça évite d'avoir à renuméroter
// à la main les requêtes qui réutilisent un même fragment SQL plusieurs fois (comme le
// regroupement de variantes dans /api/products).

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante. Ajoute la chaîne de connexion Supabase en variable d\'environnement.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase exige SSL ; rejectUnauthorized:false car Supabase utilise un certificat
  // qui n'est pas toujours dans la chaîne de confiance par défaut de Node.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Erreur inattendue sur une connexion PostgreSQL au repos:', err.message);
});

// Convertit une requête écrite avec des `?` en requête Postgres avec des `$1, $2, ...`
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return res.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return { rowCount: res.rowCount, rows: res.rows };
}

// Crée les tables si elles n'existent pas + applique les migrations manquantes.
// Contrairement à SQLite, Postgres supporte "ADD COLUMN IF NOT EXISTS" nativement,
// donc plus besoin de try/catch autour de chaque migration.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      article_number   TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      slug_url          TEXT NOT NULL,
      category          TEXT,
      image_url         TEXT,
      current_price     REAL,
      currency          TEXT DEFAULT 'DH',
      unit_note         TEXT,
      group_key         TEXT,
      first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
      last_checked_at   TIMESTAMPTZ,
      is_active         INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id              SERIAL PRIMARY KEY,
      article_number  TEXT NOT NULL REFERENCES products(article_number),
      price           REAL NOT NULL,
      currency        TEXT DEFAULT 'DH',
      checked_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_article ON price_history(article_number);
    CREATE INDEX IF NOT EXISTS idx_products_group_key ON products(group_key);

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id              SERIAL PRIMARY KEY,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      finished_at     TIMESTAMPTZ,
      products_found  INTEGER,
      products_seen   INTEGER,
      products_new    INTEGER,
      products_failed INTEGER,
      prices_changed  INTEGER,
      status          TEXT
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      article_number  TEXT PRIMARY KEY REFERENCES products(article_number),
      target_price    REAL NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Migrations idempotentes pour les bases existantes (si tu passais depuis une version
  // antérieure du schéma)
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS group_key TEXT;
    ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS products_found INTEGER;
    ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS products_failed INTEGER;
  `);

  console.log('✅ Schéma PostgreSQL initialisé');
}

module.exports = { pool, query, queryOne, run, init };
