// scraper.js
//
// IMPORTANT — à lire avant le premier run :
// Ce scraper utilise 2 stratégies pour extraire le prix, de la plus fiable à la moins fiable :
//   1) Le bloc JSON-LD (schema.org "Product"), le plus robuste car indépendant du HTML/CSS.
//   2) Un fallback par expression régulière sur le texte brut, utilisé notamment sur les
//      articles textiles/revêtements où IKEA affiche un prix par m²/mètre en plus du prix
//      total. Dans ce cas on garde le PLUS GRAND prix valide trouvé sur la page.
//
// Regroupement de variantes : `deriveGroupKey` calcule un identifiant heuristique à partir
// du nom (en retirant couleurs et dimensions) + catégorie, pour regrouper les variantes
// (couleur/taille) d'un même article dans l'interface.
//
// NOTE POUR LES TESTS : `parseProductPage` et `deriveGroupKey` sont des fonctions PURES
// (aucun accès réseau ni base de données) — voir tests/scraper.test.js.

const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

const BASE = 'https://www.ikea.com/ma/fr';
const ROOT_CATEGORY = `${BASE}/cat/products-products/`;

const client = axios.create({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'fr-MA,fr;q=0.9',
  },
  timeout: 20000,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getHtml(url) {
  const res = await client.get(url);
  return res.data;
}

function extractLinks(html) {
  const $ = cheerio.load(html);
  const categoryLinks = new Set();
  const productLinks = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const full = href.startsWith('http') ? href : `https://www.ikea.com${href}`;
    if (!full.includes('ikea.com/ma/')) return;

    if (/\/cat\/[a-z0-9-]+\/?(\?|$)/i.test(full)) {
      categoryLinks.add(full.split('?')[0]);
    } else if (/\/p\/[a-z0-9-]+-\d+\/?$/i.test(full)) {
      productLinks.add(full.split('?')[0]);
    }
  });

  return { categoryLinks: [...categoryLinks], productLinks: [...productLinks] };
}

async function discoverAllProductUrls({ maxCategories = 1500 } = {}) {
  const visitedCategories = new Set();
  const toVisit = [ROOT_CATEGORY];
  const productCategoryMap = new Map();

  while (toVisit.length && visitedCategories.size < maxCategories) {
    const url = toVisit.shift();
    if (visitedCategories.has(url)) continue;
    visitedCategories.add(url);

    try {
      const html = await getHtml(url);
      const categoryName = extractCategoryName(html, url);
      const { categoryLinks, productLinks } = extractLinks(html);
      productLinks.forEach((p) => productCategoryMap.set(p, categoryName));
      categoryLinks.forEach((c) => {
        if (!visitedCategories.has(c)) toVisit.push(c);
      });
      console.log(`[discover] ${url} (${categoryName}) -> ${productLinks.length} produits, ${categoryLinks.length} sous-catégories (visitées: ${visitedCategories.size})`);
    } catch (err) {
      console.error(`[discover] échec sur ${url}: ${err.message}`);
    }

    await sleep(400);
  }

  return [...productCategoryMap.entries()].map(([url, categoryName]) => ({ url, categoryName }));
}

