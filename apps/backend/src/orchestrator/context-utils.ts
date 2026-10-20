import { query } from '../db';
import { logger } from '../log';

export interface ContextProduct {
  id: string;
  title: string;
  brand?: string;
  category?: string;
  sub_category?: string;
  color?: string;
  primary_material?: string;
  search_text?: string;
  embedding_text_semantic?: number[];
  embedding_image?: number[];
  // Price information from best offer
  price?: number;
  currency?: string;
}

/**
 * Fetch context product details from database
 */
export async function fetchContextProduct(productId: string): Promise<ContextProduct | null> {
  try {
    const result = await query(
      `SELECT 
        p.id::text as id,
        p.title, 
        p.brand, 
        p.category, 
        p.sub_category, 
        p.color, 
        p.primary_material, 
        p.search_text,
        p.embedding_text_semantic,
        p.embedding_image,
        -- Get best (lowest) current price from offers
        (
          SELECT o.price 
          FROM offers o 
          WHERE o.product_id = p.id AND o.in_stock = true 
          ORDER BY o.price ASC 
          LIMIT 1
        ) as price,
        (
          SELECT o.currency 
          FROM offers o 
          WHERE o.product_id = p.id AND o.in_stock = true 
          ORDER BY o.price ASC 
          LIMIT 1
        ) as currency
       FROM products p
       WHERE p.id = $1`,
      [productId]
    );
    
    if (result.rows.length === 0) {
      logger.warn({ productId }, '⚠️ Context product not found in database');
      return null;
    }
    
    const product = result.rows[0];
    const contextProduct = {
      ...product,
      embedding_text_semantic: product.embedding_text_semantic ? JSON.parse(product.embedding_text_semantic) : null,
      embedding_image: product.embedding_image ? JSON.parse(product.embedding_image) : null,
    };
    
    return contextProduct;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ 
      error: errorMessage,
      errorStack: error instanceof Error ? error.stack : undefined,
      productId 
    }, '❌ Failed to fetch context product');
    return null;
  }
}

/**
 * Check if a phrase is context-dependent
 */
export function isContextDependentPhrase(text: string): boolean {
  if (!text || !text.trim()) return false;
  
  const contextPhrases = [
    'similar', 'same', 'like', 'more like', 'alternatives', 'alternative',
    'other', 'different', 'similar to', 'more like this', 'like this',
    'similar to this', 'same as', 'like that', 'this one', 'this style',
    'this type', 'these', 'those'
  ];
  
  const lowerText = text.toLowerCase().trim();
  return contextPhrases.some(phrase => 
    lowerText === phrase || 
    lowerText.startsWith(phrase + ' ') ||
    lowerText.includes(' ' + phrase + ' ') ||
    lowerText.endsWith(' ' + phrase)
  );
}

/**
 * Extract modifications from user query
 */
export interface QueryModifications {
  colorChange?: string;
  priceConstraint?: { min?: number; max?: number };
  styleChanges?: string[];
  materialChange?: string;
}

