import * as CLOTHING_BRANDS from '../clothing_brands.json' with { type: 'json' };

/**
 * Attribute detection for categories, subcategories, and materials
 * Used to enrich product data when these attributes aren't explicitly extracted
 */

export interface CategoryMapping {
  category: string;
  subcategories: string[];
}

export interface SubcategoryAlias {
  canonical: string;
  aliases: string[];
}

export interface MaterialMapping {
  material: string;
  aliases: string[];
}

export interface ColorMapping {
  color: string;
  aliases: string[];
}

// Subcategory alias mappings - maps variations to canonical forms
export const SUBCATEGORY_ALIASES: SubcategoryAlias[] = [
  { canonical: 't-shirt', aliases: ['t-shirt', 't-shirts', 'tshirt', 'tshirts', 'tee', 'tees'] },
  { canonical: 'shirt', aliases: ['shirt', 'shirts'] },
  { canonical: 'polo', aliases: ['polo', 'polos'] },
  { canonical: 'overshirt', aliases: ['overshirt', 'overshirts'] },
  { canonical: 'blouse', aliases: ['blouse', 'blouses'] },
  { canonical: 'sweater', aliases: ['sweater', 'sweaters', 'jumper', 'jumpers', 'pullover', 'pullovers'] },
  { canonical: 'knitwear', aliases: ['knitwear', 'knitwear sweater', 'knitwear sweaters', 'knitted sweater', 'knitted sweaters', 'knitwear jumper', 'knitwear jumpers', 'knitted jumper', 'knitted jumpers']},
  { canonical: 'cardigan', aliases: ['cardigan', 'cardigans']},
  { canonical: 'hoodie', aliases: ['hoodie', 'hoodies', 'sweatshirt', 'sweatshirts'] },
  { canonical: 'jeans', aliases: ['jean', 'jeans'] },
  { canonical: 'trousers', aliases: ['trouser', 'trousers', 'pant', 'pants'] },
  { canonical: 'chinos', aliases: ['chino', 'chinos'] },
  { canonical: 'shorts', aliases: ['short', 'shorts'] },
  { canonical: 'skirt', aliases: ['skirt', 'skirts'] },
  { canonical: 'dress', aliases: ['dress', 'dresses', 'gown', 'gowns'] },
  { canonical: 'jumpsuit', aliases: ['jumpsuit', 'jumpsuits', 'playsuit', 'playsuits', 'romper', 'rompers'] },
  { canonical: 'coat', aliases: ['coat', 'coats'] },
  { canonical: 'jacket', aliases: ['jacket', 'jackets'] },
  { canonical: 'blazer', aliases: ['blazer', 'blazers'] },
  { canonical: 'sneakers', aliases: ['sneaker', 'sneakers', 'trainer', 'trainers'] },
  { canonical: 'boots', aliases: ['boot', 'boots'] },
  { canonical: 'sandals', aliases: ['sandal', 'sandals'] },
  { canonical: 'heels', aliases: ['heel', 'heels', 'high heel', 'high heels'] },
  { canonical: 'flats', aliases: ['flat', 'flats', 'ballet flat', 'ballet flats'] },
  { canonical: 'loafers', aliases: ['loafer', 'loafers'] },
  { canonical: 'handbag', aliases: ['handbag', 'handbags', 'purse', 'purses'] },
  { canonical: 'backpack', aliases: ['backpack', 'back pack', 'backpacks', 'rucksack', 'rucksacks'] },
  { canonical: 'wallet', aliases: ['wallet', 'wallets'] },
  { canonical: 'necklace', aliases: ['necklace', 'necklaces'] },
  { canonical: 'ring', aliases: ['ring', 'rings'] },
  { canonical: 'bracelet', aliases: ['bracelet', 'bracelets', 'bangle', 'bangles'] },
  { canonical: 'earrings', aliases: ['earring', 'earrings'] },
  { canonical: 'watch', aliases: ['watch', 'watches'] },
  { canonical: 'belt', aliases: ['belt', 'belts'] },
  { canonical: 'hat', aliases: ['hat', 'hats', 'cap', 'caps'] },
  { canonical: 'scarf', aliases: ['scarf', 'scarves'] },
  { canonical: 'sunglasses', aliases: ['sunglasses', 'sunglass', 'shades'] },
  { canonical: 'tote', aliases: ['tote', 'tote bag'] },
  { canonical: 'shoulder bag', aliases: ['shoulder bag'] },
  { canonical: 'crossbody bag', aliases: ['crossbody bag'] },
  { canonical: 'clutch', aliases: ['clutch'] }
];