function extractCategoryName(html, url) {
  const $ = cheerio.load(html);
  const h1 = $('h1').first().text().trim();
  if (h1) return h1;

  const match = url.match(/\/cat\/([a-z0-9-]+)\/?$/i);
  if (!match) return 'Autre';
  return match[1]
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- FONCTIONS PURES (testées dans tests/scraper.test.js) ----------

const COLOR_WORDS = [
  'blanc', 'blanche', 'noir', 'noire', 'gris', 'grise', 'bleu', 'bleue', 'rouge', 'vert', 'verte',
  'jaune', 'beige', 'marron', 'rose', 'multicolore', 'naturel', 'naturelle', 'chêne', 'hêtre', 'pin',
  'argenté', 'argentée', 'doré', 'dorée', 'turquoise', 'violet', 'violette', 'orange', 'crème',
  'anthracite', 'taupe', 'écru', 'brun', 'brune', 'transparent', 'transparente',
];

// Dérive une clé de regroupement des variantes (couleur/taille) à partir du nom + catégorie.
function deriveGroupKey(name, category) {
  if (!name) return null;
  let base = name;

  base = base.replace(/\d+([.,]\d+)?\s*x\s*\d+([.,]\d+)?(\s*x\s*\d+([.,]\d+)?)?\s*cm/gi, '');
  base = base.replace(/\b\d+([.,]\d+)?\s*cm\b/gi, '');

  const colorRegex = new RegExp('\\b(' + COLOR_WORDS.join('|') + ')\\b', 'gi');
  base = base.replace(colorRegex, '');

  base = base.replace(/,\s*,/g, ',').replace(/,\s*$/, '').replace(/\s{2,}/g, ' ').trim();

  const slug = base
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return null;
  const catSlug = category ? category.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'general';
  return `${catSlug}--${slug}`;
}

function extractArticleNumberFallback($) {
  const text = $('body').text();
  const m = text.match(/Article number\s*([\d.\s]{8,})/i) || text.match(/Numéro d'article\s*([\d.\s]{8,})/i);
  return m ? m[1].trim() : null;
}

// Extrait { articleNumber, name, price, currency, unitNote, imageUrl } d'une page produit
function parseProductPage(html, url) {
  const $ = cheerio.load(html);

  let jsonLdData = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdData) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const product = candidates.find((c) => c['@type'] === 'Product');
      if (product) jsonLdData = product;
    } catch (_) {
      /* ignore blocs JSON-LD invalides */
    }
  });

  if (jsonLdData && jsonLdData.offers) {
    const offer = Array.isArray(jsonLdData.offers) ? jsonLdData.offers[0] : jsonLdData.offers;
    const price = offer ? parseFloat(offer.price) : null;
    if (price && price >= 5 && price <= 100000) {
      return {
        articleNumber: jsonLdData.sku || jsonLdData.mpn || extractArticleNumberFallback($),
        name: jsonLdData.name || $('h1').first().text().trim(),
        price,
        currency: (offer && offer.priceCurrency) || 'MAD',
        unitNote: null,
        imageUrl: jsonLdData.image || null,
        method: 'json-ld',
      };
    }
  }

  const bodyText = $('body').text();
  const allMatches = [];
  let match;
  const priceRegex = /(\d[\d\s]*,\d{2})\s*DH(\/[^\s]+)?/g;
  while ((match = priceRegex.exec(bodyText)) !== null) {
    const price = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
    allMatches.push({ price, match: match[0], index: match.index });
  }

  const validPrices = allMatches.filter((m) => m.price >= 5 && m.price <= 100000);
  if (validPrices.length > 0) {
    const best = validPrices.reduce((max, m) => (m.price > max.price ? m : max), validPrices[0]);
    const articleNumber = extractArticleNumberFallback($);
    return {
      articleNumber,
      name: $('h1').first().text().trim(),
      price: best.price,
      currency: 'MAD',
      unitNote: best.match.includes('/') ? best.match.split('DH')[1].trim() : null,
      imageUrl: $('meta[property="og:image"]').attr('content') || null,
      method: 'regex-fallback-max-valid',
    };
  }

  let failReason = 'unknown';
  if (/captcha|access denied|blocked|are you human/i.test(bodyText)) failReason = 'blocked';
  else if (!extractArticleNumberFallback($)) failReason = 'no-article-number';
  else if (allMatches.length === 0) failReason = 'no-price-pattern-found';
  else if (validPrices.length === 0) failReason = 'all-prices-out-of-range';
  return { failReason, bodyLength: bodyText.length, pricesFound: allMatches.map((m) => m.price) };
}

// ---------- FIN DES FONCTIONS PURES ----------

async function scrapeProduct(url, categoryName) {
  let html;
  try {
    html = await getHtml(url);
  } catch (err) {
    return { failReason: 'http-error: ' + (err.code || err.message) };
  }
  const data = parseProductPage(html, url);
  if (!data || !data.articleNumber || !data.price) {
    return { failReason: (data && data.failReason) || 'unknown' };
  }
  return { ...data, url, categoryName: categoryName || null };
}

