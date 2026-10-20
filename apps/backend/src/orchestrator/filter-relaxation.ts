import { performManagedSearch, SearchManagerResult } from './search-tools';
import { NormalizedFilters } from './filter-normalizer';
import { logger } from '../log';

/**
 * Result from search with relaxation
 */
export interface RelaxedSearchResult {
  results: any[];
  relaxedFilters: string[];
  finalFilters: NormalizedFilters;
  attemptsCount: number;
}

/**
 * Priority order for relaxing filters (remove in this order)
 */
const RELAXATION_PRIORITY = [
  'gender',      // Least specific
  'material',
  'subcategory',
  'color',
  'condition',
  'brand',
  'price'        // Last resort
];

/**
 * Clone filters object
 */
function cloneFilters(filters?: NormalizedFilters): NormalizedFilters {
  if (!filters) return {};
  return JSON.parse(JSON.stringify(filters));
}

/**
 * Get active filter names
 */
function getActiveFilters(filters: NormalizedFilters): string[] {
  const active: string[] = [];
  
  if (filters.gender) active.push('gender');
  if (filters.material && filters.material.length > 0) active.push('material');
  if (filters.subcategory) active.push('subcategory');
  if (filters.color && filters.color.length > 0) active.push('color');
  if (filters.condition) active.push('condition');
  if (filters.brand && filters.brand.length > 0) active.push('brand');
  if (filters.price && (filters.price.min || filters.price.max)) active.push('price');
  
  return active;
}

/**
 * Remove a specific filter from filters object
 */
function removeFilter(filters: NormalizedFilters, filterName: string): void {
  switch (filterName) {
    case 'gender':
      delete filters.gender;
      break;
    case 'material':
      delete filters.material;
      break;
    case 'subcategory':
      delete filters.subcategory;
      break;
    case 'color':
      delete filters.color;
      break;
    case 'condition':
      delete filters.condition;
      break;
    case 'brand':
      delete filters.brand;
      break;
    case 'price':
      delete filters.price;
      break;
  }
}

/**
 * Perform search with progressive filter relaxation
 * Tries search with all filters, then progressively removes filters until results are found
 */
export async function searchWithRelaxation(
  searchStrategy: SearchManagerResult,
  topK: number,
  excludeProductIds?: string[],
  filters?: NormalizedFilters
): Promise<RelaxedSearchResult> {
  const relaxedFilters: string[] = [];
  let currentFilters = cloneFilters(filters);
  let attemptsCount = 0;
  
  logger.info({
    initialFilters: getActiveFilters(currentFilters),
    topK,
    excludedCount: excludeProductIds?.length || 0
  }, '🔍 Starting search with filter relaxation');
  
  // Try with all filters first
  attemptsCount++;
  let results = await performManagedSearch(
    searchStrategy,
    topK,
    excludeProductIds,
    currentFilters
  );
  
  logger.info({
    attempt: attemptsCount,
    activeFilters: getActiveFilters(currentFilters),
    resultCount: results.length
  }, '📊 Search attempt result');
  
  // If we have results, return immediately
  if (results.length > 0) {
    return {
      results,
      relaxedFilters,
      finalFilters: currentFilters,
      attemptsCount
    };
  }
  
  // No results - start progressive relaxation
  const activeFilters = getActiveFilters(currentFilters);
  
  for (const filterToRelax of RELAXATION_PRIORITY) {
    // Skip if this filter isn't active
    if (!activeFilters.includes(filterToRelax)) {
      continue;
    }
    
    // Remove this filter
    removeFilter(currentFilters, filterToRelax);
    relaxedFilters.push(filterToRelax);
    
    logger.info({
      relaxedFilter: filterToRelax,
      remainingFilters: getActiveFilters(currentFilters),
      relaxedSoFar: relaxedFilters
    }, '🔄 Relaxing filter');
    
    // Try search again
    attemptsCount++;
    results = await performManagedSearch(
      searchStrategy,
      topK,
      excludeProductIds,
      currentFilters
    );
    
    logger.info({
      attempt: attemptsCount,
      relaxedFilter: filterToRelax,
      activeFilters: getActiveFilters(currentFilters),
      resultCount: results.length
    }, '📊 Search attempt result after relaxation');
    
    // If we have results, return
    if (results.length > 0) {
      logger.info({
        relaxedFilters,
        finalFilters: getActiveFilters(currentFilters),
        attemptsCount,
        resultCount: results.length
      }, '✅ Search succeeded after filter relaxation');
      
      return {
        results,
        relaxedFilters,
        finalFilters: currentFilters,
        attemptsCount
      };
    }
  }
  
  // No results even with all filters removed
  logger.warn({
    relaxedFilters,
    attemptsCount,
    resultCount: results.length
  }, '⚠️ No results found even after full filter relaxation');
  
  return {
    results: [],
    relaxedFilters,
    finalFilters: currentFilters,
    attemptsCount
  };
}