// Category mappings with canonical subcategories only
export const CATEGORY_MAPPINGS: CategoryMapping[] = [
  {
    category: 'clothing',
    subcategories: [
      't-shirt', 'shirt', 'blouse', 'sweater', 'hoodie', 'jeans', 'trousers', 'chinos', 'shorts',
      'skirt', 'dress', 'jumpsuit', 'coat', 'jacket', 'blazer', 'activewear', 'swimwear', 
      'underwear', 'lingerie', 'top', 'bikini', 'swimsuit', 'bra'
    ]
  },
  {
    category: 'shoes',
    subcategories: [
      'sneakers', 'boots', 'sandals', 'heels', 'flats', 'loafers', 'tennis shoes',
      'running shoes', 'sports shoes'
    ]
  },
  {
    category: 'accessories',
    subcategories: [
      'handbag', 'backpack', 'tote', 'wallet', 'necklace', 'ring', 'bracelet', 'earrings',
      'watch', 'belt', 'hat', 'scarf', 'sunglasses', 'clutch', 'cap'
    ]
  },
  {
    category: 'beauty',
    subcategories: [
      'skincare', 'makeup', 'haircare', 'fragrance', 'perfume'
    ]
  }
];

// Material mappings with aliases (not category-constrained)
export const MATERIAL_MAPPINGS: MaterialMapping[] = [
  { material: 'cotton', aliases: ['cotton', '100% cotton', 'organic cotton', 'cotton blend'] },
  { material: 'polyester', aliases: ['polyester', 'poly', 'polyester blend'] },
  { material: 'wool', aliases: ['wool', 'merino wool', 'lambswool', 'virgin wool', 'wool blend'] },
  { material: 'cashmere', aliases: ['cashmere', '100% cashmere', 'cashmere blend'] },
  { material: 'silk', aliases: ['silk', '100% silk', 'mulberry silk', 'silk blend'] },
  { material: 'linen', aliases: ['linen', '100% linen', 'linen blend', 'flax'] },
  { material: 'denim', aliases: ['denim', 'jean', 'cotton denim'] },
  { material: 'leather', aliases: ['leather', 'genuine leather', 'real leather', 'full grain leather'] },
  { material: 'viscose', aliases: ['viscose', 'rayon', 'modal', 'bamboo viscose'] },
  { material: 'nylon', aliases: ['nylon', 'polyamide'] },
  { material: 'spandex', aliases: ['spandex', 'elastane', 'lycra', 'stretch'] },
  { material: 'fleece', aliases: ['fleece', 'polar fleece', 'micro fleece'] },
  { material: 'velvet', aliases: ['velvet', 'crushed velvet', 'velour'] },
  { material: 'corduroy', aliases: ['corduroy', 'cord'] },
  { material: 'acrylic', aliases: ['acrylic', 'acrylic blend'] },
  { material: 'synthetic leather', aliases: ['synthetic leather', 'faux leather', 'vegan leather', 'pu leather'] },
  { material: 'canvas', aliases: ['canvas', 'cotton canvas'] },
  { material: 'mesh', aliases: ['mesh', 'breathable mesh', 'air mesh'] },
  { material: 'rubber', aliases: ['rubber', 'rubber sole', 'natural rubber'] },
  { material: 'eva', aliases: ['eva', 'eva foam', 'ethylene vinyl acetate'] },
  { material: 'foam', aliases: ['foam', 'memory foam', 'cushioning foam'] },
  { material: 'cork', aliases: ['cork', 'cork sole', 'natural cork'] },
  { material: 'metal', aliases: ['metal', 'metallic', 'alloy'] },
  { material: 'wood', aliases: ['wood', 'wooden', 'bamboo'] },
  { material: 'gold', aliases: ['gold', '14k gold', '18k gold', 'gold plated', 'gold filled'] },
  { material: 'silver', aliases: ['silver', 'sterling silver', 'silver plated', '925 silver'] },
  { material: 'platinum', aliases: ['platinum', 'plat', 'pt'] }
];

