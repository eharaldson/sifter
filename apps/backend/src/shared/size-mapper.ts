import { PoolClient } from 'pg';
import { logger } from '../log';

/**
 * Size type enum
 */
export type SizeType = 'alpha' | 'numeric' | 'shoe';

/**
 * Region enum
 */
export type SizeRegion = 'US' | 'UK' | 'EU' | 'JP';

/**
 * Gender group enum
 */
export type GenderGroup = 'male' | 'female' | 'unisex' | 'kids';

/**
 * Size category - maps to product categories
 */
export type SizeCategory = 'tops' | 'bottoms' | 'footwear' | 'outerwear' | 'dresses' | 'accessories';

/**
 * Standard size interface
 */
export interface StandardSize {
  region: SizeRegion;
  type: SizeType;
  canonical_label: string;
  gender_group: GenderGroup;
  category?: SizeCategory;
  sort_order: number;
}

/**
 * Size mapping context - used to determine the correct standard size
 */
export interface SizeMappingContext {
  category?: string; // Product category (e.g., 'shoes', 'jacket', 'dress')
  gender?: string; // Product gender
  retailerRegion?: SizeRegion; // Retailer's default region
  userRegion?: SizeRegion; // User's region (for inference)
}

/**
 * Comprehensive seed data for standard_sizes table
 * Covers US, UK, EU, JP across alpha, numeric, and shoe sizes
 */
