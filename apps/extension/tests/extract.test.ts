import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFixture } from './utils';
import { extractProductInfo, parseJsonLdProduct, parseOpenGraphProduct } from '../src/extract';

function docFrom(html: string, url: string): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe('extractProductInfo - JSON-LD', () => {
  it('extracts core fields from JSON-LD Product with offers and images', () => {
    const url = 'https://store.example.com/p/sku123';
    const doc = docFrom(readFixture('jsonld_product_full.html'), url);
    const info = extractProductInfo(doc);
    expect(info).not.toBeNull();
    expect(info!.title).toBe('Test Product');
    expect(info!.brand).toBe('Acme');
    expect(info!.price).toBe(129.99);
    expect(info!.currency).toBe('USD');
    expect(info!.images.length).toBeGreaterThan(0);
    expect(info!.url).toBe(url);
    expect(info!.retailer).toBe('store.example.com');
  });
});

describe('extractProductInfo - Open Graph', () => {
  it('falls back to OG meta tags', () => {
    const url = 'https://shop.example.com/product?id=1';
    const doc = docFrom(readFixture('og_product_full.html'), url);
    const info = extractProductInfo(doc);
    expect(info).not.toBeNull();
    expect(info!.title).toBe('OG Product Title');
    expect(info!.price).toBe(89.99);
    expect(info!.currency).toBe('USD');
    expect(info!.brand).toBe('Nike');
    expect(info!.images[0]).toMatch(/^https:\/\//);
    expect(info!.retailer).toBe('shop.example.com');
  });
});

describe('extractProductInfo - DOM heuristics', () => {
  it('extracts from headings, images, and price with CTA present', () => {
    const url = 'https://retailer.test/item/42';
    const doc = docFrom(readFixture('dom_heuristics_product_with_image.html'), url);
    const info = extractProductInfo(doc);
    expect(info).not.toBeNull();
    expect(info!.title).toContain('Air Max');
    expect(info!.brand).toBe('NIKE');
    expect(info!.price).toBe(129.99);
    expect(info!.currency).toBe('USD');
    expect(info!.images.length).toBeGreaterThan(0);
    expect(info!.url).toBe(url);
    expect(info!.retailer).toBe('retailer.test');
  });
});

describe('extractProductInfo - negatives and robustness', () => {
  it('returns null for a non-product article page', () => {
    const url = 'https://blog.example.com/post';
    const doc = docFrom(readFixture('article.html'), url);
    const info = extractProductInfo(doc);
    expect(info).toBeNull();
  });

  it('handles malformed JSON-LD without throwing', () => {
    const url = 'https://example.com/page';
    const doc = docFrom(readFixture('jsonld_invalid.html'), url);
    expect(() => parseJsonLdProduct(doc)).not.toThrow();
    expect(extractProductInfo(doc)).toBeNull();
  });
});

describe('merge priority - JSON-LD > OG > heuristics', () => {
  it('uses JSON-LD title over OG when both exist', () => {
    const url = 'https://mix.example.com/p';
    const html = `<!DOCTYPE html>
<html><head>
  <meta property="og:type" content="product">
  <meta property="og:title" content="OG Title">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"JSON-LD Title","image":"/p.jpg","offers":{"@type":"Offer","price":"10.00","priceCurrency":"USD"}}
  </script>
</head>
<body><main><img src="/p.jpg"/><button>Add to cart</button></main></body></html>`;
    const doc = docFrom(html, url);
    const info = extractProductInfo(doc);
    expect(info).not.toBeNull();
    expect(info!.title).toBe('JSON-LD Title');
  });
});