export const COLOR_MAPPINGS: ColorMapping[] = [
  { color: 'white', aliases: ['white', 'ivory', 'cream', 'off-white', 'snow', 'pearl', 'bone', 'alabaster', 'eggshell'] },
  { color: 'black', aliases: ['black', 'charcoal', 'ebony', 'jet black', 'onyx', 'midnight'] },
  { color: 'gray', aliases: ['gray', 'grey', 'slate', 'silver', 'ash', 'steel', 'pewter'] },
  { color: 'red', aliases: ['red', 'burgundy', 'maroon', 'crimson', 'scarlet', 'ruby', 'cherry', 'wine'] },
  { color: 'blue', aliases: ['blue', 'navy', 'royal blue', 'sky blue', 'azure', 'cobalt', 'sapphire', 'teal', 'turquoise', 'cyan'] },
  { color: 'green', aliases: ['green', 'olive', 'emerald', 'lime', 'forest green', 'mint', 'jade', 'seafoam'] },
  { color: 'yellow', aliases: ['yellow', 'gold', 'mustard', 'lemon', 'daffodil', 'maize', 'chartreuse'] },
  { color: 'orange', aliases: ['orange', 'tangerine', 'apricot', 'peach', 'coral', 'burnt orange'] },
  { color: 'purple', aliases: ['purple', 'violet', 'lavender', 'mauve', 'plum', 'indigo', 'magenta'] },
  { color: 'pink', aliases: ['pink', 'rose', 'fuchsia', 'magenta', 'blush', 'salmon', 'hot pink'] },
  { color: 'brown', aliases: ['brown', 'tan', 'beige', 'khaki', 'chocolate', 'bronze', 'camel', 'taupe', 'sepia', 'umber'] },
  { color: 'multi-color', aliases: ['multi-color', 'multicolor', 'rainbow', 'patterned', 'printed', 'floral', 'striped', 'checkered'] }
];

const BRAND_NAMES = (CLOTHING_BRANDS as any).default || CLOTHING_BRANDS;

/**
 * Normalize text for matching - lowercase, remove special characters, handle plurals
 */
export function normalizeText(text: string): string[] {
  const normalized = text.toLowerCase()
    .replace(/[^\w\s-]/g, ' ') // Replace special chars with space
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
  
  const words = normalized.split(' ');
  const variations: string[] = [normalized];
  
  // Add individual words
  variations.push(...words);
  
  // Add phrases (2-3 word combinations)
  for (let i = 0; i < words.length - 1; i++) {
    variations.push(words.slice(i, i + 2).join(' '));
    if (i < words.length - 2) {
      variations.push(words.slice(i, i + 3).join(' '));
    }
  }
  
  return variations;
}

/**
 * Helper function to find canonical subcategory from alias
 */
function findCanonicalSubcategory(foundSubcategory: string): string {
  for (const alias of SUBCATEGORY_ALIASES) {
    if (alias.aliases.includes(foundSubcategory)) {
      return alias.canonical;
    }
  }
  return foundSubcategory; // Return as-is if no alias found
}

