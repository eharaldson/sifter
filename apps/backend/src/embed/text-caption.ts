import { logger } from '../log';
import { NormalizedProduct } from '../match/normalize';

// ============================================
// CLIP Caption Generation Pipeline
// ============================================

// Domain dictionaries for filtering valid attributes
const VALID_MATERIALS = new Set([
  'cotton', 'polyester', 'wool', 'silk', 'linen', 'denim', 'leather', 'suede', 'canvas', 'nylon',
  'spandex', 'elastane', 'viscose', 'rayon', 'cashmere', 'mohair', 'alpaca', 'bamboo', 'hemp',
  'corduroy', 'velvet', 'satin', 'chiffon', 'lace', 'mesh', 'fleece', 'jersey', 'tweed', 'flannel'
]);

const VALID_COLORS = new Set([
  'black', 'white', 'gray', 'grey', 'brown', 'beige', 'tan', 'cream', 'ivory', 'navy', 'blue',
  'red', 'pink', 'purple', 'green', 'yellow', 'orange', 'gold', 'silver', 'bronze', 'copper',
  'maroon', 'burgundy', 'olive', 'khaki', 'teal', 'turquoise', 'coral', 'mint', 'lavender'
]);

const VALID_STYLES = new Set([
  'casual', 'formal', 'business', 'athletic', 'vintage', 'retro', 'modern', 'classic', 'bohemian',
  'minimalist', 'oversized', 'fitted', 'slim', 'relaxed', 'tailored', 'structured', 'flowy',
  'cropped', 'longline', 'midi', 'maxi', 'mini', 'knee-length', 'ankle-length', 'full-length'
]);

// Color family mappings
const COLOR_FAMILIES: { [key: string]: string } = {
  'navy': 'blue', 'royal': 'blue', 'sky': 'blue', 'teal': 'blue', 'turquoise': 'blue',
  'crimson': 'red', 'scarlet': 'red', 'maroon': 'red', 'burgundy': 'red', 'cherry': 'red',
  'olive': 'green', 'forest': 'green', 'emerald': 'green', 'lime': 'green', 'mint': 'green',
  'tan': 'brown', 'beige': 'brown', 'chocolate': 'brown', 'coffee': 'brown', 'camel': 'brown',
  'charcoal': 'gray', 'slate': 'gray', 'silver': 'gray',
  'gold': 'yellow', 'amber': 'yellow', 'mustard': 'yellow', 'cream': 'yellow',
  'violet': 'purple', 'lavender': 'purple', 'plum': 'purple', 'magenta': 'purple'
};

// Material normalization mappings
const MATERIAL_SYNONYMS: { [key: string]: string } = {
  'poly': 'polyester', 'elastane': 'spandex', 'lycra': 'spandex', 'stretch': 'spandex',
  'denim': 'cotton', 'chambray': 'cotton', 'corduroy': 'cotton', 'twill': 'cotton',
  'faux leather': 'synthetic', 'pleather': 'synthetic', 'vegan leather': 'synthetic'
};

// Boilerplate removal patterns
const BOILERPLATE_PATTERNS = [
  /free shipping/gi,
  /free returns/gi,
  /30 day returns/gi,
  /money back guarantee/gi,
  /customer service/gi,
  /contact us/gi,
  /size guide/gi,
  /care instructions/gi,
  /machine wash/gi,
  /dry clean/gi,
  /model is wearing/gi,
  /model height/gi,
  /true to size/gi,
  /runs small/gi,
  /runs large/gi,
  /available in store/gi,
  /online exclusive/gi,
  /limited edition/gi,
  /new arrival/gi,
  /bestseller/gi,
  /trending/gi,
  /must have/gi,
  /perfect for/gi,
  /ideal for/gi,
  /great for/gi,
  /shop now/gi,
  /buy now/gi,
  /add to cart/gi,
  /save \d+%/gi,
  /was £?\$?\d+/gi,
  /now £?\$?\d+/gi,
  /rrp £?\$?\d+/gi,
  /retail price/gi
];

// Product type extraction patterns
const PRODUCT_TYPE_PATTERNS = [
  // Clothing
  /\b(dress|dresses)\b/gi,
  /\b(shirt|shirts|blouse|blouses)\b/gi,
  /\b(t-?shirt|tee|top|tops)\b/gi,
  /\b(jacket|jackets|blazer|blazers|coat|coats)\b/gi,
  /\b(pants|trousers|jeans|leggings)\b/gi,
  /\b(skirt|skirts)\b/gi,
  /\b(shorts)\b/gi,
  /\b(sweater|sweaters|jumper|jumpers|pullover|pullovers)\b/gi,
  /\b(cardigan|cardigans)\b/gi,
  /\b(hoodie|hoodies|sweatshirt|sweatshirts)\b/gi,
  // Accessories
  /\b(bag|bags|handbag|handbags|purse|purses)\b/gi,
  /\b(shoes|shoe|sneakers|sneaker|boots|boot)\b/gi,
  /\b(belt|belts)\b/gi,
  /\b(hat|hats|cap|caps)\b/gi,
  /\b(scarf|scarves|scarfs)\b/gi,
  /\b(watch|watches)\b/gi,
  /\b(sunglasses|glasses)\b/gi,
  /\b(jewelry|jewellery|necklace|bracelet|earrings|ring)\b/gi
];

