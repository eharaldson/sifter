/**
 * Unified types for product extraction across extension and scrapers
 */

import { ExtractedProductInfo } from '@find/types';

// Use the shared ExtractedProductInfo but override required fields for extraction context
export interface ProductInfo extends Omit<ExtractedProductInfo, 'title' | 'price' | 'currency' | 'images' | 'url' | 'retailer'> {
  title: string | null;
  price: number | null;
  currency: string | null;
  images: string[];
  url: string;
  retailer: string;
  gender?: string | null; // 'male', 'female', or 'unisex'
}

export interface ExtractionContext {
  url: string;
  retailer: string;
}

export interface ExtractionResult {
  data: ProductInfo;
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
  textContent?: string;
  getPageUrl(): string | null;
  getRetailer(): string;
}

export interface ElementAdapter {
  textContent?: string | null;
  innerHTML?: string;
  tagName?: string;
  className?: string;
  id?: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ElementAdapter | null;
  querySelectorAll(selector: string): ElementAdapter[];
  closest(selector: string): ElementAdapter | null;
  parentElement?: ElementAdapter | null;
  attributes?: Array<{ name: string; value: string }>;
}

// Field source tracking for intelligent merging
export type FieldSource<T> = { 
  value: T | null | undefined; 
  source: 'jsonld' | 'og' | 'nextdata' | 'dom'; 
  score: number;
};
