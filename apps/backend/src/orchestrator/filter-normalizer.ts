import { 
  COLOR_MAPPINGS, 
  MATERIAL_MAPPINGS, 
  SUBCATEGORY_ALIASES
} from '@find/extraction';
import * as CLOTHING_BRANDS from '../../../../packages/extraction/clothing_brands.json';
import { logger } from '../log';

// Extract brand names from JSON
const BRAND_NAMES = (CLOTHING_BRANDS as any).default || CLOTHING_BRANDS;

/**
 * Normalized filters interface matching database schema
 */
export interface NormalizedFilters {
  brand?: string[];
  color?: string[];
  subcategory?: string[];
  material?: string[];
  gender?: string;
  condition?: string;
  price?: { min?: number; max?: number; currency?: string };
  size?: {
    values: string[];
    region?: 'US' | 'UK' | 'EU' | 'JP';
    type?: 'alpha' | 'numeric' | 'shoe';
  };
}

/**
 * Normalize color values to canonical colors
 */
function normalizeColors(colors?: string[]): string[] {
  if (!colors || colors.length === 0) return [];
  
  const normalized: string[] = [];
  const addedColors = new Set<string>();
  
  for (const color of colors) {
    const colorLower = color.toLowerCase().trim();
    let foundMatch = false;
    
    // Find matching canonical color
    for (const colorMapping of COLOR_MAPPINGS) {
      if (colorMapping.aliases.includes(colorLower)) {
        if (!addedColors.has(colorMapping.color)) {
          normalized.push(colorMapping.color);
          addedColors.add(colorMapping.color);
        }
        foundMatch = true;
        break;
      }
    }
    
    // If no match found, add as-is (lowercase)
    if (!foundMatch && !addedColors.has(colorLower)) {
      normalized.push(colorLower);
      addedColors.add(colorLower);
    }
  }
  
  return normalized;
}

/**
 * Normalize brand names to lowercase for matching
 */
function normalizeBrands(brands?: string[]): string[] {
  if (!brands || brands.length === 0) return [];
  
  const normalized: string[] = [];
  
  for (const brand of brands) {
    const brandLower = brand.toLowerCase().trim();
    
    // Check if brand exists in our list (case-insensitive)
    const matchedBrand = BRAND_NAMES.find((b: string) => 
      typeof b === 'string' && b.toLowerCase() === brandLower
    );
    
    if (matchedBrand) {
      normalized.push(matchedBrand.toLowerCase());
    } else {
      // Add as-is if not found (let DB handle the match)
      normalized.push(brandLower);
    }
  }
  
  return normalized;
}

/**
 * Normalize subcategory to canonical form
 */
function normalizeSubcategories(subcategory?: string[]): string[] {
  if (!subcategory || subcategory.length === 0) return [];

  const normalized: string[] = [];
  const addedSubcategories = new Set<string>();
  
  for (const sub of subcategory) {
    const subLower = sub.toLowerCase().trim();
    let foundMatch = false;
    
    // Find matching canonical subcategory
    for (const aliasMapping of SUBCATEGORY_ALIASES) {
      if (aliasMapping.aliases.includes(subLower)) {
        if (!addedSubcategories.has(aliasMapping.canonical)) {
          normalized.push(aliasMapping.canonical);
          addedSubcategories.add(aliasMapping.canonical);
        }
        foundMatch = true;
        break;
      }
    }
    
    // If no match found, add as-is (lowercase)
    if (!foundMatch && !addedSubcategories.has(subLower)) {
      normalized.push(subLower);
      addedSubcategories.add(subLower);
    }
  }
  
  return normalized;
}

/**
 * Normalize material values to canonical materials
 */
function normalizeMaterials(materials?: string[]): string[] {
  if (!materials || materials.length === 0) return [];
  
  const normalized: string[] = [];
  const addedMaterials = new Set<string>();
  
  for (const material of materials) {
    const materialLower = material.toLowerCase().trim();
    let foundMatch = false;
    
    // Find matching canonical material
    for (const materialMapping of MATERIAL_MAPPINGS) {
      if (materialMapping.aliases.includes(materialLower)) {
        if (!addedMaterials.has(materialMapping.material)) {
          normalized.push(materialMapping.material);
          addedMaterials.add(materialMapping.material);
        }
        foundMatch = true;
        break;
      }
    }
    
    // If no match found, add as-is (lowercase)
    if (!foundMatch && !addedMaterials.has(materialLower)) {
      normalized.push(materialLower);
      addedMaterials.add(materialLower);
    }
  }
  
  return normalized;
}

/**
 * Normalize gender to database values
 */
function normalizeGender(gender?: string): string | null {
  if (!gender) return null;
  
  const genderLower = gender.toLowerCase().trim();
  
  // Map common variations
  const maleVariations = ['male', 'men', "men's", 'mens', 'man', 'masculine'];
  const femaleVariations = ['female', 'women', "women's", 'womens', 'woman', 'feminine'];
  const unisexVariations = ['unisex', 'gender neutral', 'neutral', 'all', 'both'];
  
  if (maleVariations.includes(genderLower)) {
    return 'male';
  }
  
  if (femaleVariations.includes(genderLower)) {
    return 'female';
  }
  
  if (unisexVariations.includes(genderLower)) {
    return 'unisex';
  }
  
  // Return as-is if no match
  return genderLower;
}

/**
 * Normalize condition to database values
 */