export function extractQueryModifications(query: string | undefined): QueryModifications {
  const modifications: QueryModifications = {};
  
  if (!query || typeof query !== 'string') {
    logger.warn({ query }, '⚠️ extractQueryModifications called with invalid query');
    return modifications;
  }
  
  const lowerQuery = query.toLowerCase();
  
  // Color changes
  const colorPatterns = [
    /but in (\w+)/i,
    /in (\w+) instead/i,
    /change.*color to (\w+)/i,
    /(\w+) version/i,
    /(\w+) color/i
  ];
  
  for (const pattern of colorPatterns) {
    const match = lowerQuery.match(pattern);
    if (match && match[1]) {
      const color = match[1].trim();
      // Basic color validation
      const validColors = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'brown', 'grey', 'gray', 'navy', 'beige', 'cream'];
      if (validColors.includes(color)) {
        modifications.colorChange = color;
        break;
      }
    }
  }
  
  // Price constraints
  const pricePatterns = [
    /under ([£$€]?\d+)/i,
    /less than ([£$€]?\d+)/i,
    /below ([£$€]?\d+)/i,
    /max ([£$€]?\d+)/i,
    /up to ([£$€]?\d+)/i,
    /between ([£$€]?\d+) and ([£$€]?\d+)/i,
    /([£$€]?\d+) to ([£$€]?\d+)/i,
    /over ([£$€]?\d+)/i,
    /more than ([£$€]?\d+)/i,
    /above ([£$€]?\d+)/i,
    /min ([£$€]?\d+)/i
  ];
  
  for (const pattern of pricePatterns) {
    const match = lowerQuery.match(pattern);
    if (match) {
      if (!modifications.priceConstraint) modifications.priceConstraint = {};
      
      if (pattern.source.includes('between') || pattern.source.includes('to')) {
        // Range patterns
        const min = parseInt(match[1].replace(/[£$€]/g, ''));
        const max = parseInt(match[2].replace(/[£$€]/g, ''));
        modifications.priceConstraint = { min, max };
      } else if (pattern.source.includes('under') || pattern.source.includes('less') || 
                 pattern.source.includes('below') || pattern.source.includes('max') || 
                 pattern.source.includes('up to')) {
        // Maximum patterns
        const max = parseInt(match[1].replace(/[£$€]/g, ''));
        modifications.priceConstraint.max = max;
      } else {
        // Minimum patterns
        const min = parseInt(match[1].replace(/[£$€]/g, ''));
        modifications.priceConstraint.min = min;
      }
      break;
    }
  }
  
  // Style changes
  const styleKeywords = [
    'casual', 'formal', 'vintage', 'modern', 'classic', 'sporty', 
    'elegant', 'minimalist', 'oversized', 'fitted', 'relaxed'
  ];
  
  modifications.styleChanges = styleKeywords.filter(style => 
    lowerQuery.includes(style)
  );
  
  // Material changes
  const materialPatterns = [
    /in (\w+) material/i,
    /made of (\w+)/i,
    /(\w+) fabric/i,
    /but in (\w+)$/i  // At end of query, likely material not color
  ];
  
  const commonMaterials = ['cotton', 'wool', 'leather', 'suede', 'silk', 'polyester', 'denim', 'canvas', 'nylon', 'linen'];
  
  for (const pattern of materialPatterns) {
    const match = lowerQuery.match(pattern);
    if (match && match[1] && commonMaterials.includes(match[1])) {
      modifications.materialChange = match[1];
      break;
    }
  }
  
  return modifications;
}

/**
 * Generate modified search text based on context and modifications
 */
export function generateModifiedSearchText(
  contextProduct: ContextProduct,
  modifications: QueryModifications,
  userQuery: string
): string {
  let searchText = contextProduct.search_text || contextProduct.title || '';
  
  // Apply color change
  if (modifications.colorChange && contextProduct.color) {
    const colorRegex = new RegExp(`\\b${contextProduct.color}\\b`, 'gi');
    searchText = searchText.replace(colorRegex, modifications.colorChange);
  }
  
  // Apply material change
  if (modifications.materialChange && contextProduct.primary_material) {
    const materialRegex = new RegExp(`\\b${contextProduct.primary_material}\\b`, 'gi');
    searchText = searchText.replace(materialRegex, modifications.materialChange);
  }
  
  // Apply style changes
  if (modifications.styleChanges && modifications.styleChanges.length > 0) {
    // Add style descriptors if not already present
    const stylesToAdd = modifications.styleChanges.filter(style => 
      !searchText.toLowerCase().includes(style)
    );
    if (stylesToAdd.length > 0) {
      searchText = stylesToAdd.join(' ') + ' ' + searchText;
    }
  }
  
  return searchText.trim();
}

/**
 * Generate modified CLIP caption based on context and modifications
 */
export function generateModifiedClipCaption(
  contextProduct: ContextProduct,
  modifications: QueryModifications,
  userQuery: string
): string {
  // Start with a base description
  let caption = `a photo of a ${modifications.colorChange || contextProduct.color || ''} `;
  
  // Add material if specified
  if (modifications.materialChange || contextProduct.primary_material) {
    caption += `${modifications.materialChange || contextProduct.primary_material} `;
  }
  
  // Add product type
  const productType = contextProduct.sub_category || contextProduct.category || 'item';
  caption += productType.toLowerCase();
  
  // Add style modifiers
  if (modifications.styleChanges && modifications.styleChanges.length > 0) {
    caption += ` with ${modifications.styleChanges.join(' ')} style`;
  }
  
  return caption.trim();
}
