import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFixture } from './utils';
import { hasJsonLdProduct, hasOgProduct, hasDomHeuristics, isProductPage } from '../src/detect';

function docFrom(html: string): Document {
  const dom = new JSDOM(html);
  return dom.window.document;
}

describe('JSON-LD detection', () => {
  it('detects @type:"Product" as single object', () => {
    const doc = docFrom(readFixture('jsonld_product.html'));
    expect(hasJsonLdProduct(doc)).toBe(true);
    expect(isProductPage(doc)).toBe(true);
  });

  it('detects Product in top-level array', () => {
    const doc = docFrom(readFixture('jsonld_product_array.html'));
    expect(hasJsonLdProduct(doc)).toBe(true);
  });

  it('detects Product inside @graph', () => {
    const doc = docFrom(readFixture('jsonld_product_graph.html'));
    expect(hasJsonLdProduct(doc)).toBe(true);
  });

  it('handles mixed @type arrays ["Thing","Product"]', () => {
    const doc = docFrom(readFixture('jsonld_product_mixed_type_array.html'));
    expect(hasJsonLdProduct(doc)).toBe(true);
  });

  it('ignores invalid JSON and empty scripts without crashing', () => {
    const invalidDoc = docFrom(readFixture('jsonld_invalid.html'));
    expect(hasJsonLdProduct(invalidDoc)).toBe(false);

    const emptyDoc = docFrom(readFixture('jsonld_empty.html'));
    expect(hasJsonLdProduct(emptyDoc)).toBe(false);
  });
});

describe('Open Graph detection', () => {
  it('detects og:type=product (case and whitespace tolerant)', () => {
    const doc1 = docFrom(readFixture('og_product.html'));
    expect(hasOgProduct(doc1)).toBe(true);
    expect(isProductPage(doc1)).toBe(true);

    const doc2 = docFrom(readFixture('og_product_whitespace.html'));
    expect(hasOgProduct(doc2)).toBe(true);
  });

  it('returns false for other og types', () => {
    const doc = docFrom(readFixture('og_not_product.html'));
    expect(hasOgProduct(doc)).toBe(false);
  });
});

describe('DOM heuristics', () => {
  it('passes when price and CTA exist ($)', () => {
    const doc = docFrom(readFixture('dom_heuristics_product.html'));
    expect(hasDomHeuristics(doc)).toBe(true);
    expect(isProductPage(doc)).toBe(true);
  });

  it('handles Euro price format and "Add to bag" CTA', () => {
    const doc = docFrom(readFixture('dom_heuristics_product_euro.html'));
    expect(hasDomHeuristics(doc)).toBe(true);
  });

  it('handles "Buy now" CTA and GBP price', () => {
    const doc = docFrom(readFixture('dom_heuristics_product_buy_now.html'));
    expect(hasDomHeuristics(doc)).toBe(true);
  });

  it('negatives: category page (many prices, no CTA near main)', () => {
    const doc = docFrom(readFixture('category.html'));
    expect(hasDomHeuristics(doc)).toBe(false);
    expect(isProductPage(doc)).toBe(false);
  });

  it('negatives: blog/news article mentioning prices', () => {
    const doc = docFrom(readFixture('article.html'));
    expect(hasDomHeuristics(doc)).toBe(false);
    expect(isProductPage(doc)).toBe(false);
  });

  it('negatives: search results page', () => {
    const doc = docFrom(readFixture('search.html'));
    expect(hasDomHeuristics(doc)).toBe(false);
    expect(isProductPage(doc)).toBe(false);
  });
});
