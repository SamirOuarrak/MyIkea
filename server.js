// server.js — API + planification du scraping quotidien + sert le frontend

const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const { runFullScrape, refreshKnownProducts, recomputeAllGroupKeys } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

function buildProductFilters(req) {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const minPrice = req.query.minPrice ? parseFloat(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice) : null;

  const where = ['p.is_active = 1'];
  const params = [];

  if (q) {
    where.push('p.name ILIKE ?');
    params.push(`%${q}%`);
  }
  if (category) {
    where.push('p.category = ?');
    params.push(category);
  }
  if (minPrice !== null) {
    where.push('p.current_price >= ?');
    params.push(minPrice);
  }
  if (maxPrice !== null) {
    where.push('p.current_price <= ?');
    params.push(maxPrice);
  }

  return { whereSql: where.join(' AND '), params };
}

// ---------- PRODUITS (liste + filtres + tri + regroupement de variantes) ----------
app.get('/api/products', async (req, res) => {
  try {
    const promoOnly = req.query.promoOnly === 'true';
    const sort = req.query.sort || 'recent';
    const groupBy = req.query.groupBy !== 'false';
    const limit = Math.min(parseInt(req.query.limit) || 60, 300);
    const offset = parseInt(req.query.offset) || 0;

    const { whereSql, params } = buildProductFilters(req);

    const sortMap = {
      recent: 'last_checked_at DESC',
      price_asc: 'current_price ASC',
      price_desc: 'current_price DESC',
      name: 'name ASC',
      biggest_drop: 'price_change_pct ASC NULLS LAST',
    };
    const orderBy = sortMap[sort] || sortMap.recent;

    let sql = `
      SELECT p.*,
        ${groupBy ? `(SELECT COUNT(*) FROM products p2 WHERE COALESCE(p2.group_key, p2.article_number) = COALESCE(p.group_key, p.article_number) AND p2.is_active = 1) AS variant_count,` : ''}
        (SELECT price FROM price_history ph
         WHERE ph.article_number = p.article_number AND ph.checked_at < NOW() - INTERVAL '7 days'
         ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price_7d,
        CASE WHEN (SELECT price FROM price_history ph
                   WHERE ph.article_number = p.article_number AND ph.checked_at < NOW() - INTERVAL '7 days'
                   ORDER BY ph.checked_at DESC LIMIT 1) IS NOT NULL
          THEN (p.current_price - (SELECT price FROM price_history ph
                   WHERE ph.article_number = p.article_number AND ph.checked_at < NOW() - INTERVAL '7 days'
                   ORDER BY ph.checked_at DESC LIMIT 1)) * 1.0 /
               (SELECT price FROM price_history ph
                   WHERE ph.article_number = p.article_number AND ph.checked_at < NOW() - INTERVAL '7 days'
                   ORDER BY ph.checked_at DESC LIMIT 1)
          ELSE NULL
        END AS price_change_pct
      FROM products p
      WHERE ${whereSql}
    `;

    if (promoOnly) {
      sql = `SELECT * FROM (${sql}) t WHERE previous_price_7d IS NOT NULL AND price_change_pct < 0`;
    }

    if (groupBy) {
      sql = `
        SELECT * FROM (${sql}) t
        WHERE t.current_price = (
          SELECT MIN(t2.current_price) FROM (${sql}) t2
          WHERE COALESCE(t2.group_key, t2.article_number) = COALESCE(t.group_key, t.article_number)
        )
      `;
      params.push(...params);
      sql += ` GROUP BY t.article_number, t.name, t.slug_url, t.category, t.image_url, t.current_price, t.currency,
                        t.unit_note, t.group_key, t.first_seen_at, t.last_checked_at, t.is_active, t.variant_count,
                        t.previous_price_7d, t.price_change_pct`;
    }

    sql += ` ORDER BY ${sort === 'biggest_drop' && !promoOnly ? 'price_change_pct ASC NULLS LAST' : orderBy} LIMIT ? OFFSET ?`;
    const finalParams = [...params, limit + 1, offset];

    const rows = await db.query(sql, finalParams);
    const hasMore = rows.length > limit;
    res.json({ items: rows.slice(0, limit), hasMore });
  } catch (err) {
    console.error('Erreur /api/products:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/group/:groupKey', async (req, res) => {
  const rows = await db.query(
    `SELECT * FROM products WHERE is_active = 1 AND COALESCE(group_key, article_number) = ? ORDER BY current_price ASC`,
    [req.params.groupKey]
  );
  res.json(rows);
});

app.get('/api/products/:articleNumber/history', async (req, res) => {
  const rows = await db.query(
    `SELECT price, currency, checked_at FROM price_history WHERE article_number=? ORDER BY checked_at ASC`,
    [req.params.articleNumber]
  );
  res.json(rows);
});

app.get('/api/products/new', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const limit = Math.min(parseInt(req.query.limit) || 60, 300);
  const offset = parseInt(req.query.offset) || 0;
  const all = await db.query(
    `SELECT * FROM products WHERE is_active=1 AND first_seen_at >= NOW() - (?::int * INTERVAL '1 day') ORDER BY first_seen_at DESC`,
    [days]
  );
  res.json({ items: all.slice(offset, offset + limit), hasMore: offset + limit < all.length });
});

app.get('/api/products/price-drops', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const limit = Math.min(parseInt(req.query.limit) || 60, 300);
  const offset = parseInt(req.query.offset) || 0;
  const all = (
    await db.query(
      `SELECT p.article_number, p.name, p.slug_url, p.category, p.image_url, p.current_price, p.currency,
              (SELECT price FROM price_history ph
               WHERE ph.article_number = p.article_number AND ph.checked_at < NOW() - (?::int * INTERVAL '1 day')
               ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price
       FROM products p WHERE p.is_active = 1`,
      [days]
    )
  ).filter((r) => r.previous_price !== null && r.previous_price !== r.current_price);
  res.json({ items: all.slice(offset, offset + limit), hasMore: offset + limit < all.length });
});

app.get('/api/categories', async (req, res) => {
  const rows = await db.query(
    `SELECT category, COUNT(*) as count FROM products
     WHERE is_active=1 AND category IS NOT NULL
     GROUP BY category ORDER BY count DESC`
  );
  res.json(rows);
});

app.get('/api/stats', async (req, res) => {
  const totalProducts = (await db.queryOne(`SELECT COUNT(*) as c FROM products WHERE is_active=1`)).c;
  const totalGroups = (
    await db.queryOne(`SELECT COUNT(DISTINCT COALESCE(group_key, article_number)) as c FROM products WHERE is_active=1`)
  ).c;
  const totalValue = (await db.queryOne(`SELECT SUM(current_price) as s FROM products WHERE is_active=1`)).s || 0;
  const avgPrice = (await db.queryOne(`SELECT AVG(current_price) as a FROM products WHERE is_active=1`)).a || 0;

  const changed7d = (
    await db.query(
      `SELECT p.current_price,
        (SELECT price FROM price_history ph WHERE ph.article_number = p.article_number
         AND ph.checked_at < NOW() - INTERVAL '7 days' ORDER BY ph.checked_at DESC LIMIT 1) AS prev
       FROM products p WHERE p.is_active = 1`
    )
  ).filter((r) => r.prev !== null && r.prev !== r.current_price);

  const drops7d = changed7d.filter((r) => r.current_price < r.prev).length;
  const rises7d = changed7d.filter((r) => r.current_price > r.prev).length;

  const newThisWeek = (
    await db.queryOne(`SELECT COUNT(*) as c FROM products WHERE is_active=1 AND first_seen_at >= NOW() - INTERVAL '7 days'`)
  ).c;

  const lastRun = await db.queryOne(`SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1`);

  res.json({
    totalProducts: Number(totalProducts),
    totalGroups: Number(totalGroups),
    totalValue: Math.round(totalValue),
    avgPrice: Math.round(avgPrice * 100) / 100,
    drops7d,
    rises7d,
    newThisWeek: Number(newThisWeek),
    lastRun,
  });
});

app.get('/api/analysis/top-movers', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const direction = req.query.direction === 'rise' ? 'rise' : 'drop';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  const rows = (
    await db.query(
      `SELECT p.article_number, p.name, p.slug_url, p.category, p.image_url, p.current_price, p.currency,
              (SELECT price FROM price_history ph
               WHERE ph.article_number = p.article_number AND ph.checked_at < NOW() - (?::int * INTERVAL '1 day')
               ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price
       FROM products p WHERE p.is_active = 1`,
      [days]
    )
  )
    .filter((r) => r.previous_price !== null && r.previous_price !== r.current_price)
    .map((r) => ({ ...r, changePct: ((r.current_price - r.previous_price) / r.previous_price) * 100 }))
    .filter((r) => (direction === 'drop' ? r.changePct < 0 : r.changePct > 0))
    .sort((a, b) => (direction === 'drop' ? a.changePct - b.changePct : b.changePct - a.changePct))
    .slice(0, limit);

  res.json({ items: rows, hasMore: false });
});