async function upsertProduct({ articleNumber, name, url, price, currency, unitNote, imageUrl, categoryName }) {
  const existing = await db.queryOne('SELECT * FROM products WHERE article_number = ?', [articleNumber]);
  const groupKey = deriveGroupKey(name, categoryName || (existing && existing.category));

  if (!existing) {
    await db.run(
      `INSERT INTO products (article_number, name, slug_url, image_url, current_price, currency, unit_note, category, group_key, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [articleNumber, name, url, imageUrl, price, currency, unitNote, categoryName, groupKey]
    );
    await db.run(`INSERT INTO price_history (article_number, price, currency) VALUES (?, ?, ?)`, [
      articleNumber,
      price,
      currency,
    ]);
    return { isNew: true, priceChanged: true };
  }

  const priceChanged = existing.current_price !== price;
  await db.run(
    `UPDATE products SET name=?, slug_url=?, image_url=?, current_price=?, currency=?, unit_note=?, category=COALESCE(?, category), group_key=?, last_checked_at=NOW(), is_active=1
     WHERE article_number=?`,
    [name, url, imageUrl, price, currency, unitNote, categoryName, groupKey, articleNumber]
  );

  if (priceChanged) {
    await db.run(`INSERT INTO price_history (article_number, price, currency) VALUES (?, ?, ?)`, [
      articleNumber,
      price,
      currency,
    ]);
  }

  return { isNew: false, priceChanged };
}

async function refreshKnownProducts() {
  const runRow = await db.queryOne(`INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id`);
  const runId = runRow.id;

  const known = await db.query(`SELECT article_number, slug_url, category FROM products WHERE is_active = 1`);

  let productsSeen = 0;
  let pricesChanged = 0;
  let productsFailed = 0;

  await db.run(`UPDATE scrape_runs SET products_found=? WHERE id=?`, [known.length, runId]);
  console.log(`=== Rafraîchissement rapide de ${known.length} produits connus ===`);

  try {
    for (const p of known) {
      try {
        const data = await scrapeProduct(p.slug_url, p.category);
        if (data && data.articleNumber) {
          const { priceChanged } = await upsertProduct({
            articleNumber: data.articleNumber,
            name: data.name,
            url: data.url,
            price: data.price,
            currency: data.currency,
            unitNote: data.unitNote,
            imageUrl: data.imageUrl,
            categoryName: data.categoryName,
          });
          productsSeen++;
          if (priceChanged) pricesChanged++;
        } else {
          productsFailed++;
        }
      } catch (err) {
        productsFailed++;
        console.error(`[refresh] erreur sur ${p.slug_url}: ${err.message}`);
      }

      if ((productsSeen + productsFailed) % 10 === 0) {
        await db.run(`UPDATE scrape_runs SET products_seen=?, prices_changed=?, products_failed=? WHERE id=?`, [
          productsSeen,
          pricesChanged,
          productsFailed,
          runId,
        ]);
      }

      await sleep(300);
    }

    await db.run(
      `UPDATE scrape_runs SET finished_at=NOW(), products_seen=?, products_new=0, prices_changed=?, products_failed=?, status='done' WHERE id=?`,
      [productsSeen, pricesChanged, productsFailed, runId]
    );

    console.log(`=== Rafraîchissement terminé: ${productsSeen} ok, ${pricesChanged} prix changés, ${productsFailed} échecs ===`);
  } catch (err) {
    await db.run(`UPDATE scrape_runs SET finished_at=NOW(), status=? WHERE id=?`, [`error: ${err.message}`, runId]);
    throw err;
  }
}

async function runFullScrape() {
  const runRow = await db.queryOne(`INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id`);
  const runId = runRow.id;

  let productsSeen = 0;
  let productsNew = 0;
  let pricesChanged = 0;
  let productsFailed = 0;
  const failReasonCounts = {};

  try {
    console.log('=== Découverte des produits (parcours des catégories) ===');
    const productUrls = await discoverAllProductUrls();
    console.log(`=== ${productUrls.length} produits uniques trouvés. Début du scraping des prix ===`);

    await db.run(`UPDATE scrape_runs SET products_found=? WHERE id=?`, [productUrls.length, runId]);

    for (const { url, categoryName } of productUrls) {
      try {
        const data = await scrapeProduct(url, categoryName);
        if (data && data.articleNumber) {
          const { isNew, priceChanged } = await upsertProduct({
            articleNumber: data.articleNumber,
            name: data.name,
            url: data.url,
            price: data.price,
            currency: data.currency,
            unitNote: data.unitNote,
            imageUrl: data.imageUrl,
            categoryName: data.categoryName,
          });
          productsSeen++;
          if (isNew) productsNew++;
          if (priceChanged) pricesChanged++;
        } else {
          productsFailed++;
          const reason = (data && data.failReason) || 'unknown';
          failReasonCounts[reason] = (failReasonCounts[reason] || 0) + 1;
          if (productsFailed <= 10 || productsFailed % 200 === 0) {
            console.warn(`[scrape] échec (${reason}) sur ${url} — total échecs: ${productsFailed}`);
          }
        }
      } catch (err) {
        productsFailed++;
        console.error(`[scrape] erreur sur ${url}: ${err.message}`);
      }

      if ((productsSeen + productsFailed) % 5 === 0) {
        await db.run(
          `UPDATE scrape_runs SET products_seen=?, products_new=?, prices_changed=?, products_failed=? WHERE id=?`,
          [productsSeen, productsNew, pricesChanged, productsFailed, runId]
        );
      }

      await sleep(300);
    }

    await db.run(
      `UPDATE scrape_runs SET finished_at=NOW(), products_seen=?, products_new=?, prices_changed=?, products_failed=?, status='done' WHERE id=?`,
      [productsSeen, productsNew, pricesChanged, productsFailed, runId]
    );

    console.log(`=== Terminé: ${productsSeen} vus, ${productsNew} nouveaux, ${pricesChanged} prix changés, ${productsFailed} échecs ===`);
    console.log('=== Répartition des échecs:', JSON.stringify(failReasonCounts), '===');
  } catch (err) {
    await db.run(`UPDATE scrape_runs SET finished_at=NOW(), status=? WHERE id=?`, [`error: ${err.message}`, runId]);
    throw err;
  }
}

async function recomputeAllGroupKeys() {
  const all = await db.query(`SELECT article_number, name, category FROM products`);
  for (const r of all) {
    await db.run(`UPDATE products SET group_key = ? WHERE article_number = ?`, [
      deriveGroupKey(r.name, r.category),
      r.article_number,
    ]);
  }
  return all.length;
}

module.exports = {
  runFullScrape,
  refreshKnownProducts,
  scrapeProduct,
  discoverAllProductUrls,
  parseProductPage,
  deriveGroupKey,
  recomputeAllGroupKeys,
};
