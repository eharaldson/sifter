import { ExtractedProductInfo } from '@find/types';

// Use the shared ExtractedProductInfo type
export type ExtractedProduct = ExtractedProductInfo;

export interface NormalizedProduct {
  title: string;
  brand: string | null;
  description: string | null;
  search_text: string | null;
  price: number;
  currency: string;
  originalPrice: number | null;
  condition: string;
  imageUrl: string | null;
  color: string | null;
  primaryMaterial: string | null;
  category: string | null;
  subCategory: string | null;
  gender: string | null;
  gtin: string | null;
  mpn: string | null;
  sku: string | null;
}

/**
 * Normalize extracted product data for consistent matching
 */
export function normalizeExtracted(extracted: ExtractedProduct): NormalizedProduct {
  var normalized = {
    title: normalizeTitle(extracted.title),
    brand: normalizeBrand(extracted.brand),
    description: normalizeText(extracted.description),
    price: extracted.price,
    currency: extracted.currency.toUpperCase(), // Keep currency uppercase for consistency
    originalPrice: extracted.originalPrice || null,
    condition: normalizeCondition(extracted.condition).toLowerCase(), // Convert condition to lowercase
    imageUrl: extracted.images?.[0] || null,
    color: normalizeText(extracted.color),
    primaryMaterial: normalizeText(extracted.primaryMaterial),
    category: normalizeText(extracted.category),
    subCategory: normalizeText(extracted.subCategory),
    gender: normalizeGender(extracted.gender),
    gtin: normalizeCode(extracted.gtin),
    mpn: normalizeCode(extracted.mpn),
    sku: normalizeCode(extracted.sku),
    search_text: null as string | null
  };
  
  // Generate search_text from normalized data
  normalized.search_text = createSearchText(normalized) || null;
  
  return normalized;
}

/**
 * Normalize title by removing common noise and standardizing format
 */
export function normalizeTitle(title: string): string {
  if (!title) return '';
  
  return title
    .trim()
    .toLowerCase() // Convert to lowercase
    .replace(/\s+/g, ' ') // Multiple spaces to single space
    .replace(/[™®©]/g, '') // Remove trademark symbols
    .replace(/\b(size|sz)\s*:?\s*\w+/gi, '') // Remove size indicators
    .replace(/\b(sku|item)\s*:?\s*[\w-]+/gi, '') // Remove SKU references
    .replace(/\s+/g, ' ') // Clean up spaces again
    .trim();
}

/**
 * Normalize brand name for consistent matching
 */
export function normalizeBrand(brand: string | null | undefined): string | null {
  if (!brand) return null;
  
  return brand
    .trim()
    .toLowerCase()
    .replace(/[™®©]/g, '') // Remove trademark symbols
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/**
 * Normalize general text fields
 */
export function normalizeText(text: string | null | undefined): string | null {
  if (!text) return null;
  
  return text
    .trim()
    .toLowerCase() // Convert to lowercase
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/**
 * Normalize product codes (GTIN, MPN, SKU)
 */
export function normalizeCode(code: string | null | undefined): string | null {
  if (!code) return null;
  
  const normalized = code
    .trim()
    .replace(/[^\w-]/g, '') // Keep only alphanumeric and hyphens
    .toUpperCase();
    
  return normalized || null;
}

/**
 * Normalize condition to standard values
 */
export function normalizeCondition(condition: string | null | undefined): string {
  if (!condition) return 'new';
  
  const normalized = condition.toLowerCase().trim();
  
  if (normalized.includes('used') || normalized.includes('second')) return 'used';
  if (normalized.includes('refurb') || normalized.includes('renewed')) return 'refurbished';
  
  return 'new';
}

/**
 * Normalize gender to standard values: 'male', 'female', or 'unisex'
 */
export function normalizeGender(gender: string | null | undefined): string | null {
  if (!gender) return 'unisex'; // Default to unisex if not specified
  
  const normalized = gender.toLowerCase().trim();
  
  // Map various gender terms to standard values
  if (normalized === 'male' || normalized === 'men' || normalized === "men's" || normalized === 'mens' || 
      normalized === 'man' || normalized === 'gentleman' || normalized === 'gentlemen' || 
      normalized === 'boy' || normalized === 'boys') {
    return 'male';
  }
  
  if (normalized === 'female' || normalized === 'women' || normalized === "women's" || normalized === 'womens' || 
      normalized === 'woman' || normalized === 'lady' || normalized === 'ladies' || 
      normalized === 'girl' || normalized === 'girls') {
    return 'female';
  }
  
  if (normalized === 'unisex' || normalized === 'gender neutral' || normalized === 'gender-neutral' || 
      normalized === 'all genders' || normalized === 'all-gender') {
    return 'unisex';
  }
  
  // Default to unisex if unrecognized
  return 'unisex';
}

/**
 * Create a search text for embedding generation
 */
export function createSearchText(normalized: NormalizedProduct): string {
  const parts = [
    normalized.title,
    normalized.brand,
    normalized.color,
    normalized.primaryMaterial,
    normalized.description
  ].filter(Boolean);
  
  return parts.join(' ').trim();
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
