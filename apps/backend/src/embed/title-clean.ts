import { logger } from '../log';
import { NormalizedProduct } from '../match/normalize';

// ============================================
// Clean Title Generation Pipeline
// ============================================

// Normalization dictionaries (small, deterministic)
const COLOR_FAMILIES: { [key: string]: string } = {
  // Green family
  'olive': 'green', 'forest': 'green', 'khaki': 'green', 'emerald': 'green', 
  'lime': 'green', 'mint': 'green', 'sage': 'green',
  
  // Red family
  'burgundy': 'red', 'maroon': 'red', 'crimson': 'red', 'scarlet': 'red', 
  'cherry': 'red', 'wine': 'red',
  
  // Blue family
  'navy': 'blue', 'royal': 'blue', 'sky': 'blue', 'teal': 'blue', 
  'turquoise': 'blue', 'cobalt': 'blue',
  
  // Gray family
  'silver': 'gray', 'charcoal': 'gray', 'slate': 'gray', 'gunmetal': 'gray',
  
  // Brown family
  'tan': 'brown', 'beige': 'brown', 'chocolate': 'brown', 'coffee': 'brown', 
  'camel': 'brown', 'cognac': 'brown',
  
  // Yellow family
  'gold': 'yellow', 'amber': 'yellow', 'mustard': 'yellow', 'cream': 'yellow',
  
  // Purple family
  'violet': 'purple', 'lavender': 'purple', 'plum': 'purple', 'magenta': 'purple'
};

const MATERIAL_NORMALIZATION: { [key: string]: string } = {
  // Cotton variations
  '100% cotton': 'cotton', 'pure cotton': 'cotton', 'organic cotton': 'cotton',
  
  // Metal variations
  'stainless steel': 'steel', '316l steel': 'steel', 'surgical steel': 'steel',
  'sterling silver': 'silver', '925 silver': 'silver',
  
  // Leather variations
  'genuine leather': 'leather', 'full grain leather': 'leather', 'top grain leather': 'leather',
  'patent leather': 'leather', 'nappa leather': 'leather',
  
  // Synthetic variations
  'faux leather': 'synthetic', 'vegan leather': 'synthetic', 'pleather': 'synthetic',
  
  // Fabric variations
  'poly': 'polyester', 'elastane': 'spandex', 'lycra': 'spandex'
};

const GENDER_NORMALIZATION: { [key: string]: string } = {
  "men's": 'men', 'mens': 'men', 'male': 'men', 'gentleman': 'men',
  "women's": 'women', 'womens': 'women', 'ladies': 'women', 'female': 'women',
  'unisex': 'unisex', 'gender neutral': 'unisex'
};

// Product type patterns (prefer specific subcategories)
const SPECIFIC_SUBCATEGORIES = new Set([
  'bomber jacket', 'puffer jacket', 'denim jacket', 'leather jacket',
  'round sunglasses', 'aviator sunglasses', 'cat eye sunglasses', 'wayfarer sunglasses',
  'chelsea boots', 'combat boots', 'ankle boots', 'knee boots',
  'crew neck', 'v neck', 'turtle neck', 'off shoulder',
  'midi dress', 'maxi dress', 'mini dress', 'wrap dress',
  'straight jeans', 'skinny jeans', 'wide leg jeans', 'bootcut jeans'
]);