// Style and feature extraction patterns
const FEATURE_PATTERNS = [
  /\b(zip-?up|zipper|button-?up|snap|velcro)\b/gi,
  /\b(pockets?|zippered|hidden|side|front|back)\b/gi,
  /\b(sleeveless|short-?sleeve|long-?sleeve|3\/4-?sleeve)\b/gi,
  /\b(crew-?neck|v-?neck|scoop-?neck|high-?neck|turtle-?neck)\b/gi,
  /\b(round-?neck|boat-?neck|off-?shoulder|one-?shoulder)\b/gi,
  /\b(hooded|hood|drawstring|elastic|adjustable)\b/gi,
  /\b(pleated|ruffled|embroidered|printed|striped|solid)\b/gi,
  /\b(fitted|loose|relaxed|oversized|slim|straight|wide)\b/gi,
  /\b(high-?waisted|low-?waisted|mid-?rise|low-?rise)\b/gi,
  /\b(ankle|knee|midi|maxi|mini|cropped|full-?length)\b/gi
];

/**
 * Generate a deterministic CLIP caption for a product
 */
export function generateClipCaption(product: NormalizedProduct): string {
  logger.debug({ productTitle: product.title }, 'Generating CLIP caption');
  
  // 1. Normalize core fields
  const brandNorm = normalizeBrand(product.brand || undefined);
  const productType = extractProductType(product.title || undefined, product.subCategory || undefined, product.category || undefined);
  const colorFamily = normalizeColorFamily(product.color || undefined);
  const materialNorm = normalizeMaterial(product.primaryMaterial || undefined);
  const gender = extractGender(product.title || undefined, product.description || undefined);
  
  // 2. Clean description
  const cleanDesc = cleanDescription(product.description || '');
  
  // 3. Extract token/phrase candidates
  const candidates = extractAttributeCandidates(cleanDesc, product.title || undefined);
  
  // 4. Filter & normalize candidates
  const filteredAttrs = filterAndNormalizeAttributes(candidates, brandNorm, productType);
  
  // 5. Compose caption
  const caption = composeCaption({
    brand: brandNorm,
    productType,
    attributes: filteredAttrs,
    color: colorFamily,
    material: materialNorm,
    gender
  });
  
  logger.debug({ 
    originalTitle: product.title,
    generatedCaption: caption,
    components: { brandNorm, productType, colorFamily, materialNorm, gender, attributeCount: filteredAttrs.length }
  }, 'CLIP caption generated');
  
  return caption;
}

/**
 * Normalize brand name
 */
function normalizeBrand(brand?: string): string | null {
  if (!brand) return null;
  
  // Title case and clean up
  return brand
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .replace(/[^\w\s&-]/g, '') // Keep alphanumeric, spaces, ampersands, hyphens
    .trim();
}

/**
 * Extract product type from title, subcategory, or category
 */
function extractProductType(title?: string, subCategory?: string, category?: string): string | null {
  const sources = [subCategory, title, category].filter(Boolean);
  
  for (const source of sources) {
    if (!source) continue;
    
    // Try to match against product type patterns
    for (const pattern of PRODUCT_TYPE_PATTERNS) {
      const match = source.match(pattern);
      if (match) {
        return normalizeProductType(match[0]);
      }
    }
  }
  
  // Fallback: extract noun from title
  if (title) {
    const words = title.toLowerCase().split(/\s+/);
    const nouns = words.filter(word => 
      word.length > 3 && 
      !['the', 'and', 'with', 'from', 'this', 'that'].includes(word)
    );
    if (nouns.length > 0) {
      return normalizeProductType(nouns[0]);
    }
  }
  
  return null;
}

/**
 * Normalize product type
 */
function normalizeProductType(type: string): string {
  const normalized = type.toLowerCase().replace(/s$/, ''); // Remove plural
  
  const typeMap: { [key: string]: string } = {
    'tshirt': 't-shirt',
    'tee': 't-shirt',
    'jean': 'jeans',
    'trouser': 'trousers',
    'sneaker': 'sneakers',
    'sunglass': 'sunglasses'
  };
  
  return typeMap[normalized] || normalized;
}

/**
 * Normalize color to color family
 */