/**
 * Search for category and subcategory in text
 */
export function detectCategoryAndSubcategory(title: string, description: string = ''): {
  category?: string;
  subcategory?: string;
  confidence?: number;
  matches?: string[];
} {
  const searchText = `${title} ${description}`.toLowerCase();
  const textVariations = normalizeText(searchText);
  
  let bestMatch: { category?: string; subcategory?: string; confidence: number; foundText?: string } = { confidence: 0 };
  const allMatches: string[] = [];
  
  // Check all subcategory aliases first
  for (const aliasMapping of SUBCATEGORY_ALIASES) {
    for (const alias of aliasMapping.aliases) {
      // Check for matches in text variations
      for (const variation of textVariations) {
        if (variation === alias || variation.includes(` ${alias} `) || 
            variation.startsWith(`${alias} `) || variation.endsWith(` ${alias}`)) {
          
          allMatches.push(`${alias} -> ${aliasMapping.canonical}`);
          
          // Calculate confidence based on match quality
          let confidence = 1;
          if (variation === alias) confidence = 3; // Exact match
          else if (title.toLowerCase().includes(alias)) confidence = 2; // In title
          
          // Now find which category this canonical subcategory belongs to
          for (const categoryMapping of CATEGORY_MAPPINGS) {
            if (categoryMapping.subcategories.includes(aliasMapping.canonical)) {
              if (confidence > bestMatch.confidence) {
                bestMatch = {
                  category: categoryMapping.category,
                  subcategory: aliasMapping.canonical,
                  confidence,
                  foundText: alias
                };
              }
              break;
            }
          }
        }
      }
    }
  }
  
  return bestMatch.confidence > 0 ? {
    category: bestMatch.category,
    subcategory: bestMatch.subcategory,
    confidence: bestMatch.confidence,
    matches: allMatches
  } : { matches: allMatches };
}

/**
 * Search for materials in text
 */
export function detectMaterial(title: string, description: string = ''): { 
  material?: string; 
  confidence?: number; 
  matches?: string[] 
} {
  const searchText = `${title} ${description}`.toLowerCase();
  const textVariations = normalizeText(searchText);
  
  let bestMatch: { material?: string; confidence: number; foundText?: string } = { confidence: 0 };
  const allMatches: string[] = [];
  
  for (const materialMapping of MATERIAL_MAPPINGS) {
    for (const alias of materialMapping.aliases) {
      // Check for matches in text variations
      for (const variation of textVariations) {
        if (variation === alias || variation.includes(` ${alias} `) || 
            variation.startsWith(`${alias} `) || variation.endsWith(` ${alias}`)) {
          
          allMatches.push(`${alias} -> ${materialMapping.material}`);
          
          // Calculate confidence based on match quality and alias specificity
          let confidence = 1;
          if (variation === alias) confidence = 3; // Exact match
          else if (title.toLowerCase().includes(alias)) confidence = 2; // In title
          
          // Boost confidence for more specific aliases
          if (alias.includes('100%') || alias.includes('genuine') || alias.includes('real')) {
            confidence += 1;
          }
          
          if (confidence > bestMatch.confidence) {
            bestMatch = {
              material: materialMapping.material,
              confidence,
              foundText: alias
            };
          }
        }
      }
    }
  }
  
  return bestMatch.confidence > 0 ? {
    material: bestMatch.material,
    confidence: bestMatch.confidence,
    matches: allMatches
  } : { matches: allMatches };
}

/**
 * Search for color in text
 */