app.get('/api/analysis/category-trends', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = (
    await db.query(
      `SELECT p.category, p.current_price,
        (SELECT price FROM price_history ph WHERE ph.article_number = p.article_number
         AND ph.checked_at < NOW() - (?::int * INTERVAL '1 day') ORDER BY ph.checked_at DESC LIMIT 1) AS prev
       FROM products p WHERE p.is_active = 1 AND p.category IS NOT NULL`,
      [days]
    )
  ).filter((r) => r.prev !== null && r.prev !== r.current_price);

  const byCategory = {};
  rows.forEach((r) => {
    if (!byCategory[r.category]) byCategory[r.category] = { category: r.category, drops: 0, rises: 0 };
    if (r.current_price < r.prev) byCategory[r.category].drops++;
    else byCategory[r.category].rises++;
  });

  res.json(Object.values(byCategory).sort((a, b) => b.drops + b.rises - (a.drops + a.rises)));
});

app.get('/api/export/csv', async (req, res) => {
  const rows = await db.query(`SELECT * FROM products WHERE is_active=1 ORDER BY category, name`);
  const header = 'article_number,name,category,current_price,currency,group_key,first_seen_at,last_checked_at,url\n';
  const csvBody = rows
    .map((r) =>
      [
        r.article_number,
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${(r.category || '').replace(/"/g, '""')}"`,
        r.current_price,
        r.currency,
        r.group_key || '',
        r.first_seen_at,
        r.last_checked_at,
        r.slug_url,
      ].join(',')
    )
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ikea-prix.csv"');
  res.send(header + csvBody);
});

app.get('/api/watchlist', async (req, res) => {
  const rows = (
    await db.query(
      `SELECT w.article_number, w.target_price, w.created_at,
              p.name, p.slug_url, p.current_price, p.currency, p.image_url
       FROM watchlist w JOIN products p ON p.article_number = w.article_number
       ORDER BY w.created_at DESC`
    )
  ).map((r) => ({ ...r, targetReached: r.current_price <= r.target_price }));
  res.json(rows);
});

app.post('/api/watchlist', async (req, res) => {
  const { articleNumber, targetPrice } = req.body;
  if (!articleNumber || !targetPrice) {
    return res.status(400).json({ error: 'articleNumber et targetPrice requis' });
  }
  await db.run(
    `INSERT INTO watchlist (article_number, target_price) VALUES (?, ?)
     ON CONFLICT (article_number) DO UPDATE SET target_price=excluded.target_price`,
    [articleNumber, targetPrice]
  );
  res.json({ status: 'ok' });
});

app.delete('/api/watchlist/:articleNumber', async (req, res) => {
  await db.run(`DELETE FROM watchlist WHERE article_number=?`, [req.params.articleNumber]);
  res.json({ status: 'ok' });
});

app.post('/api/admin/recompute-groups', async (req, res) => {
  try {
    const count = await recomputeAllGroupKeys();
    res.json({ status: 'ok', updated: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scrape-runs', async (req, res) => {
  res.json(await db.query(`SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 20`));
});

app.post('/api/scrape/run-now', async (req, res) => {
  const running = await db.queryOne(`SELECT * FROM scrape_runs WHERE status='running' ORDER BY id DESC LIMIT 1`);
  if (running) {
    return res.status(409).json({ status: 'already-running', run: running });
  }
  res.json({ status: 'started' });
  try {
    await runFullScrape();
  } catch (err) {
    console.error('Erreur pendant le scrape manuel:', err.message);
  }
});

app.post('/api/scrape/refresh-now', async (req, res) => {
  const running = await db.queryOne(`SELECT * FROM scrape_runs WHERE status='running' ORDER BY id DESC LIMIT 1`);
  if (running) {
    return res.status(409).json({ status: 'already-running', run: running });
  }
  res.json({ status: 'started' });
  try {
    await refreshKnownProducts();
  } catch (err) {
    console.error('Erreur pendant le rafraîchissement:', err.message);
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/api/debug/extract-price', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url requis' });

  const axios = require('axios');
  const cheerio = require('cheerio');
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'fr-MA,fr;q=0.9',
      },
    });
    const html = response.data;
    const $ = cheerio.load(html);

    const bodyText = $('body').text();
    const allPrices = [];
    let match;
    const priceRegex = /(\d[\d\s]*,\d{2})\s*DH(\/[^\s]+)?/g;
    while ((match = priceRegex.exec(bodyText)) !== null) {
      const price = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
      allPrices.push({ price, match: match[0], index: match.index });
    }

    let jsonLdPrice = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdPrice) return;
      try {
        const parsed = JSON.parse($(el).contents().text());
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const product = candidates.find((c) => c['@type'] === 'Product');
        if (product && product.offers) {
          const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          if (offer && offer.price) jsonLdPrice = { price: parseFloat(offer.price), source: 'json-ld' };
        }
      } catch (_) {}
    });

    res.json({
      url,
      h1: $('h1').first().text().trim(),
      jsonLdPrice,
      allPricesFoundInPage: allPrices.slice(0, 10),
      totalPricesFound: allPrices.length,
    });
  } catch (err) {
    res.json({ success: false, errorMessage: err.message });
  }
});

async function start() {
  try {
    await db.init();
  } catch (err) {
    console.error('❌ Échec initialisation base de données:', err.message);
    process.exit(1);
  }

  // Toute ligne encore "running" provient forcément d'un process tué par un redéploiement
  await db.run(`UPDATE scrape_runs SET status='interrupted', finished_at=NOW() WHERE status='running'`);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IKEA price tracker en écoute sur 0.0.0.0:${PORT}`);
  });

  cron.schedule('0 6 * * *', async () => {
    console.log('Cron: rafraîchissement quotidien des prix');
    try {
      await refreshKnownProducts();
    } catch (err) {
      console.error('Cron: erreur pendant le rafraîchissement:', err.message);
    }
  });

  cron.schedule('0 3 * * 0', async () => {
    console.log('Cron: découverte hebdomadaire des nouveaux produits');
    try {
      await runFullScrape();
    } catch (err) {
      console.error('Cron: erreur pendant la découverte complète:', err.message);
    }
  });
}

start();
