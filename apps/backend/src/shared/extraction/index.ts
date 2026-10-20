/**
 * Main extraction interface that combines all extraction strategies
 */

import { DOMAdapter, ExtractedProductData, ExtractionContext, ExtractionResult } from './types';
import { parseJsonLdProduct, parseOpenGraphProduct, parseDomHeuristics } from './extractors';

type FieldSource<T> = { value: T | null | undefined; source: 'jsonld' | 'og' | 'dom'; score: number };

export class UniversalProductExtractor {
  async extractProduct(doc: DOMAdapter, context: ExtractionContext): Promise<ExtractionResult> {
    const startTime = Date.now();
    const sources: string[] = [];
    const warnings: string[] = [];

    // Extract from all sources
    const fromJsonLd = parseJsonLdProduct(doc);
    if (fromJsonLd && Object.keys(fromJsonLd).length > 0) sources.push('jsonld');

    const fromOg = parseOpenGraphProduct(doc);
    if (fromOg && Object.keys(fromOg).length > 0) sources.push('og');

    const fromDom = parseDomHeuristics(doc);
    if (fromDom && Object.keys(fromDom).length > 0) sources.push('dom');

    // Merge results using intelligent scoring
    const merged = this.mergeProductInfo(fromJsonLd || {}, fromOg || {}, fromDom || {});

    if (!merged) {
      warnings.push('No product data could be extracted');
    }

    // Calculate confidence based on sources and data completeness
    const confidence = this.calculateConfidence(merged, sources);

    const extractionTime = Date.now() - startTime;

    return {
      data: merged || this.getEmptyProductData(),
      metadata: {
        extractionTime,
        sources,
        confidence,
        warnings
      }
    };
  }

  private mergeProductInfo(
    jsonld: Partial<ExtractedProductData>,
    og: Partial<ExtractedProductData>,
    dom: Partial<ExtractedProductData>
  ): ExtractedProductData | null {
    const parts = [jsonld, og, dom];
    const sources: FieldSource<any>['source'][] = ['jsonld', 'og', 'dom'];

    // Smart field merging using scoring
    const descriptions = parts.map((p, i) => ({
      value: p?.description,
      source: sources[i],
      score: this.scoreDescription(p?.description || null, sources[i])
    }));

    const prices = parts.map((p, i) => ({
      value: p?.price,
      source: sources[i],
      score: this.scorePrice(p?.price || null, p?.currency || null, sources[i])
    }));

    const currencies = parts.map((p, i) => ({
      value: p?.currency,
      source: sources[i],
      score: p?.price != null ? this.scorePrice(p.price, p?.currency || null, sources[i]) : -10
    }));

    const out: ExtractedProductData = {
      title: null,
      brand: null,
      description: this.pickField(...descriptions),
      price: this.pickField(...prices),
      currency: this.pickField(...currencies),
      condition: null,
      color: null,
      material: null,
      category: null,
      subCategory: null,
      images: [],
      gtin: null,
      mpn: null,
      sku: null
    };

    // For other fields, use first-wins logic with JSON-LD preference
    for (const p of parts) {
      if (!p) continue;
      if (out.title == null && p.title != null) out.title = p.title;
      if (out.brand == null && p.brand != null) out.brand = p.brand;
      if (out.condition == null && p.condition != null) out.condition = p.condition;
      if (out.color == null && p.color != null) out.color = p.color;
      if (out.material == null && p.material != null) out.material = p.material;
      if (out.category == null && p.category != null) out.category = p.category;
      if (out.subCategory == null && p.subCategory != null) out.subCategory = p.subCategory;
      if (out.gtin == null && p.gtin != null) out.gtin = p.gtin;
      if (out.mpn == null && p.mpn != null) out.mpn = p.mpn;
      if (out.sku == null && p.sku != null) out.sku = p.sku;
      if (Array.isArray(p.images) && p.images.length) out.images.push(...p.images);
    }

    // Dedupe images
    out.images = Array.from(new Set(out.images));

    // Check if we have meaningful data
    const hasUseful = (out.price != null) || (out.images.length > 0) || (out.title != null);
    return hasUseful ? out : null;
  }

  private scoreDescription(v: string | null, src: FieldSource<any>['source']): number {
    if (!v || v.length < 25) return -10;
    const len = v.length;
    const srcBonus = src === 'jsonld' ? 2 : src === 'og' ? 1 : 0;
    return Math.min(10, Math.floor(len / 80)) + srcBonus;
  }

  private scorePrice(amount: number | null, currency: string | null, src: FieldSource<any>['source']): number {
    if (amount == null) return -10;
    let s = 0;
    if (currency) s += 2;
    if (src === 'jsonld') s += 3;
    else if (src === 'og') s += 1;
    return s;
  }

  private pickField<T>(...items: FieldSource<T>[]): T | null {
    const ranked = items
      .map(i => ({ ...i, s: i.score }))
      .sort((a, b) => b.s - a.s || (
        a.source === 'jsonld' ? -1 :
        a.source === 'og' ? (b.source === 'jsonld' ? 1 : -1) : 1
      ));
    return ranked[0]?.value ?? null;
  }

  private calculateConfidence(data: ExtractedProductData | null, sources: string[]): number {
    if (!data) return 0;

    let confidence = 0;

    // Base confidence from sources
    if (sources.includes('jsonld')) confidence += 40;
    if (sources.includes('og')) confidence += 20;
    if (sources.includes('dom')) confidence += 10;

    // Bonus for key fields
    if (data.title) confidence += 15;
    if (data.price && data.currency) confidence += 20;
    if (data.brand) confidence += 10;
    if (data.images.length > 0) confidence += 10;
    if (data.description) confidence += 5;

    return Math.min(100, confidence);
  }

  private getEmptyProductData(): ExtractedProductData {
    return {
      title: null,
      brand: null,
      description: null,
      price: null,
      currency: null,
      condition: null,
      color: null,
      material: null,
      category: null,
      subCategory: null,
      images: [],
      gtin: null,
      mpn: null,
      sku: null
    };
  }
}

// Export convenience function
export async function extractProductData(
  doc: DOMAdapter, 
  context: ExtractionContext
): Promise<ExtractionResult> {
  const extractor = new UniversalProductExtractor();
  return extractor.extractProduct(doc, context);
}

// Re-export types and adapters
export * from './types';
export * from './adapters';
export * from './utils';