export function detectColor(title: string, description: string = ''): {
  color?: string;
  confidence?: number;
  matches?: string[];
} {
  const searchText = `${title} ${description}`.toLowerCase();
  const textVariations = normalizeText(searchText);

  let bestMatch: { color?: string; confidence: number; foundText?: string } = { confidence: 0 };
  const allMatches: string[] = [];

  for (const colorMapping of COLOR_MAPPINGS) {
    for (const alias of colorMapping.aliases) {
      // Check for matches in text variations
      for (const variation of textVariations) {
        if (variation === alias || variation.includes(` ${alias} `) ||
            variation.startsWith(`${alias} `) || variation.endsWith(` ${alias}`)) {

          allMatches.push(`${alias} -> ${colorMapping.color}`);

          // Calculate confidence based on match quality
          let confidence = 1;
          if (variation === alias) confidence = 3; // Exact match
          else if (title.toLowerCase().includes(alias)) confidence = 2; // In title

          if (confidence > bestMatch.confidence) {
            bestMatch = {
              color: colorMapping.color,
              confidence,
              foundText: alias
            };
          }
        }
      }
    }
  }

  return bestMatch.confidence > 0 ? {
    color: bestMatch.color,
    confidence: bestMatch.confidence,
    matches: allMatches
  } : { matches: allMatches };
}

/**
 * Search for gender in text
 * Returns "male", "female", or "unisex" (defaults to "unisex" if not specified)
 */
export function detectGender(title: string, description: string = ''): {
  gender?: string;
  confidence?: number;
  matches?: string[];
} {
  const searchText = `${title} ${description}`.toLowerCase();
  const textVariations = normalizeText(searchText);

  let bestMatch: { gender?: string; confidence: number; foundText?: string } = { confidence: 0 };
  const allMatches: string[] = [];

  // Gender detection patterns - order matters (more specific first)
  const genderPatterns = [
    // Female patterns
    { gender: 'female', patterns: ['women\'s', 'womens', 'womenswear', 'ladies', 'lady', 'female', 'girl', 'girls', 'women', 'woman'] },
    // Male patterns
    { gender: 'male', patterns: ['men\'s', 'mens', 'menswear', 'men', 'man', 'male', 'gentleman', 'gentlemen', 'boys', 'boy'] },
    // Unisex patterns
    { gender: 'unisex', patterns: ['unisex', 'gender neutral', 'gender-neutral', 'unisex', 'all genders', 'all-gender'] }
  ];

  for (const genderMapping of genderPatterns) {
    for (const pattern of genderMapping.patterns) {
      // Check for matches in text variations
      for (const variation of textVariations) {
        if (variation === pattern || variation.includes(` ${pattern} `) ||
            variation.startsWith(`${pattern} `) || variation.endsWith(` ${pattern}`)) {

          allMatches.push(`${pattern} -> ${genderMapping.gender}`);

          // Calculate confidence based on match quality
          let confidence = 1;
          if (variation === pattern) confidence = 3; // Exact match
          else if (title.toLowerCase().includes(pattern)) confidence = 2; // In title

          // Boost confidence for possessive forms (e.g., "men's", "women's")
          if (pattern.includes('\'s') || pattern.includes('s\'')) {
            confidence += 1;
          }

          if (confidence > bestMatch.confidence) {
            bestMatch = {
              gender: genderMapping.gender,
              confidence,
              foundText: pattern
            };
          }
        }
      }
    }
  }

  // Default to "unisex" if no gender is detected
  return bestMatch.confidence > 0 ? {
    gender: bestMatch.gender,
    confidence: bestMatch.confidence,
    matches: allMatches
  } : { gender: 'unisex', matches: allMatches };
}

/**
 * Search for brand in text
 */
export function detectBrand(title: string): {
  brand?: string;
  confidence?: number;
  matches?: string[];
} {
  const textVariations = normalizeText(title);

  let bestMatch: { brand?: string; confidence: number; foundText?: string } = { confidence: 0 };
  const allMatches: string[] = [];

  for (const brand of BRAND_NAMES) {
    for (const variation of textVariations) {
      if (variation === brand || variation.includes(` ${brand} `) ||
          variation.startsWith(`${brand} `) || variation.endsWith(` ${brand}`)) {
        
        allMatches.push(`${variation} -> ${brand}`);
        
        // Longer brand names are more likely to be correct
        const confidence = brand.length;

        if (confidence > bestMatch.confidence) {
          bestMatch = {
            brand,
            confidence,
            foundText: variation
          };
        }
      }
    }
  }

  return bestMatch.confidence > 0 ? {
    brand: bestMatch.brand,
    confidence: bestMatch.confidence,
    matches: allMatches
  } : { matches: allMatches };
}

