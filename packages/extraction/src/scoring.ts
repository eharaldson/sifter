/**
 * Field scoring and merging system for intelligent product data consolidation
 * Based on the sophisticated frontend logic with enhancements
 */

import { ProductInfo, FieldSource } from './types.js';
import { stripHtml, normalizeTitle, normalizeBrand } from './utils.js';

export function scorePrice(amount: number | null, currency: string | null, src: FieldSource<any>['source']): number {
  if (amount == null) return -10;
  let s = 0;
  if (currency) s += 2;
  if (src === 'jsonld') s += 3; 
  else if (src === 'og') s += 1; 
  else if (src === 'nextdata') s += 2;
  else if (src === 'dom') s += 1; // Give DOM heuristics a base score too!
  
  return s;
}

export function scoreField(value: any, src: FieldSource<any>['source'], fieldType: 'title' | 'brand' | 'description' | 'color' | 'condition' | 'category' | 'material'): number {
  if (!value) return -10;
  
  let score = 0;
  
  // Base score by source reliability
  if (src === 'jsonld') score += 4;
  else if (src === 'nextdata') score += 3;
  else if (src === 'og') score += 2;
  else if (src === 'dom') score += 1;
  
  // Field-specific scoring
  switch (fieldType) {
    case 'title':
      if (typeof value === 'string' && value.length > 10) score += 2;
      if (typeof value === 'string' && value.length > 30) score += 1;
      break;
    case 'brand':
      if (typeof value === 'string' && value.length >= 2 && value.length <= 50) score += 2;
      break;
    case 'description':
      if (typeof value === 'string' && value.length > 50) score += 2;
      if (typeof value === 'string' && value.length > 200) score += 1;
      break;
    case 'color':
      if (typeof value === 'string' && value.length >= 3 && value.length <= 30) score += 2;
      break;
    case 'condition':
      if (['new', 'used', 'refurbished'].includes(value)) score += 3;
      break;
    case 'category':
    case 'material':
      if (typeof value === 'string' && value.length >= 2 && value.length <= 100) score += 2;
      break;
  }
  
  return score;
}

// Pick highest score; ties resolved by priority order JSONLD > NEXTDATA > OG > DOM
export function pickField<T>(...items: FieldSource<T>[]): T | null {
  const ranked = items
    .map(i => ({ ...i, s: i.score }))
    .sort((a, b) => b.s - a.s || (
      a.source === 'jsonld' ? -1 : 
      a.source === 'nextdata' ? (b.source === 'jsonld' ? 1 : -1) :
      a.source === 'og' ? (b.source === 'jsonld' || b.source === 'nextdata' ? 1 : -1) : 1
    ));
  return ranked[0]?.value ?? null;
}

export function mergeProductInfo(
  base: Pick<ProductInfo, 'url' | 'retailer'>,
  ...parts: Partial<ProductInfo>[]
): ProductInfo | null {
  // Map parts to sources in order: jsonld, og, nextdata, dom
  const sources: FieldSource<any>['source'][] = ['jsonld', 'og', 'nextdata', 'dom'];
  
  // Combine all descriptions intelligently
  const allDescriptions = parts
    .map(p => p?.description)
    .filter((d): d is string => !!d);

  const uniqueCleanDescriptions = Array.from(
    new Set(
      allDescriptions
        .map(d => stripHtml(d).trim())
        .filter(Boolean)
    )
  );
  
  // Smart field merging for price/currency
  const prices = parts.map((p, i) => ({
    value: p?.price,
    source: sources[i] as FieldSource<any>['source'],
    score: scorePrice(p?.price || null, p?.currency || null, sources[i] as FieldSource<any>['source'])
  }));
  
  const currencies = parts.map((p, i) => ({
    value: p?.currency,
    source: sources[i] as FieldSource<any>['source'],
    score: p?.price != null ? scorePrice(p.price, p?.currency || null, sources[i] as FieldSource<any>['source']) : -10
  }));

  // Smart field merging for other fields
  const titles = parts.map((p, i) => ({
    value: p?.title,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.title, sources[i] as FieldSource<any>['source'], 'title')
  }));

  const brands = parts.map((p, i) => ({
    value: p?.brand,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.brand, sources[i] as FieldSource<any>['source'], 'brand')
  }));

  const colors = parts.map((p, i) => ({
    value: p?.color,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.color, sources[i] as FieldSource<any>['source'], 'color')
  }));

  const conditions = parts.map((p, i) => ({
    value: p?.condition,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.condition, sources[i] as FieldSource<any>['source'], 'condition')
  }));

  const categories = parts.map((p, i) => ({
    value: p?.category,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.category, sources[i] as FieldSource<any>['source'], 'category')
  }));

  const subCategories = parts.map((p, i) => ({
    value: p?.subCategory,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.subCategory, sources[i] as FieldSource<any>['source'], 'category')
  }));

  const materials = parts.map((p, i) => ({
    value: p?.primaryMaterial,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.primaryMaterial, sources[i] as FieldSource<any>['source'], 'material')
  }));

  const genders = parts.map((p, i) => ({
    value: p?.gender,
    source: sources[i] as FieldSource<any>['source'],
    score: scoreField(p?.gender, sources[i] as FieldSource<any>['source'], 'category')
  }));

  const selectedPrice = pickField(...prices);
  const selectedCurrency = pickField(...currencies);

  const out: ProductInfo = {
    title: normalizeTitle(pickField(...titles) || '') || null,
    brand: normalizeBrand(pickField(...brands)) || null,
    description: uniqueCleanDescriptions.join('\n\n') || null,
    price: selectedPrice,
    currency: selectedCurrency,
    condition: pickField(...conditions),
    color: pickField(...colors),
    category: pickField(...categories),
    subCategory: pickField(...subCategories),
    primaryMaterial: pickField(...materials),
    gender: pickField(...genders) || null,
    images: [],
    url: base.url,
    retailer: base.retailer
  };

  // Merge images from all sources, maintaining order preference
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p.images) && p.images.length) {
      out.images.push(...p.images);
    }
  }
  
  // Dedupe images while preserving order
  out.images = Array.from(new Set(out.images));

  return out;
}

export function calculateConfidence(product: ProductInfo | null, sources: string[]): number {
  if (!product) return 0;
  
  let confidence = 0;
  
  // Base confidence from number of sources
  confidence += sources.length * 15;
  
  // Bonus for high-quality sources
  if (sources.includes('jsonld')) confidence += 25;
  if (sources.includes('nextdata')) confidence += 20;
  if (sources.includes('og')) confidence += 15;
  
  // Data completeness scoring
  if (product.title) confidence += 20;
  if (product.brand) confidence += 15;
  if (product.price != null) confidence += 25;
  if (product.currency) confidence += 10;
  if (product.description) confidence += 10;
  if (product.images.length > 0) confidence += 15;
  if (product.images.length > 2) confidence += 5;
  if (product.category) confidence += 5;
  if (product.color) confidence += 5;
  if (product.condition) confidence += 5;
  
  // Cap at 100
  return Math.min(confidence, 100);
}