export function generateStandardSizesSeedData(): StandardSize[] {
  const sizes: StandardSize[] = [];
  
  // ========================================
  // ALPHA SIZES (XS, S, M, L, XL, XXL, etc.)
  // ========================================
  
  const alphaSizes = [
    { label: 'XXS', order: 1 },
    { label: 'XS', order: 2 },
    { label: 'S', order: 3 },
    { label: 'M', order: 4 },
    { label: 'L', order: 5 },
    { label: 'XL', order: 6 },
    { label: 'XXL', order: 7 },
    { label: 'XXXL', order: 8 },
  ];
  
  // Alpha sizes for different categories and genders
  const alphaCategories: SizeCategory[] = ['tops', 'outerwear', 'dresses'];
  const genders: GenderGroup[] = ['male', 'female', 'unisex'];
  
  for (const category of alphaCategories) {
    for (const gender of genders) {
      for (const size of alphaSizes) {
        // US alpha sizes
        sizes.push({
          region: 'US',
          type: 'alpha',
          canonical_label: size.label,
          gender_group: gender,
          category,
          sort_order: size.order,
        });
        
        // UK uses same alpha sizes as US
        sizes.push({
          region: 'UK',
          type: 'alpha',
          canonical_label: size.label,
          gender_group: gender,
          category,
          sort_order: size.order,
        });
        
        // EU uses same alpha sizes
        sizes.push({
          region: 'EU',
          type: 'alpha',
          canonical_label: size.label,
          gender_group: gender,
          category,
          sort_order: size.order,
        });
        
        // JP uses same alpha sizes
        sizes.push({
          region: 'JP',
          type: 'alpha',
          canonical_label: size.label,
          gender_group: gender,
          category,
          sort_order: size.order,
        });
      }
    }
  }
  
  // ========================================
  // NUMERIC SIZES - US (2, 4, 6, 8, etc.)
  // ========================================
  
  // Women's numeric sizes (US)
  for (let size = 0; size <= 24; size += 2) {
    sizes.push({
      region: 'US',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'dresses',
      sort_order: size,
    });
    sizes.push({
      region: 'US',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'bottoms',
      sort_order: size,
    });
  }
  
  // Men's waist sizes (US) - 28-48
  for (let size = 28; size <= 48; size += 2) {
    sizes.push({
      region: 'US',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'male',
      category: 'bottoms',
      sort_order: size - 27,
    });
  }
  
  // ========================================
  // NUMERIC SIZES - UK (Same as US mostly)
  // ========================================
  
  // UK Women's sizes (6-24)
  for (let size = 6; size <= 24; size += 2) {
    sizes.push({
      region: 'UK',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'dresses',
      sort_order: size,
    });
  }
  
  // UK Men's waist sizes
  for (let size = 28; size <= 48; size += 2) {
    sizes.push({
      region: 'UK',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'male',
      category: 'bottoms',
      sort_order: size - 27,
    });
  }
  
  // ========================================
  // NUMERIC SIZES - EU (34, 36, 38, 40, etc.)
  // ========================================
  
  // EU sizes for clothing (34-56)
  for (let size = 34; size <= 56; size += 2) {
    sizes.push({
      region: 'EU',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'dresses',
      sort_order: Math.floor((size - 33) / 2),
    });
    sizes.push({
      region: 'EU',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'tops',
      sort_order: Math.floor((size - 33) / 2),
    });
    sizes.push({
      region: 'EU',
      type: 'numeric',
      canonical_label: size.toString(),
      gender_group: 'male',
      category: 'tops',
      sort_order: Math.floor((size - 33) / 2),
    });
  }
  
  // ========================================
  // SHOE SIZES - US
  // ========================================
  
  // Men's US shoe sizes (6-15, with half sizes)
  for (let size = 6; size <= 15; size += 0.5) {
    sizes.push({
      region: 'US',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'male',
      category: 'footwear',
      sort_order: Math.round((size - 6) * 2),
    });
  }
  
  // Women's US shoe sizes (5-12, with half sizes)
  for (let size = 5; size <= 12; size += 0.5) {
    sizes.push({
      region: 'US',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'footwear',
      sort_order: Math.round((size - 5) * 2),
    });
  }
  
  // Kids' US shoe sizes (1-7, with half sizes)
  for (let size = 1; size <= 7; size += 0.5) {
    sizes.push({
      region: 'US',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'kids',
      category: 'footwear',
      sort_order: Math.round((size - 1) * 2),
    });
  }
  
  // ========================================
  // SHOE SIZES - UK
  // ========================================
  
  // Men's UK shoe sizes (5-14, with half sizes)
  for (let size = 5; size <= 14; size += 0.5) {
    sizes.push({
      region: 'UK',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'male',
      category: 'footwear',
      sort_order: Math.round((size - 5) * 2),
    });
  }
  
  // Women's UK shoe sizes (2.5-9.5, with half sizes)
  for (let size = 2.5; size <= 9.5; size += 0.5) {
    sizes.push({
      region: 'UK',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'female',
      category: 'footwear',
      sort_order: Math.round((size - 2.5) * 2),
    });
  }
  
  // ========================================
  // SHOE SIZES - EU
  // ========================================
  
  // EU shoe sizes (35-50, whole numbers only)
  for (let size = 35; size <= 50; size++) {
    sizes.push({
      region: 'EU',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'unisex',
      category: 'footwear',
      sort_order: size - 35,
    });
  }
  
  // ========================================
  // SHOE SIZES - JP (cm-based)
  // ========================================
  
  // JP shoe sizes (22cm-30cm, 0.5cm increments)
  for (let size = 22; size <= 30; size += 0.5) {
    sizes.push({
      region: 'JP',
      type: 'shoe',
      canonical_label: size.toString(),
      gender_group: 'unisex',
      category: 'footwear',
      sort_order: Math.round((size - 22) * 2),
    });
  }
  
  logger.info({ totalSizes: sizes.length }, 'Generated standard sizes seed data');
  return sizes;
}

/**
 * Seed the standard_sizes table with comprehensive size data
 */
export async function seedStandardSizes(client: PoolClient): Promise<number> {
  const sizes = generateStandardSizesSeedData();
  
  logger.info({ sizeCount: sizes.length }, 'Starting to seed standard_sizes table');
  
  let insertedCount = 0;
  
  for (const size of sizes) {
    try {
      await client.query(
        `INSERT INTO standard_sizes (region, type, canonical_label, gender_group, category, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (region, type, canonical_label, gender_group, category) DO NOTHING`,
        [size.region, size.type, size.canonical_label, size.gender_group, size.category, size.sort_order]
      );
      insertedCount++;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        size,
      }, 'Failed to insert standard size');
    }
  }
  
  logger.info({ insertedCount, totalSizes: sizes.length }, 'Completed seeding standard_sizes table');
  return insertedCount;
}

/**
 * Regex patterns for common size formats
 */