/**
 * Enrich product attributes by detecting category, subcategory, and material
 * Always replaces detected values and preserves original values in description
 */
export function enrichProductAttributes(productData: {
  title?: string;
  description?: string;
  category?: string;
  subcategory?: string;
  material?: string;
  color?: string;
  brand?: string;
  gender?: string;
}): {
  category?: string;
  subcategory?: string;
  material?: string;
  color?: string;
  description?: string;
  brand?: string;
  gender?: string;
} {
  const title = productData.title || '';
  let description = productData.description || '';
  
  const enriched = {
    category: productData.category,
    subcategory: productData.subcategory,
    material: productData.material,
    color: productData.color,
    brand: productData.brand,
    gender: productData.gender,
    description
  };
  
  // Always detect and replace category/subcategory if found
  const detected = detectCategoryAndSubcategory(title, description);
  if (detected.category) {
    // Preserve original category in description before replacing
    if (enriched.category && enriched.category !== detected.category) {
      const categoryText = `Category: ${enriched.category}.`;
      enriched.description = enriched.description ? `${enriched.description} ${categoryText}` : categoryText;
    }
    enriched.category = detected.category;
  }
  
  if (detected.subcategory) {
    // Preserve original subcategory in description before replacing
    if (enriched.subcategory && enriched.subcategory !== detected.subcategory) {
      const subcategoryText = `Subcategory: ${enriched.subcategory}.`;
      enriched.description = enriched.description ? `${enriched.description} ${subcategoryText}` : subcategoryText;
    }
    enriched.subcategory = detected.subcategory;
  }
  
  // Always detect and replace material if found
  const materialDetected = detectMaterial(title, description);
  if (materialDetected.material) {
    // Preserve original material in description before replacing
    if (enriched.material && enriched.material !== materialDetected.material) {
      const materialText = `Material: ${enriched.material}.`;
      enriched.description = enriched.description ? `${enriched.description} ${materialText}` : materialText;
    }
    enriched.material = materialDetected.material;
  }
  
  // Always detect and replace color if found
  const colorDetected = detectColor(title, description);
  if (colorDetected.color) {
    // Preserve original color in description before replacing
    if (enriched.color && enriched.color !== colorDetected.color) {
      const colorText = `Color: ${enriched.color}.`;
      enriched.description = enriched.description ? `${enriched.description} ${colorText}` : colorText;
    }
    enriched.color = colorDetected.color;
  }

  // Always detect and replace brand if found
  const brandDetected = detectBrand(title);
  if (brandDetected.brand) {
    if (enriched.brand && enriched.brand !== brandDetected.brand) {
      const brandText = `Brand: ${enriched.brand}.`;
      enriched.description = enriched.description ? `${enriched.description} ${brandText}` : brandText;
    }
    enriched.brand = brandDetected.brand;
  }

  // Always detect gender (defaults to "unisex" if not specified)
  const genderDetected = detectGender(title, description);
  if (genderDetected.gender) {
    // Preserve original gender in description before replacing
    if (enriched.gender && enriched.gender !== genderDetected.gender) {
      const genderText = `Gender: ${enriched.gender}.`;
      enriched.description = enriched.description ? `${enriched.description} ${genderText}` : genderText;
    }
    enriched.gender = genderDetected.gender;
  }

  return enriched;
}

// Export brand names list for filter normalization
export const BRAND_NAMES_LIST = BRAND_NAMES;