function normalizeColorFamily(color?: string): string | null {
  if (!color) return null;
  
  const lowerColor = color.toLowerCase().trim();
  
  // Check if it's already a valid base color
  if (VALID_COLORS.has(lowerColor)) {
    return lowerColor;
  }
  
  // Map to color family
  return COLOR_FAMILIES[lowerColor] || null;
}

/**
 * Normalize material
 */
function normalizeMaterial(material?: string): string | null {
  if (!material) return null;
  
  const lowerMaterial = material.toLowerCase().trim();
  
  // Check synonyms first
  const synonym = MATERIAL_SYNONYMS[lowerMaterial];
  if (synonym) return synonym;
  
  // Check if it's a valid material
  if (VALID_MATERIALS.has(lowerMaterial)) {
    return lowerMaterial;
  }
  
  return null;
}

/**
 * Extract gender from title or description
 */
function extractGender(title?: string, description?: string): string | null {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  
  if (text.includes('women') || text.includes('ladies') || text.includes('female')) {
    return 'women';
  }
  if (text.includes('men') || text.includes('male') || text.includes('gentleman')) {
    return 'men';
  }
  if (text.includes('unisex') || text.includes('gender neutral')) {
    return 'unisex';
  }
  
  return null;
}

/**
 * Clean description by removing HTML, entities, and boilerplate
 */
function cleanDescription(description: string): string {
  let cleaned = description
    // Remove HTML tags
    .replace(/<[^>]*>/g, ' ')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Remove excessive punctuation
    .replace(/[^\w\s\-.,;:()]/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  
  // Remove boilerplate patterns
  for (const pattern of BOILERPLATE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  
  // Clean up whitespace again
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Extract attribute candidates from description and title
 */
function extractAttributeCandidates(cleanDesc: string, title?: string): string[] {
  const candidates: Set<string> = new Set();
  const text = `${cleanDesc} ${title || ''}`.toLowerCase();
  
  // Extract features using patterns
  for (const pattern of FEATURE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        const normalized = match.toLowerCase().replace(/\s+/g, '-');
        candidates.add(normalized);
      });
    }
  }
  
  // Extract adjective-noun phrases (simplified NLP)
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    
    // Simple heuristic: if it contains style-related words
    if (VALID_STYLES.has(words[i]) || VALID_STYLES.has(words[i + 1])) {
      candidates.add(phrase.replace(/\s+/g, '-'));
    }
  }
  
  return Array.from(candidates);
}

/**
 * Filter and normalize attribute candidates
 */
function filterAndNormalizeAttributes(
  candidates: string[], 
  brand?: string | null, 
  productType?: string | null
): string[] {
  const filtered: string[] = [];
  const seen = new Set<string>();
  
  // Normalize brand and product type for deduplication
  const brandLower = brand?.toLowerCase();
  const typeLower = productType?.toLowerCase();
  
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace(/[-_]/g, ' ');
    
    // Skip if already seen
    if (seen.has(normalized)) continue;
    
    // Skip if it's the brand or product type (avoid duplication)
    if (brandLower && normalized.includes(brandLower)) continue;
    if (typeLower && normalized.includes(typeLower)) continue;
    
    // Check if it's a valid style/feature
    const words = normalized.split(/\s+/);
    const isValid = words.some(word => 
      VALID_STYLES.has(word) || 
      VALID_MATERIALS.has(word) ||
      VALID_COLORS.has(word) ||
      word.length > 4 // Allow longer descriptive words
    );
    
    if (isValid && filtered.length < 4) { // Limit to 2-4 attributes
      filtered.push(candidate);
      seen.add(normalized);
    }
  }
  
  return filtered;
}

/**
 * Compose the final caption
 */
function composeCaption(components: {
  brand?: string | null;
  productType?: string | null;
  attributes: string[];
  color?: string | null;
  material?: string | null;
  gender?: string | null;
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
  
  // Attributes (limit to 2-4)
  const attrs = components.attributes.slice(0, 4);
  if (attrs.length > 0) {
    parts.push(attrs.join(', '));
  }
  
  // Color
  if (components.color) {
    parts.push(components.color);
  }
  
  // Material
  if (components.material) {
    parts.push(components.material);
  }
  
  // Gender (optional)
  if (components.gender) {
    parts.push(components.gender);
  }
  
  // Join with semicolons and clean up
  let caption = parts.join('; ');
  
  // Truncate to ~60 tokens (approximately 300 characters)
  if (caption.length > 300) {
    caption = caption.substring(0, 250).trim();
    // Try to end at a word boundary
    const lastSpace = caption.lastIndexOf(' ');
    if (lastSpace > 200) {
      caption = caption.substring(0, lastSpace);
    }
  }
  
  return caption || 'product'; // Fallback
}