// Boilerplate removal patterns (aligned with search-text.ts)
const BOILERPLATE_PATTERNS = [
  // Product codes and SKUs
  /product sku:?\s*[a-zA-Z0-9_\-:]+/gi,
  /sku:?\s*[a-zA-Z0-9_\-:]+/gi,
  /item code:?\s*[a-zA-Z0-9_\-:]+/gi,
  /product code:?\s*[a-zA-Z0-9_\-:]+/gi,
  /style code:?\s*[a-zA-Z0-9_\-:]+/gi,
  
  // Sales and availability phrases
  /similar products? also available/gi,
  /sale now on/gi, /on sale now/gi, /also available/gi,
  /view similar/gi, /see more/gi, /browse similar/gi,
  /you might also like/gi, /customers also bought/gi,
  
  // Season codes and internal references
  /[a-z]{2}\d{2}\s*\d{2}/gi, // fw24 25, ss23 24, etc.
  /\b[a-z]{2}\d{4}\b/gi, // fw2024, ss2023, etc.
  
  // Generic buy/shop phrases
  /buy\s+[a-z\s]+\s+women?s?\s+[a-z\s]+/gi,
  /buy\s+[a-z\s]+\s+men?s?\s+[a-z\s]+/gi,
  
  // Standard boilerplate
  /free shipping/gi, /free returns/gi, /30 day returns/gi, /money back guarantee/gi,
  /customer service/gi, /contact us/gi, /size guide/gi, /care instructions/gi,
  /machine wash/gi, /dry clean/gi, /model is wearing/gi, /model height/gi,
  /true to size/gi, /runs small/gi, /runs large/gi, /available in store/gi,
  /online exclusive/gi, /limited edition/gi, /new arrival/gi, /bestseller/gi,
  /trending/gi, /must have/gi, /perfect for/gi, /ideal for/gi, /great for/gi,
  /shop now/gi, /buy now/gi, /add to cart/gi, /official/gi,
  /delivery/gi, /returns/gi, /terms and conditions/gi, /save \d+%/gi, 
  /was £?\$?\d+/gi, /now £?\$?\d+/gi, /rrp £?\$?\d+/gi, /retail price/gi
];

/**
 * Generate a clean, human-readable title for UI display and embedding
 */
export function generateCleanTitle(product: NormalizedProduct): string {
  logger.debug({ productTitle: product.title }, 'Generating clean title');
  
  // 1. Normalize core components
  const brand = normalizeBrand(product.brand);
  const productType = extractProductType(product.title, product.subCategory, product.category);
  const color = normalizeColor(product.color);
  const material = normalizeMaterial(product.primaryMaterial);
  
  // 2. Extract key attributes from description and title
  const keyAttrs = extractKeyAttributes(product, productType, color, material);
  
  // 3. Build the title
  const title = buildCleanTitle({
    brand,
    productType,
    keyAttrs,
    color,
    material
  });
  
  logger.debug({ 
    originalTitle: product.title,
    cleanTitle: title,
    components: { brand, productType, color, material, keyAttrsCount: keyAttrs.length }
  }, 'Clean title generated');
  
  return title;
}

/**
 * Normalize brand name to Title Case
 */
function normalizeBrand(brand?: string | null): string | null {
  if (!brand) return null;
  
  return brand
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .replace(/[^\w\s&.-]/g, '') // Keep alphanumeric, spaces, ampersands, periods, hyphens
    .trim();
}

/**
 * Extract product type from subcategory or title
 */
function extractProductType(title?: string | null, subCategory?: string | null, category?: string | null): string | null {
  // First check if subcategory is specific and useful
  if (subCategory) {
    const lowerSub = subCategory.toLowerCase().trim();
    if (SPECIFIC_SUBCATEGORIES.has(lowerSub)) {
      return lowerSub;
    }
  }
  
  // Extract from title using noun phrases
  if (title) {
    const titleLower = title.toLowerCase();
    
    // Check for specific patterns first
    for (const specificType of SPECIFIC_SUBCATEGORIES) {
      if (titleLower.includes(specificType)) {
        return specificType;
      }
    }
    
    // Fallback to extracting main noun
    const words = titleLower.split(/\s+/);
    const productWords = words.filter(word => 
      word.length > 3 && 
      !['the', 'and', 'with', 'from', 'this', 'that', 'for'].includes(word) &&
      /^[a-z]+$/.test(word) // Only alphabetic words
    );
    
    if (productWords.length > 0) {
      return productWords[0];
    }
  }
  
  // Final fallback to category
  return category?.toLowerCase() || null;
}