function normalizeCondition(condition?: string): string | null {
  if (!condition) return null;
  
  const conditionLower = condition.toLowerCase().trim();
  
  // Map common variations
  const newVariations = ['new', 'brand new', 'unused', 'mint'];
  const usedVariations = ['used', 'second hand', 'secondhand', 'pre-owned', 'preowned', 'vintage'];
  const refurbishedVariations = ['refurbished', 'renewed', 'restored', 'reconditioned'];
  
  if (newVariations.includes(conditionLower)) {
    return 'new';
  }
  
  if (usedVariations.includes(conditionLower)) {
    return 'used';
  }
  
  if (refurbishedVariations.includes(conditionLower)) {
    return 'refurbished';
  }
  
  // Default to 'new' if unclear, or return as-is
  return conditionLower;
}

/**
 * Normalize size values to canonical format
 */
function normalizeSizes(sizeFilter?: any, userRegion?: string): NormalizedFilters['size'] | null {
  if (!sizeFilter || !sizeFilter.values || sizeFilter.values.length === 0) {
    return null;
  }
  
  const normalizedValues: string[] = [];
  
  // Normalize each size value
  for (const value of sizeFilter.values) {
    const valueStr = String(value).trim();
    
    // Map common alpha size variations
    const alphaSizeMap: Record<string, string> = {
      'xxsmall': 'XXS', 'extra extra small': 'XXS',
      'xsmall': 'XS', 'extra small': 'XS',
      'small': 'S',
      'medium': 'M', 'med': 'M',
      'large': 'L',
      'xlarge': 'XL', 'extra large': 'XL',
      'xxlarge': 'XXL', 'extra extra large': 'XXL',
      'xxxlarge': 'XXXL',
    };
    
    const lowerValue = valueStr.toLowerCase().replace(/[\s-]/g, '');
    
    if (alphaSizeMap[lowerValue]) {
      normalizedValues.push(alphaSizeMap[lowerValue]);
    } else if (/^[A-Z]+$/i.test(valueStr)) {
      // Already an alpha size (e.g., "M", "L")
      normalizedValues.push(valueStr.toUpperCase());
    } else if (/^\d+(\.\d+)?$/.test(valueStr)) {
      // Numeric size - remove trailing .0
      const num = parseFloat(valueStr);
      normalizedValues.push(num % 1 === 0 ? num.toString() : num.toFixed(1));
    } else {
      // Keep as-is for other formats (e.g., "32x34")
      normalizedValues.push(valueStr);
    }
  }
  
  // Deduplicate
  const uniqueValues = Array.from(new Set(normalizedValues));
  
  if (uniqueValues.length === 0) {
    return null;
  }
  
  // Only include region if explicitly provided by the user (no auto-inference)
  // This ensures "size L" searches all regions, while "UK size 10" filters by UK
  const region = sizeFilter.region;
  
  return {
    values: uniqueValues,
    region: region as 'US' | 'UK' | 'EU' | 'JP' | undefined,
    type: sizeFilter.type,
  };
}

/**
 * Main normalization function - normalizes all filters
 * 
 * Supports multiple values for brand, color, and material filters (arrays).
 * Each value in the array is normalized individually, and duplicates are removed.
 */
export function normalizeFilters(filters?: any, userRegion?: string): NormalizedFilters {
  if (!filters) return {};
  
  const normalized: NormalizedFilters = {};
  
  // Normalize each filter type
  if (filters.brand) {
    const normalizedBrands = normalizeBrands(filters.brand);
    if (normalizedBrands.length > 0) {
      normalized.brand = normalizedBrands;
    }
  }
  
  if (filters.color) {
    const normalizedColors = normalizeColors(filters.color);
    if (normalizedColors.length > 0) {
      normalized.color = normalizedColors;
    }
  }
  
  if (filters.subcategory) {
    const normalizedSubcategories = normalizeSubcategories(filters.subcategory);
    if (normalizedSubcategories.length > 0) {
      normalized.subcategory = normalizedSubcategories;
    }
  }
  
  if (filters.material) {
    const normalizedMaterials = normalizeMaterials(filters.material);
    if (normalizedMaterials.length > 0) {
      normalized.material = normalizedMaterials;
    }
  }
  
  if (filters.gender) {
    const normalizedGender = normalizeGender(filters.gender);
    if (normalizedGender) {
      normalized.gender = normalizedGender;
    }
  }
  
  if (filters.condition) {
    const normalizedCondition = normalizeCondition(filters.condition);
    if (normalizedCondition) {
      normalized.condition = normalizedCondition;
    }
  }
  
  // Normalize size filter
  if (filters.size) {
    const normalizedSize = normalizeSizes(filters.size, userRegion);
    if (normalizedSize) {
      normalized.size = normalizedSize;
    }
  }
  
  // Pass through price filter as-is
  if (filters.price) {
    normalized.price = filters.price;
  }
  
  // Log normalization for debugging
  logger.debug({
    raw: filters,
    normalized,
    changes: {
      brandCount: filters.brand?.length || 0,
      normalizedBrandCount: normalized.brand?.length || 0,
      colorCount: filters.color?.length || 0,
      normalizedColorCount: normalized.color?.length || 0,
      subcategoryChanged: filters.subcategory !== normalized.subcategory,
      materialCount: filters.material?.length || 0,
      normalizedMaterialCount: normalized.material?.length || 0,
      genderChanged: filters.gender !== normalized.gender,
      conditionChanged: filters.condition !== normalized.condition,
      sizeCount: filters.size?.values?.length || 0,
      normalizedSizeCount: normalized.size?.values?.length || 0,
    }
  }, '🔄 Normalized filters');
  
  return normalized;
}

