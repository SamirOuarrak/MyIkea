// tests/scraper.test.js
//
// Tests unitaires des fonctions PURES du scraper (pas d'accès réseau ni base de données).
// Utilise le test runner intégré à Node.js (node:test) — aucune dépendance à installer.
//
// Lancer avec : npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProductPage, deriveGroupKey } = require('../scraper');

// ---------- deriveGroupKey ----------

test('deriveGroupKey: retire la couleur et regroupe deux variantes du même produit', () => {
  const key1 = deriveGroupKey('ONSEVIG Tapis, poils ras, bleu, 160x235 cm', 'Tapis');
  const key2 = deriveGroupKey('ONSEVIG Tapis, poils ras, rouge, 160x235 cm', 'Tapis');
  assert.equal(key1, key2, 'deux couleurs du même tapis doivent partager la même clé');
});

test('deriveGroupKey: retire les dimensions et regroupe deux tailles du même produit', () => {
  const key1 = deriveGroupKey('ONSEVIG Tapis, poils ras, bleu, 160x235 cm', 'Tapis');
  const key2 = deriveGroupKey('ONSEVIG Tapis, poils ras, bleu, 200x300 cm', 'Tapis');
  assert.equal(key1, key2, 'deux tailles du même tapis doivent partager la même clé');
});

test('deriveGroupKey: deux produits différents ont des clés différentes', () => {
  const key1 = deriveGroupKey('ONSEVIG Tapis, poils ras, bleu, 160x235 cm', 'Tapis');
  const key2 = deriveGroupKey('STOCKHOLM Tapis, poils ras, bleu, 160x235 cm', 'Tapis');
  assert.notEqual(key1, key2, 'deux produits différents ne doivent pas partager la même clé');
});

test('deriveGroupKey: la catégorie fait partie de la clé (évite les collisions entre catégories)', () => {
  const key1 = deriveGroupKey('PÄRKLA Boîte de rangement, blanc', 'Rangement');
  const key2 = deriveGroupKey('PÄRKLA Boîte de rangement, blanc', 'Cuisine');
  assert.notEqual(key1, key2, 'le même nom dans deux catégories différentes doit donner des clés différentes');
});

test('deriveGroupKey: renvoie null si le nom est vide', () => {
  assert.equal(deriveGroupKey('', 'Tapis'), null);
  assert.equal(deriveGroupKey(null, 'Tapis'), null);
});

test('deriveGroupKey: fonctionne sans catégorie (fallback "general")', () => {
  const key = deriveGroupKey('PÄRKLA Boîte de rangement, blanc', null);
  assert.ok(key.startsWith('general--'));
});

// ---------- parseProductPage ----------

function htmlWithJsonLd(price, currency = 'MAD') {
  return `
    <html><head>
      <script type="application/ld+json">
        {"@type": "Product", "name": "PÄRKLA Boîte de rangement", "sku": "801.467.63",
         "image": "https://example.com/img.jpg",
         "offers": {"price": "${price}", "priceCurrency": "${currency}"}}
      </script>
    </head><body><h1>PÄRKLA Boîte de rangement</h1></body></html>
  `;
}

test('parseProductPage: extrait le prix depuis le JSON-LD quand disponible', () => {
  const result = parseProductPage(htmlWithJsonLd(349), 'https://example.com/p/test');
  assert.equal(result.price, 349);
  assert.equal(result.articleNumber, '801.467.63');
  assert.equal(result.method, 'json-ld');
});

test('parseProductPage: ignore un prix JSON-LD hors plage réaliste (ex: 0 ou négatif)', () => {
  const result = parseProductPage(htmlWithJsonLd(0), 'https://example.com/p/test');
  // Doit retomber sur le fallback regex, qui échouera ici faute de motif "XX,XX DH" dans le HTML
  assert.equal(result.method, undefined);
  assert.ok(result.failReason);
});

test('parseProductPage: prend le PLUS GRAND prix valide en fallback (évite le piège prix/m²)', () => {
  // Cas réel rencontré : un tapis affichait "33,25DH/m²" avant le vrai prix total "349,00DH"
  const html = `
    <html><body>
      <h1>ONSEVIG Tapis</h1>
      <div>Article number 801.467.63</div>
      <div>33,25DH/m²</div>
      <div>349,00DH</div>
    </body></html>
  `;
  const result = parseProductPage(html, 'https://example.com/p/test');
  assert.equal(result.price, 349, 'doit choisir 349 (le prix total) plutôt que 33.25 (le prix au m²)');
  assert.equal(result.method, 'regex-fallback-max-valid');
});

test('parseProductPage: renvoie failReason="no-price-pattern-found" si aucun prix DH trouvé', () => {
  const html = `<html><body><h1>Produit sans prix</h1><div>Article number 801.467.63</div></body></html>`;
  const result = parseProductPage(html, 'https://example.com/p/test');
  assert.equal(result.failReason, 'no-price-pattern-found');
});

test('parseProductPage: renvoie failReason="no-article-number" si le numéro d\'article est absent', () => {
  const html = `<html><body><h1>Produit</h1><div>349,00DH</div></body></html>`;
  const result = parseProductPage(html, 'https://example.com/p/test');
  assert.equal(result.failReason, 'no-article-number');
});

test('parseProductPage: détecte un blocage anti-bot (mot-clé "captcha")', () => {
  const html = `<html><body><h1>Vérification</h1><div>Please complete the captcha to continue</div></body></html>`;
  const result = parseProductPage(html, 'https://example.com/p/test');
  assert.equal(result.failReason, 'blocked');
});
