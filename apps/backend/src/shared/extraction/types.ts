/**
 * Shared types for product extraction across extension and scrapers
 */

export interface ExtractedProductData {
  title: string | null;
  brand: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  originalPrice?: number | null;
  condition?: 'new' | 'used' | 'refurbished' | null;
  color?: string | null;
  material?: string | null;
  category?: string | null;
  subCategory?: string | null;
  images: string[];
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
}

export interface ExtractionContext {
  url: string;
  retailer: string;
}

export interface ExtractionResult {
  data: ExtractedProductData;
  metadata: {
    extractionTime: number;
    sources: string[];
    confidence: number;
    warnings: string[];
  };
}

// Abstract interface for DOM-like operations that works with both DOM and Cheerio
export interface DOMAdapter {
  querySelector(selector: string): ElementAdapter | null;
  querySelectorAll(selector: string): ElementAdapter[];
  title: string;
  baseURI: string;
  body: ElementAdapter | null;
}

export interface ElementAdapter {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ElementAdapter | null;
  querySelectorAll(selector: string): ElementAdapter[];
  tagName: string;
  className: string;
  id: string;
  closest(selector: string): ElementAdapter | null;
  parentElement: ElementAdapter | null;
}