const SIZE_PATTERNS = {
  // Alpha sizes: XS, S, M, L, XL, XXL, XXXL (with optional spaces/dashes)
  alpha: /^(XXS|XS|S|M|L|XL|XXL|XXXL)$/i,
  
  // Numeric sizes with optional decimal: 10, 10.5, 42, etc.
  numeric: /^(\d+(?:\.\d+)?)$/,
  
  // Shoe sizes with region prefix: US 10, UK 9.5, EU 42, JP 26.5
  shoeWithRegion: /^(US|UK|EU|JP)\s*(\d+(?:\.\d+)?)$/i,
  
  // Waist x Length: 32x34, 30x32
  waistLength: /^(\d+)\s*[xX]\s*(\d+)$/,
};

/**
 * Normalize size label (trim, uppercase for alpha, handle variations)
 */
function normalizeSizeLabel(rawLabel: string): string {
  let normalized = rawLabel.trim();
  
  // Word-form to canonical size mapping (check FIRST before regex patterns)
  const sizeMap: Record<string, string> = {
    'xxsmall': 'XXS', 'extraextrasmall': 'XXS',
    'xsmall': 'XS', 'extrasmall': 'XS',
    'small': 'S',
    'medium': 'M', 'med': 'M',
    'large': 'L',
    'xlarge': 'XL', 'extralarge': 'XL',
    'xxlarge': 'XXL', 'extraextralarge': 'XXL',
    'xxxlarge': 'XXXL',
  };
  
  // Normalize and check word forms first (handles "extra large", "Medium", etc.)
  const lower = normalized.toLowerCase().replace(/[\s-]/g, '');
  if (sizeMap[lower]) {
    return sizeMap[lower];
  }
  
  // Check if it's already an alpha size in short form (XS, S, M, L, XL, etc.)
  const alphaMatch = normalized.match(SIZE_PATTERNS.alpha);
  if (alphaMatch) {
    return alphaMatch[1].toUpperCase();
  }
  
  // For numeric sizes, remove trailing ".0" (e.g., "10.0" -> "10")
  const numericMatch = normalized.match(SIZE_PATTERNS.numeric);
  if (numericMatch) {
    const num = parseFloat(numericMatch[1]);
    return num % 1 === 0 ? num.toString() : num.toFixed(1);
  }
  
  // Return as-is if no pattern matches
  return normalized;
}

/**
 * Infer size type from context
 */
function inferSizeType(context: SizeMappingContext): SizeType | null {
  const category = context.category?.toLowerCase();
  
  if (category?.includes('shoe') || category?.includes('boot') || category?.includes('sneaker') || 
      category?.includes('footwear')) {
    return 'shoe';
  }
  
  // Default to alpha for tops/outerwear, numeric for bottoms
  if (category?.includes('top') || category?.includes('shirt') || category?.includes('jacket') || 
      category?.includes('coat') || category?.includes('sweater') || category?.includes('hoodie')) {
    return 'alpha';
  }
  
  if (category?.includes('pant') || category?.includes('jean') || category?.includes('trouser') || 
      category?.includes('short') || category?.includes('bottom')) {
    return 'numeric';
  }
  
  if (category?.includes('dress') || category?.includes('skirt')) {
    return 'numeric';
  }
  
  return null; // Unknown, will try to infer from label
}

/**
 * Infer gender group from context
 */
function inferGenderGroup(context: SizeMappingContext): GenderGroup {
  const gender = context.gender?.toLowerCase();
  
  if (gender === 'male' || gender === 'men' || gender === "men's" || gender === 'mens') {
    return 'male';
  }
  
  if (gender === 'female' || gender === 'women' || gender === "women's" || gender === 'womens') {
    return 'female';
  }
  
  if (gender === 'kids' || gender === 'children' || gender === 'child') {
    return 'kids';
  }
  
  return 'unisex';
}

/**
 * Infer category from product category
 */