/**
 * Normalize color to color family
 */
function normalizeColor(color?: string | null): string | null {
  if (!color) return null;
  
  const lowerColor = color.toLowerCase().trim();
  
  // Check color families first
  if (COLOR_FAMILIES[lowerColor]) {
    return COLOR_FAMILIES[lowerColor];
  }
  
  // Return as-is if it's a basic color
  const basicColors = ['black', 'white', 'gray', 'brown', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink'];
  if (basicColors.includes(lowerColor)) {
    return lowerColor;
  }
  
  return null;
}

/**
 * Normalize material
 */
function normalizeMaterial(material?: string | null): string | null {
  if (!material) return null;
  
  const lowerMaterial = material.toLowerCase().trim();
  
  // Check normalization mappings
  if (MATERIAL_NORMALIZATION[lowerMaterial]) {
    return MATERIAL_NORMALIZATION[lowerMaterial];
  }
  
  // Return as-is if it's a basic material
  const basicMaterials = ['cotton', 'leather', 'wool', 'silk', 'polyester', 'nylon', 'acetate', 'metal', 'steel', 'silver', 'gold'];
  if (basicMaterials.includes(lowerMaterial)) {
    return lowerMaterial;
  }
  
  return null;
}

/**
 * Extract key attributes using vertical-specific patterns
 */
function extractKeyAttributes(
  product: NormalizedProduct, 
  productType?: string | null,
  color?: string | null,
  material?: string | null
): string[] {
  const text = `${product.title || ''} ${product.description || ''}`.toLowerCase();
  const attributes: Set<string> = new Set();
  
  // Determine vertical based on category/product type
  const vertical = determineVertical(product.category, product.subCategory, productType);
  
  // Extract attributes based on vertical
  switch (vertical) {
    case 'sunglasses':
      extractSunglassesAttributes(text, attributes);
      break;
    case 'footwear':
      extractFootwearAttributes(text, attributes);
      break;
    case 'apparel':
      extractApparelAttributes(text, attributes);
      break;
    default:
      extractGeneralAttributes(text, attributes);
  }
  
  // Filter out duplicates of color/material/type
  const filtered = Array.from(attributes).filter(attr => {
    const attrLower = attr.toLowerCase();
    return !(
      (color && attrLower.includes(color)) ||
      (material && attrLower.includes(material)) ||
      (productType && attrLower.includes(productType))
    );
  });
  
  // Return top 2 attributes
  return filtered.slice(0, 2);
}

/**
 * Determine product vertical for attribute extraction
 */
function determineVertical(category?: string | null, subCategory?: string | null, productType?: string | null): string {
  const text = `${category || ''} ${subCategory || ''} ${productType || ''}`.toLowerCase();
  
  if (text.includes('sunglasses') || text.includes('glasses')) return 'sunglasses';
  if (text.includes('shoes') || text.includes('boots') || text.includes('sneakers')) return 'footwear';
  if (text.includes('clothing') || text.includes('apparel') || text.includes('jacket') || text.includes('dress')) return 'apparel';
  
  return 'general';
}

/**
 * Extract sunglasses-specific attributes
 */
function extractSunglassesAttributes(text: string, attributes: Set<string>): void {
  // Shapes
  const shapes = text.match(/\b(round|square|aviator|cat[- ]eye|wayfarer|oversized|rectangular)\b/gi);
  if (shapes) shapes.forEach(shape => attributes.add(shape.toLowerCase().replace(/[- ]/g, ' ')));
  
  // Features
  const features = text.match(/\b(moulded nose pads|dark[- ]tinted lenses|polarized|gradient|mirrored|photochromic)\b/gi);
  if (features) features.forEach(feature => attributes.add(feature.toLowerCase().replace(/[- ]/g, ' ')));
  
  // Materials (frame-specific)
  const materials = text.match(/\b(acetate|metal|titanium|steel|plastic|bio[- ]acetate)\b/gi);
  if (materials) materials.forEach(material => attributes.add(material.toLowerCase().replace(/[- ]/g, ' ')));
}

/**
 * Extract footwear-specific attributes
 */
function extractFootwearAttributes(text: string, attributes: Set<string>): void {
  // Styles
  const styles = text.match(/\b(chelsea|combat|derby|oxford|loafer|ankle|knee|thigh[- ]high|platform|wedge)\b/gi);
  if (styles) styles.forEach(style => attributes.add(style.toLowerCase().replace(/[- ]/g, ' ')));
  
  // Features
  const features = text.match(/\b(lug sole|cap toe|zip[- ]?up|waterproof|breathable|cushioned|non[- ]slip)\b/gi);
  if (features) features.forEach(feature => attributes.add(feature.toLowerCase().replace(/[- ]/g, ' ')));
  
  // Materials
  const materials = text.match(/\b(leather|suede|canvas|rubber|synthetic|mesh|nubuck)\b/gi);
  if (materials) materials.forEach(material => attributes.add(material.toLowerCase()));
}

/**
 * Extract apparel-specific attributes
 */
function extractApparelAttributes(text: string, attributes: Set<string>): void {
  // Fits/Styles
  const fits = text.match(/\b(oversized|slim|regular|relaxed|fitted|loose|tailored|cropped|longline)\b/gi);
  if (fits) fits.forEach(fit => attributes.add(fit.toLowerCase()));
  
  const styles = text.match(/\b(bomber|parka|puffer|crew neck|v[- ]neck|turtle neck|off[- ]shoulder|wrap|midi|maxi|mini)\b/gi);
  if (styles) styles.forEach(style => attributes.add(style.toLowerCase().replace(/[- ]/g, ' ')));
  
  // Features
  const features = text.match(/\b(zip[- ]?up|button[- ]?up|pullover|hooded|sleeveless|long[- ]sleeve|short[- ]sleeve)\b/gi);
  if (features) features.forEach(feature => attributes.add(feature.toLowerCase().replace(/[- ]/g, ' ')));
}

/**
 * Extract general attributes for other categories
 */
function extractGeneralAttributes(text: string, attributes: Set<string>): void {
  // General style descriptors
  const styles = text.match(/\b(classic|modern|vintage|retro|minimalist|elegant|casual|formal|sporty)\b/gi);
  if (styles) styles.forEach(style => attributes.add(style.toLowerCase()));
  
  // General features
  const features = text.match(/\b(adjustable|removable|reversible|lightweight|heavy[- ]duty|compact|portable)\b/gi);
  if (features) features.forEach(feature => attributes.add(feature.toLowerCase().replace(/[- ]/g, ' ')));
}

/**
 * Build the final clean title
 */
function buildCleanTitle(components: {
  brand?: string | null;
  productType?: string | null;
  keyAttrs: string[];
  color?: string | null;
  material?: string | null;
}): string {
  const parts: string[] = [];
  
  // Brand + Product Type
  if (components.brand && components.productType) {
    parts.push(`${components.brand} ${components.productType}`);
  } else if (components.productType) {
    parts.push(components.productType);
  } else if (components.brand) {
    parts.push(components.brand);
  }
  
  // Key attributes
  if (components.keyAttrs.length > 0) {
    parts.push(components.keyAttrs.join(', '));
  }
  
  // Color (if not already mentioned)
  if (components.color) {
    parts.push(components.color);
  }
  
  // Material (if not already mentioned)
  if (components.material) {
    parts.push(components.material);
  }
  
  // Join with em dash and semicolons
  let title = parts.join(' — ');
  if (parts.length > 1) {
    // Use semicolons for secondary attributes
    const mainPart = parts[0];
    const otherParts = parts.slice(1);
    title = `${mainPart} — ${otherParts.join('; ')}`;
  }
  
  // Truncate to 100 characters
  if (title.length > 100) {
    title = title.substring(0, 97).trim() + '...';
  }
  
  return title || 'Product'; // Fallback
}
