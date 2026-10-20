/**
 * Shared product data extraction utilities.
 * Works with both DOM (browser) and Cheerio (Node.js) environments.
 * 
 * This is the main entry point that orchestrates all extraction logic.
 */

import { DOMAdapter, ProductInfo, ExtractionResult, ExtractionContext } from './types.js';
import { 
  parseJsonLdProduct, 
  parseOpenGraphProduct, 
  parseNextDataProduct, 
  parseDomHeuristics 
} from './parsers.js';
import { mergeProductInfo, calculateConfidence } from './scoring.js';
import { enrichProductAttributes } from './attribute-detection.js';

// Simple logging for debugging (works in both browser and Node.js)
const debug = (message: string, data?: any) => {
  console.log(`[SharedExtraction] ${message}`, data || '');
};

// Main extraction function
export function extractProductInfo(doc: DOMAdapter): ProductInfo | null {
  const url = doc.getPageUrl() || 'unknown';
  const retailer = doc.getRetailer() || 'unknown';

  try {
    const base: Pick<ProductInfo, 'url' | 'retailer'> = {
      url,
      retailer
    };

    const fromJsonLd = parseJsonLdProduct(doc) || {};
    
    const fromOg = parseOpenGraphProduct(doc) || {};
    
    const fromNextData = parseNextDataProduct(doc) || {};

    const fromDom = parseDomHeuristics(doc) || {};
  
    const merged = mergeProductInfo(base, fromJsonLd, fromOg, fromNextData, fromDom);

    if (!merged) {
      return null;
    }

    // Enrich attributes by detecting category, subcategory, and material
    const enriched = enrichProductAttributes({
      title: merged.title || undefined,
      description: merged.description || undefined,
      category: merged.category || undefined,
      subcategory: merged.subCategory || undefined,
      material: merged.primaryMaterial || undefined,
      color: merged.color || undefined,
      brand: merged.brand || undefined,
      gender: merged.gender || undefined
    });

    // Always apply enriched attributes when detected
    if (enriched.category) {
      merged.category = enriched.category;
    }
    if (enriched.subcategory) {
      merged.subCategory = enriched.subcategory;
    }
    if (enriched.material) {
      merged.primaryMaterial = enriched.material;
    }
    if (enriched.color) {
      merged.color = enriched.color;
    }
    if (enriched.brand && !merged.brand) {
      merged.brand = enriched.brand;
    }
    if (enriched.gender) {
      merged.gender = enriched.gender;
    }
    // Update description with preserved original values if any were added
    if (enriched.description) {
      merged.description = enriched.description;
    }

    // Minimal usefulness: require either a price or at least one image.
    const hasUseful = (merged.price != null) || (Array.isArray(merged.images) && merged.images.length > 0);
    
    if (!hasUseful) {
      return null;
    }

    return merged;

  } catch (error) {
    return null;
  }
}

// Advanced extraction function with metadata
export function extractProductInfoWithMetadata(doc: DOMAdapter): ExtractionResult | null {
  const startTime = Date.now();
  const sources: string[] = [];
  const warnings: string[] = [];

  try {

    const url = doc.getPageUrl() || 'unknown';

    const retailer = doc.getRetailer() || 'unknown';
    
    const base: Pick<ProductInfo, 'url' | 'retailer'> = { url, retailer };

    // Extract from all sources
    const fromJsonLd = parseJsonLdProduct(doc);
    if (fromJsonLd && Object.keys(fromJsonLd).length > 0) sources.push('jsonld');

    const fromOg = parseOpenGraphProduct(doc);
    if (fromOg && Object.keys(fromOg).length > 0) sources.push('og');

    const fromNextData = parseNextDataProduct(doc);
    if (fromNextData && Object.keys(fromNextData).length > 0) sources.push('nextdata');

    const fromDom = parseDomHeuristics(doc);
    if (fromDom && Object.keys(fromDom).length > 0) sources.push('dom');

    // Merge results using intelligent scoring
    const merged = mergeProductInfo(base, fromJsonLd || {}, fromOg || {}, fromNextData || {}, fromDom || {});

    if (!merged) {
      warnings.push('No product data could be extracted');
      return null;
    }

    // Enrich attributes by detecting category, subcategory, and material
    const enriched = enrichProductAttributes({
      title: merged.title || undefined,
      description: merged.description || undefined,
      category: merged.category || undefined,
      subcategory: merged.subCategory || undefined,
      material: merged.primaryMaterial || undefined,
      color: merged.color || undefined,
      brand: merged.brand || undefined,
      gender: merged.gender || undefined
    });

    // Always apply enriched attributes when detected
    if (enriched.category) {
      merged.category = enriched.category;
    }
    if (enriched.subcategory) {
      merged.subCategory = enriched.subcategory;
    }
    if (enriched.material) {
      merged.primaryMaterial = enriched.material;
    }
    if (enriched.color) {
      merged.color = enriched.color;
    }
    if (enriched.brand) {
      merged.brand = enriched.brand;
    }
    if (enriched.gender) {
      merged.gender = enriched.gender;
    }
    // Update description with preserved original values if any were added
    if (enriched.description) {
      merged.description = enriched.description;
    }

    // Calculate confidence based on sources and data completeness
    const confidence = calculateConfidence(merged, sources);

    const extractionTime = Date.now() - startTime;

    // Minimal usefulness check
    const hasUseful = (merged.price != null) || (Array.isArray(merged.images) && merged.images.length > 0);
    
    if (!hasUseful) {
      warnings.push('Product not useful (no price and no images)');
      return null;
    }

    return {
      data: merged,
      metadata: {
        extractionTime,
        sources,
        confidence,
        warnings
      }
    };

  } catch (error) {
    const extractionTime = Date.now() - startTime;
    return {
      data: {
        title: null,
        brand: null,
        description: null,
        price: null,
        currency: null,
        condition: null,
        color: null,
        category: null,
        subCategory: null,
        primaryMaterial: null,
        images: [],
        url: 'unknown',
        retailer: 'unknown'
      },
      metadata: {
        extractionTime,
        sources: [],
        confidence: 0,
        warnings: [`Extraction failed: ${error instanceof Error ? error.message : String(error)}`]
      }
    };
  }
}

// Export all the types, adapters, parsers, and utilities
export * from './types.js';
export * from './adapters.js';
export * from './parsers.js';
export * from './utils.js';
export * from './scoring.js';
export * from './attribute-detection.js';