function inferSizeCategory(context: SizeMappingContext): SizeCategory | undefined {
  const category = context.category?.toLowerCase();
  
  if (category?.includes('shoe') || category?.includes('boot') || category?.includes('sneaker') || 
      category?.includes('footwear')) {
    return 'footwear';
  }
  
  if (category?.includes('top') || category?.includes('shirt') || category?.includes('sweater') || 
      category?.includes('hoodie') || category?.includes('blouse')) {
    return 'tops';
  }
  
  if (category?.includes('pant') || category?.includes('jean') || category?.includes('trouser') || 
      category?.includes('short') || category?.includes('bottom')) {
    return 'bottoms';
  }
  
  if (category?.includes('jacket') || category?.includes('coat') || category?.includes('blazer')) {
    return 'outerwear';
  }
  
  if (category?.includes('dress') || category?.includes('skirt')) {
    return 'dresses';
  }
  
  return undefined;
}

/**
 * Map raw size label to standard size ID using regex-based approach
 * Returns the standard_size_id or null if no match found
 */
export async function mapSizeToStandard(
  client: PoolClient,
  rawLabel: string,
  context: SizeMappingContext = {}
): Promise<number | null> {
  // Normalize the label first
  const normalizedLabel = normalizeSizeLabel(rawLabel);
  
  // Check for region prefix in the label (e.g., "US 10", "UK 9.5")
  const regionMatch = rawLabel.match(SIZE_PATTERNS.shoeWithRegion);
  let region: SizeRegion = context.retailerRegion || context.userRegion || 'US';
  let label = normalizedLabel;
  
  if (regionMatch) {
    region = regionMatch[1].toUpperCase() as SizeRegion;
    label = normalizeSizeLabel(regionMatch[2]);
  }
  
  // Infer size type, gender, and category from context
  let sizeType = inferSizeType(context);
  const genderGroup = inferGenderGroup(context);
  const sizeCategory = inferSizeCategory(context);
  
  // If we couldn't infer type from context, try to infer from label pattern
  if (!sizeType) {
    if (SIZE_PATTERNS.alpha.test(label)) {
      sizeType = 'alpha';
    } else if (SIZE_PATTERNS.numeric.test(label)) {
      // Numeric could be shoe or clothing - need more context
      sizeType = 'numeric';
    } else {
      return null;
    }
  }
  
  // Build query to find matching standard size
  let query = `
    SELECT id FROM standard_sizes 
    WHERE canonical_label = $1 
      AND type = $2 
      AND region = $3
  `;
  
  const params: any[] = [label, sizeType, region];
  let paramIndex = 4;
  let genderParamIndex: number | null = null;
  let categoryParamIndex: number | null = null;
  
  // Add gender filter if we have it
  if (genderGroup && genderGroup !== 'unisex') {
    query += ` AND (gender_group = $${paramIndex} OR gender_group = 'unisex')`;
    params.push(genderGroup);
    genderParamIndex = paramIndex;
    paramIndex++;
  }
  
  // Add category filter if we have it
  if (sizeCategory) {
    query += ` AND (category = $${paramIndex} OR category IS NULL)`;
    params.push(sizeCategory);
    categoryParamIndex = paramIndex;
    paramIndex++;
  }
  
  // Build ORDER BY using tracked parameter indices
  const orderByClauses: string[] = [];
  if (categoryParamIndex !== null) {
    orderByClauses.push(`CASE WHEN category = $${categoryParamIndex} THEN 0 ELSE 1 END`);
  }
  if (genderParamIndex !== null) {
    orderByClauses.push(`CASE WHEN gender_group = $${genderParamIndex} THEN 0 ELSE 1 END`);
  }
  
  if (orderByClauses.length > 0) {
    query += ` ORDER BY ${orderByClauses.join(', ')}`;
  }
  
  query += ` LIMIT 1`;
  
  try {
    const result = await client.query(query, params);
    
    if (result.rows.length > 0) {
      logger.debug({
        rawLabel,
        normalizedLabel: label,
        matchedId: result.rows[0].id,
        sizeType,
        region,
        genderGroup,
        sizeCategory,
      }, 'Successfully mapped size to standard');
      
      return result.rows[0].id;
    } else {
      logger.warn({
        rawLabel,
        normalizedLabel: label,
        sizeType,
        region,
        genderGroup,
        sizeCategory,
        query,
        params,
      }, 'No standard size found for mapping');
      
      return null;
    }
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
      rawLabel,
      context,
    }, 'Error mapping size to standard');
    
    return null;
  }
}

