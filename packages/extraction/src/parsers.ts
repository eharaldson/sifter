/**
 * Product parsing functions that merge the best logic from both codebases
 * Supports JSON-LD, OpenGraph, NextData, and DOM heuristics
 */

import { DOMAdapter, ElementAdapter, ProductInfo } from './types.js';
import { 
  stripHtml, 
  isMeaningfulText, 
  parseNumericPrice, 
  toNumber, 
  toNullableString, 
  normalizeCurrency, 
  mapItemCondition, 
  dedupe, 
  toAbsoluteUrl, 
  text, 
  chooseBestImageUrl,
  guessCurrencyFromSymbols
} from './utils.js';

// Helper to check if two URLs point to the same page (ignoring query params)
function areUrlsForSamePage(url1: string, url2: string): boolean {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    // Compare origin and pathname (ignoring trailing slashes)
    const match = u1.origin === u2.origin && 
           u1.pathname.replace(/\/$/, '') === u2.pathname.replace(/\/$/, '');
      
    return match;
  } catch (e) {
    return false;
  }
}

// ========================
// JSON-LD Product Parser
// ========================

export function parseJsonLdProduct(doc: DOMAdapter): Partial<ProductInfo> | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const currentPageUrl = doc.getPageUrl();
  
  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    
    try {
      const data = JSON.parse(raw);
      const nodes: any[] = [];
      
      if (Array.isArray(data)) {
        nodes.push(...data);
      } else if (data && typeof data === 'object') {
        nodes.push(data);
        if (Array.isArray((data as any)['@graph'])) {
          nodes.push(...(data as any)['@graph']);
        }
      }

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const typeVal = (node as any)['@type'];
        if (!isProductType(typeVal)) continue;
        
        // STALE DATA CHECK: Verify URL matches current page
        // This prevents using stale JSON-LD from previous pages in SPAs
        if (currentPageUrl) {
          const nodeUrl = toNullableString(node.url) || toNullableString(node['@id']);
          if (nodeUrl) {
            const absNodeUrl = toAbsoluteUrl(nodeUrl, doc);
            if (!areUrlsForSamePage(absNodeUrl, currentPageUrl)) {
              continue; // Skip this node as it belongs to a different page
            }
          }
        }

        return pickFromJsonLdProduct(node, doc);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function pickFromJsonLdProduct(node: any, doc: DOMAdapter): Partial<ProductInfo> {
  const title = toNullableString(node.name);
  const description = toNullableString(node.description);

  const brandField = node.brand;
  const brand = typeof brandField === 'string'
    ? brandField
    : (brandField && typeof brandField === 'object' && toNullableString(brandField.name)) || null;

  const images: string[] = [];
  if (Array.isArray(node.image)) {
    for (const img of node.image) {
      if (typeof img === 'string') images.push(toAbsoluteUrl(img, doc));
    }
  } else if (typeof node.image === 'string') {
    images.push(toAbsoluteUrl(node.image, doc));
  }

  let price: number | null = null;
  let currency: string | null = null;
  let condition: ProductInfo['condition'] | null = null;

  const offers = node.offers;
  const offerList: any[] = Array.isArray(offers) ? offers : (offers ? [offers] : []);
  const parsedOffers: { price: number; currency: string | null; cond: ProductInfo['condition'] | null }[] = [];
  
  for (const o of offerList) {
    if (!o || typeof o !== 'object') continue;
    const priceResult = parseNumericPrice(toNullableString(o.price) || '');
    const p = priceResult?.amount || null;
    const c = normalizeCurrency(toNullableString(o.priceCurrency)) || priceResult?.currency || null;
    const cond = mapItemCondition(toNullableString(o.itemCondition));
    if (p != null) parsedOffers.push({ price: p, currency: c, cond });
    if (cond && !condition) condition = cond;
  }
  
  if (parsedOffers.length) {
    currency = parsedOffers.find(x => x.currency)?.currency || null;
    const prices = parsedOffers.map(x => x.price).sort((a, b) => a - b);
    price = prices[0] ?? null;
  }

  let color: string | null = null;
  if (node.color) {
    color = toNullableString(node.color);
  }

  // Extract category from JSON-LD
  let category: string | null = null;
  let subCategory: string | null = null;
  if (node.category) {
    if (typeof node.category === 'string') {
      category = node.category;
    } else if (Array.isArray(node.category)) {
      if (node.category.length > 0) {
        category = toNullableString(node.category[0]);
      }
      if (node.category.length > 1) {
        subCategory = toNullableString(node.category[1]);
      }
    }
  }

  // Extract material from additionalProperty
  let primaryMaterial: string | null = null;
  if (Array.isArray(node.additionalProperty)) {
    for (const prop of node.additionalProperty) {
      if (prop && typeof prop === 'object') {
        const name = toNullableString(prop.name);
        if (name && name.toLowerCase().includes('material')) {
          primaryMaterial = toNullableString(prop.value);
          break;
        }
      }
    }
  }

  return {
    title: title || null,
    brand: brand || null,
    description: description || null,
    price: price ?? null,
    currency: currency ?? null,
    condition,
    color,
    category,
    subCategory,
    primaryMaterial,
    images: dedupe(images)
  };
}

// ========================
// OpenGraph Product Parser
// ========================

export function parseOpenGraphProduct(doc: DOMAdapter): Partial<ProductInfo> | null {
  
  const getMeta = (prop: string) => {
    const meta = doc.querySelector(`meta[property="${prop}"]`) || doc.querySelector(`meta[name="${prop}"]`);
    return meta?.getAttribute('content');
  };

  const title = getMeta('og:title')?.trim() || null;
  const rawOgDesc = getMeta('og:description');
  const description = isMeaningfulText(rawOgDesc) ? stripHtml(rawOgDesc!) : null;

  const images = doc.querySelectorAll('meta[property="og:image"], meta[name="og:image"]')
    .map(m => m.getAttribute('content') || '')
    .filter(Boolean)
    .map(u => toAbsoluteUrl(u, doc));

  // Prefer sale price over list/original price when available
  const priceAmount =
    getMeta('product:sale_price:amount') ||
    getMeta('og:sale_price:amount') ||
    getMeta('product:price:amount') ||
    getMeta('og:price:amount') ||
    null;

  const priceCurrency = normalizeCurrency(
    getMeta('product:sale_price:currency') ||
      getMeta('og:sale_price:currency') ||
      getMeta('product:price:currency') ||
      getMeta('og:price:currency') ||
      null
  );
  const brand = (getMeta('product:brand') || getMeta('og:brand') || doc.querySelector('meta[name="brand"]')?.getAttribute('content') || '').trim() || null;
  const condition = mapItemCondition(getMeta('product:condition') || getMeta('og:condition') || null);
  const color = getMeta('product:color') || getMeta('og:color') || null;
  const category = getMeta('product:category') || getMeta('og:category') || null;
  const primaryMaterial = getMeta('product:material') || getMeta('og:material') || null;

  const priceResult = parseNumericPrice(priceAmount || '');
  const price = priceResult?.amount || null;

  if (!title && !description && !images.length && price == null && !brand) return null;

  return {
    title,
    description,
    images,
    price: price ?? null,
    currency: price != null ? (priceCurrency || priceResult?.currency || guessCurrencyFromSymbols(doc) || null) : null,
    brand,
    condition,
    color,
    category,
    primaryMaterial
  };
}

// ========================
// Next.js Data Parser
// ========================

export function parseNextDataProduct(doc: DOMAdapter): Partial<ProductInfo> | null {
  const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
  if (!nextDataScript || !nextDataScript.textContent) return null;

  try {
    const nextData = JSON.parse(nextDataScript.textContent);
    const currentPageUrl = doc.getPageUrl();
    
    // STALE DATA CHECK: Validate against current URL
    // Next.js __NEXT_DATA__ does not update on client-side navigation
    if (nextData.asPath) {
      if (currentPageUrl) {
        const absDataUrl = toAbsoluteUrl(nextData.asPath, doc);
        
        if (!areUrlsForSamePage(absDataUrl, currentPageUrl)) {
           // The __NEXT_DATA__ is for a different page (likely the landing page or previous page)
           return null;
        }
      }
    }

    // Search for 'product' key anywhere in the object tree
    const product = findProductInObject(nextData);
    if (!product || typeof product !== 'object') return null;

    // SECONDARY STALE CHECK: Check if the found product object has a URL that mismatches
    const productUrl = toNullableString(product.url) || toNullableString(product.uri) || toNullableString(product.canonicalUrl);
    if (currentPageUrl) {
        if (productUrl) {
            const absProductUrl = toAbsoluteUrl(productUrl, doc);
            if (!areUrlsForSamePage(absProductUrl, currentPageUrl)) {
                return null;
            }
        } else if (!nextData.asPath) {
            // CRITICAL: No asPath AND no product URL to validate = likely stale data during SPA navigation
            return null;
        }
    }

    const title = toNullableString(product.title);
    let description = toNullableString(product.description);
    
    // Extract details and append to description
    if (Array.isArray(product.details) && product.details.length > 0) {
      const detailsText = product.details
        .map((detail: any) => toNullableString(detail))
        .filter(Boolean)
        .join(', ');
      
      if (detailsText) {
        description = description ? `${description};; ${detailsText}` : detailsText;
      }
    }
    
    // Extract images from the complex images object
    const images: string[] = [];
    if (product.images && typeof product.images === 'object') {
      // Add main image
      if (product.images.main) {
        images.push(toAbsoluteUrl(product.images.main, doc));
      }
      
      // Add gallery images
      if (Array.isArray(product.images.gallery)) {
        for (const img of product.images.gallery) {
          if (typeof img === 'string') {
            images.push(toAbsoluteUrl(img, doc));
          }
        }
      }
      
      // Add list images as fallback
      if (product.images.list) {
        if (product.images.list.normal) {
          images.push(toAbsoluteUrl(product.images.list.normal, doc));
        }
        if (product.images.list.hover) {
          images.push(toAbsoluteUrl(product.images.list.hover, doc));
        }
      }
    }

    // Extract price and currency - GBP > USD > first available
    let price: number | null = null;
    let currency: string | null = null;
    
    if (product.prices && typeof product.prices === 'object') {
      // Try currencies in order of preference: GBP > USD > first available
      const preferredCurrencies = ['GBP', 'USD'];
      
      for (const curr of preferredCurrencies) {
        const priceData = product.prices[curr];
        if (priceData && typeof priceData === 'object') {
          const priceResult = parseNumericPrice(toNullableString(priceData.price) || '');
          const priceValue = priceResult?.amount || null;
          if (priceValue != null) {
            price = priceValue;
            currency = normalizeCurrency(priceData.currency || curr) || priceResult?.currency || null;
            break;
          }
        }
      }
      
      // If no preferred currency found, use the first available
      if (price == null) {
        const firstCurrency = Object.keys(product.prices)[0];
        if (firstCurrency) {
          const priceData = product.prices[firstCurrency];
          if (priceData && typeof priceData === 'object') {
            const priceResult = parseNumericPrice(toNullableString(priceData.price) || '');
            const priceValue = priceResult?.amount || null;
            if (priceValue != null) {
              price = priceValue;
              currency = normalizeCurrency(priceData.currency || firstCurrency) || priceResult?.currency || null;
            }
          }
        }
      }
    }

    // Extract brand from categories (often the first category is the brand)
    let brand: string | null = null;
    let category: string | null = null;
    let subCategory: string | null = null;
    
    if (Array.isArray(product.categories) && product.categories.length > 0) {
      // Look for a brand-like category (usually not generic terms like "Men", "Women", "Footwear")
      const genericTerms = ['men', 'women', 'footwear', 'clothing', 'apparel', 'accessories'];
      for (const cat of product.categories) {
        const categoryStr = toNullableString(cat);
        if (categoryStr && !genericTerms.includes(categoryStr.toLowerCase())) {
          if (!brand) brand = categoryStr;
          else if (!category) category = categoryStr;
          else if (!subCategory) subCategory = categoryStr;
        }
      }
      
      // If no brand found from non-generic categories, use first category
      if (!brand && product.categories.length > 0) {
        brand = toNullableString(product.categories[0]);
      }
    }

    // Extract color
    let color: string | null = null;
    if (Array.isArray(product.colors) && product.colors.length > 0) {
      color = toNullableString(product.colors[0]);
    }

    // Extract material
    let primaryMaterial: string | null = null;
    if (Array.isArray(product.materials) && product.materials.length > 0) {
      primaryMaterial = toNullableString(product.materials[0]);
    } else if (toNullableString(product.material)) {
      primaryMaterial = toNullableString(product.material);
    }

    // Determine condition - assume new unless specified otherwise
    const condition: ProductInfo['condition'] = 'new';

    if (!title && !description && images.length === 0 && price == null && !brand) return null;

    return {
      title,
      description,
      images,
      price,
      currency,
      brand,
      condition,
      color,
      category,
      subCategory,
      primaryMaterial
    };
  } catch {
    // ignore malformed Next.js data
    return null;
  }
}

function findProductInObject(obj: any): any | null {
  if (!obj || typeof obj !== 'object') return null;
  
  // Check if current object has a 'product' key (case-insensitive)
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === 'product') {
      return obj[key];
    }
  }
  
  // Recursively search in nested objects and arrays
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      const found = findProductInObject(value);
      if (found) return found;
    }
  }
  
  return null;
}

// ========================
// DOM Heuristics Parser
// ========================

export function parseDomHeuristics(doc: DOMAdapter): Partial<ProductInfo> | null {  
  const title = pickTitle(doc);
  const brand = pickBrand(doc, title);
  const currencyHint = guessCurrencyFromSymbols(doc) || null;
  
  const productRoot = findProductRoot(doc);
  const priceCandidates = collectPriceCandidates(productRoot, currencyHint);
  const best = priceCandidates[0];
  let price = best ? best.amount : null;
  let currency = best ? best.currency : null;
  
  // Fallback: if no price candidates were found via selectors, scan a small DOM region
  // near the product title. This helps with minimalist class naming where "price" never appears.
  if (price == null) {
    const nearby = pickMinPriceNearTitle(doc, currencyHint);
    if (nearby) {
      price = nearby.amount;
      currency = nearby.currency;
    }
  }
  
  const images = pickImages(doc);
  const description = pickDescription(doc);
  const color = pickColor(doc);
  const category = pickCategory(doc);
  const primaryMaterial = pickMaterial(doc);

  if (!title && price == null && images.length === 0) return null;

  const result = {
    title,
    brand,
    description,
    price,
    currency,
    images,
    color,
    category,
    primaryMaterial
  };
  
  return result;
}

function pickTitleElement(doc: DOMAdapter): ElementAdapter | null {
  const titleSelectors = [
    'main h1', 'main [data-test*="title"]', 'main [class*="title"]',
    '.pdp-product-title', '[data-auto-id="productTitle"]',
    '[data-testid*="title"]', '[data-test*="product-title"]',
    'h1'
  ];
  
  for (const selector of titleSelectors) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const t = text(el);
    if (t && t.trim()) return el;
  }
  
  return null;
}

type NearbyMinPrice = { amount: number; currency: string | null };

function pickMinPriceNearTitle(doc: DOMAdapter, currencyHint: string | null): NearbyMinPrice | null {
  const titleEl = pickTitleElement(doc);
  if (!titleEl) return null;
  
  // Walk up 3 parent elements from the title element (or stop early if missing)
  let container: ElementAdapter | null = titleEl;
  for (let i = 0; i < 3; i++) {
    if (!container?.parentElement) break;
    container = container.parentElement;
  }
  if (!container) return null;

  // Look for currency signals in a limited subtree to avoid picking up unrelated page-wide prices.
  // Support common symbols and currency codes.
  const CURRENCY_HINT_RE = /(?:\p{Sc}|[€£$¥₩₽₺₹₪฿₫₱₦])|(?:\b(?:GBP|USD|EUR|CAD|AUD|NZD|JPY|CNY|HKD|SGD|INR|KRW|SEK|NOK|DKK|ISK|CHF|PLN|CZK|HUF|RON|TRY)\b)|(?:\b(?:kr|kč|zł|ft|lei)\b)/iu;
  
  // Scan a bounded number of nodes for performance.
  const nodes = container.querySelectorAll('*').slice(0, 600);
  
  let best: NearbyMinPrice | null = null;
  
  for (const el of nodes) {
    const t = text(el);
    if (!t) continue;
    if (!CURRENCY_HINT_RE.test(t)) continue;
    
    const parsed = parseNumericPrice(t, currencyHint || undefined);
    if (!parsed) continue;
    if (!(parsed.amount > 0)) continue;
    
    const parsedCurrency = normalizeCurrency(parsed.currency) || parsed.currency || currencyHint || null;
    
    if (!best || parsed.amount < best.amount) {
      best = { amount: parsed.amount, currency: parsedCurrency };
    }
  }
  
  return best;
}

function pickTitle(doc: DOMAdapter): string | null {
  // High priority selectors for specific retailers
  const titleSelectors = [
    'main h1', 'main [data-test*="title"]', 'main [class*="title"]',
    // ASOS-specific selectors  
    '.pdp-product-title', '[data-auto-id="productTitle"]',
    // General high-priority selectors
    '[data-testid*="title"]', '[data-test*="product-title"]',
    'h1'
  ];
  
  for (const selector of titleSelectors) {
    const element = doc.querySelector(selector);
    if (element) {
      const title = text(element);
      if (title && title.trim()) {
        return title.trim();
      }
    }
  }
  
  // Fallback to page title
  const t = doc.title?.trim() || '';
  if (!t) return null;
  const cleaned = t.split('|')[0].split(' - ')[0].split(' — ')[0].trim();
  return cleaned || null;
}

function pickBrand(doc: DOMAdapter, title: string | null): string | null {
  const metaBrand = doc.querySelector('meta[name="brand"]')?.getAttribute('content')?.trim();
  if (metaBrand) return metaBrand || null;
  const ogBrand = doc.querySelector('meta[property="product:brand"]')?.getAttribute('content')?.trim();
  if (ogBrand) return ogBrand || null;

  if (title) {
    const first = title.trim().split(/\s+/)[0] || '';
    if (first.length >= 2 && /^[A-Z0-9&-]+$/.test(first) && first === first.toUpperCase()) {
      return first;
    }
  }
  return null;
}

function pickImages(doc: DOMAdapter): string[] {
  const imageSelectors = [
    'main img', '#product img', '[class*="product"] img', '[data-test*="image"] img',
    // ASOS-specific selectors
    '.gallery-image img', '.product-gallery img', '.hero-image img', '[data-testid="product-image"] img',
    // Generic high-priority selectors  
    '[data-testid*="image"] img', '.product-images img', '.image-gallery img'
  ].join(', ');
  
  const nodes = doc.querySelectorAll(imageSelectors).slice(0, 40);

  const urls: string[] = [];
  
  for (const el of nodes) {
    if (el.tagName !== 'img' && el.tagName !== 'IMG') continue;
    const chosen = chooseBestImageUrl(el);
    if (!chosen) continue;
    const absoluteUrl = toAbsoluteUrl(chosen, doc);
    urls.push(absoluteUrl);
  }
  
  const deduped = dedupe(urls);
  return deduped;
}

function pickDescription(doc: DOMAdapter): string | null {
  let description = '';
  
  // Helper function to check if an element is inside a header/hidden container
  const isInHeaderOrHiddenContainer = (element: ElementAdapter): boolean => {
    // Check if element or any parent has data-sentry-element="HeaderBarOuterSC"
    let current: ElementAdapter | null | undefined = element;
    while (current) {
      const sentryElement = current.getAttribute('data-sentry-element');
      if (sentryElement === 'HeaderBarOuterSC') {
        return true;
      }
      // Move to parent
      current = current.parentElement;
      if (!current) break;
    }
    return false;
  };
  
  // Priority 1: Check for End Clothing specific description elements
  const endClothingDescriptionSelectors = [
    '[data-test-id*="escription" i]',
    '[data-testid*="escription" i]',
    '[data-sentry-component*="escription" i]'
  ].join(', ');
  
  const endClothingDescElements = doc.querySelectorAll(endClothingDescriptionSelectors);
  
  if (endClothingDescElements.length > 0) {
    for (const descEl of endClothingDescElements) {
      // Skip if this element is inside a header or hidden container
      if (isInHeaderOrHiddenContainer(descEl)) {
        continue;
      }
      
      // Extract text from paragraphs and list items, but exclude navigation links
      const paragraphs = descEl.querySelectorAll('p');
      const listItems = descEl.querySelectorAll('li');
      
      // Extract paragraph text
      for (const p of paragraphs) {
        const pText = text(p);
        if (pText && pText.length > 10) {
          description = description ? `${description} ${pText}` : pText;
        }
      }
      
      // Extract list items, but filter out navigation links
      const listTexts: string[] = [];
      for (const li of listItems) {
        const liText = text(li);
        // Skip list items that are primarily navigation links (contain "Shop All", "View All", etc.)
        if (liText && 
            !liText.toLowerCase().includes('shop all') && 
            !liText.toLowerCase().includes('view all') &&
            !liText.toLowerCase().includes('see all') &&
            liText.length > 5 && 
            liText.length < 200) {
          listTexts.push(liText);
        }
      }
      
      if (listTexts.length > 0) {
        const listDescription = listTexts.join(', ');
        description = description ? `${description}. ${listDescription}` : listDescription;
      }
    }
    
    if (description) {
      return description || null;
    }
  }
  
  // Fallback: Check meta description
  const meta = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim();
  if (meta) {
    description = meta;
  } else {
    const main = doc.querySelector('main') || doc.body;
    const p = main ? main.querySelector('p') : null;
    const t = text(p);
    if (t) {
      description = t;
    }
  }
  
  // Fallback: Generic product info selectors
  const productInfoSelectors = [
    '#product-information-content-panel',
    '.product-information-content',
    '.product-information-body',
    '.product-details-react',
    '.short_description',
    // ASOS-specific selectors
    '.about-me',
    '.product-description',
    '[data-testid="product-description"]',
    '.pdp-product-details',
    // Generic selectors
    '[class*="product-information"]',
    '[class*="productInformation"]',
    '[class*="product_information"]',
    '[class*="product-info"]',
    '[class*="product-details"]',
    '[class*="productdetails"]',
    '[class*="product_details"]',
    '[class*="short-description"]',
    '[class*="shortdescription"]',
    '[class*="short_description"]'
  ].join(', ');

  const root = doc.querySelector('#product-information-content-panel') || 
               doc.querySelector('.product-details-react') || 
               doc;
  
  const productInfoElements = root.querySelectorAll(productInfoSelectors).slice(0, 10);
  
  for (const el of productInfoElements) {
    const infoText = el.innerHTML ? stripHtml(el.innerHTML).trim() : text(el);
    
    if (infoText && infoText.length > 10 && infoText.length < 500) {
      if (!description.toLowerCase().includes(infoText.toLowerCase().slice(0, 50))) {
        description = description ? `${description};; ${infoText}` : infoText;
      }
    }
  }
  
  return description || null;
}

function pickColor(doc: DOMAdapter): string | null {
  const colorSelectors = [
    '[data-color]',
    '[data-variant-color]',
    '[class*="color"]',
    '[id*="color"]',
    '[data-test*="color"]',
    '[data-qa*="color"]',
    '[data-testid*="color"]',
    '.selected-color',
    '.active-color',
    '.current-color',
    // ASOS-specific color selectors
    '.selected-colour',
    '.colour-size .selected',
    '[data-testid="colour-select"] .selected'
  ].join(', ');

  const candidates = doc.querySelectorAll(colorSelectors).slice(0, 20);
  
  for (const el of candidates) {
    const dataColor = el.getAttribute('data-color') || el.getAttribute('data-variant-color');
    if (dataColor) return dataColor.trim() || null;
    
    const textContent = text(el);
    if (textContent && textContent.length < 30) {
      const colorWords = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'brown', 'grey', 'gray', 'beige', 'navy', 'tan', 'olive', 'maroon', 'teal', 'lime', 'silver', 'gold'];
      const lowerText = textContent.toLowerCase();
      for (const colorWord of colorWords) {
        if (lowerText.includes(colorWord)) {
          return textContent.trim();
        }
      }
    }
  }
  
  return null;
}

function pickCategory(doc: DOMAdapter): string | null {
  // Look for breadcrumbs or category navigation
  const breadcrumbSelectors = [
    'nav[aria-label*="breadcrumb"] a',
    '.breadcrumb a',
    '[class*="breadcrumb"] a',
    'nav ol li a',
    'nav ul li a'
  ].join(', ');

  const breadcrumbs = doc.querySelectorAll(breadcrumbSelectors);
  if (breadcrumbs.length > 1) {
    // Skip first (usually "Home") and last (usually current product)
    const categoryLink = breadcrumbs[1];
    if (categoryLink) {
      const categoryText = text(categoryLink);
      if (categoryText && categoryText.length > 2 && categoryText.length < 50) {
        return categoryText;
      }
    }
  }

  return null;
}

function pickMaterial(doc: DOMAdapter): string | null {
  const materialSelectors = [
    '[data-material]',
    '[class*="material"]',
    '[id*="material"]'
  ].join(', ');

  const candidates = doc.querySelectorAll(materialSelectors).slice(0, 10);
  
  for (const el of candidates) {
    const dataMaterial = el.getAttribute('data-material');
    if (dataMaterial) return dataMaterial.trim() || null;
    
    const textContent = text(el);
    if (textContent && textContent.length >= 3 && textContent.length <= 50) {
      // Check if it mentions common materials
      const materialWords = ['cotton', 'silk', 'wool', 'leather', 'polyester', 'nylon', 'denim', 'cashmere', 'linen', 'suede'];
      const lowerText = textContent.toLowerCase();
      for (const materialWord of materialWords) {
        if (lowerText.includes(materialWord)) {
          return textContent.trim();
        }
      }
    }
  }
  
  return null;
}

function findProductRoot(doc: DOMAdapter): ElementAdapter {
  const title = doc.querySelector('h1, [data-test*="title"], [data-testid*="title"], [class*="title"]');
  
  if (title) {
    const productContainer = title.closest('[id*="product"], [class*="product"], main, [role="main"]');
    
    if (productContainer) {
      const priceInContainer = productContainer.querySelector('[class*="price"], [data-component*="Price"], [data-testid*="price"], [data-test*="price"], [data-qa*="price"]');
      if (priceInContainer) {
        return productContainer;
      }
    }
    
    const priceElements = doc.querySelectorAll('[class*="price"], [data-component*="Price"], [data-testid*="price"], [data-test*="price"], [data-qa*="price"]');
    
    if (priceElements.length > 0) {
      return doc.body!;
    }
    
    return title.parentElement || doc.body!;
  }

  return doc.body!;
}

type PriceCandidate = { el: ElementAdapter, amount: number, currency: string | null, score: number };

function collectPriceCandidates(root: ElementAdapter, currencyHint: string | null): PriceCandidate[] {
  const PRICE_SEL = [
    // Case-insensitive attribute selectors (using 'i' flag) to catch variations like "Price", "PRICE", etc.
    '[itemprop="price"]','[data-price]','[data-testid*="price" i]','[data-test*="price" i]',
    '[class*="price" i]','[id*="price" i]','[data-component*="price" i]',
    '[data-qa*="price" i]','[data-cy*="price" i]',
    // Also search for "value" which is commonly used (e.g., PriceWithSchema__value)
    '[class*="value" i]','[id*="value" i]',
    // Look for content attribute that might contain numeric price values
    '[content]',
    // ASOS-specific price selectors
    '[data-testid="current-price"]', '.price .notranslate', '.current-price .notranslate',
    '.price-current', '.notranslate',
    // Depop-specific price selectors
    '.styles_currentPrice__MpqGt',
    // Vinted-specific price selectors
    '[data-testid*="price-text"]', '.web_ui__Text__text',
    // Selfridges-specific price selectors
    '[data-testid*="price"]', '.price', '[class*="price"]',
    // Lyst-specific price selectors
    '[data-testid="product-price"]', '.ducdwf0', '.vjlibs2',
    '[data-testid*="ProductHeaderPrice"]'
    // EndClothing-specific price selectors
    // '[data-test-id*="Price"]', '[data-test-id="ProductCard__ProductFinalPrice"]', 
    // 'span:has-text("£")', 'div:has-text("£")', '[class*="Price"]', '.price-value',
    // // MrPorter-specific price selectors
    // '[data-testid*="price"]', '.price-current', '.price-original', '.product-price'
  ].join(',');
  
  const candidates: PriceCandidate[] = [];
  
  const selectorElements = root.querySelectorAll(PRICE_SEL);
  
  selectorElements.forEach((el, index) => {
    const elementText = text(el);
    
    // First try to parse the text content
    let p = parseNumericPrice(elementText, currencyHint || undefined);
    
    // If that fails, check the content attribute (e.g., <span content="44">£44</span>)
    if (!p) {
      const contentAttr = el.getAttribute('content');
      if (contentAttr) {
        // Try parsing just the content attribute value
        p = parseNumericPrice(contentAttr, currencyHint || undefined);
        // If content attr has just a number, try to get currency from text
        if (p && !p.currency) {
          const textPrice = parseNumericPrice(elementText, currencyHint || undefined);
          if (textPrice?.currency) {
            p.currency = textPrice.currency;
          }
        }
      }
    }
    
    if (p) {
      const score = basePriceScore(el) + 5;
      candidates.push({ el, amount: p.amount, currency: p.currency, score });
    }
  });

  const dedupedCandidates = dedupePrices(candidates);
  const sortedCandidates = dedupedCandidates.sort((a,b) => b.score - a.score);
  
  return sortedCandidates;
}

function basePriceScore(el: ElementAdapter): number {
  let s = 0;
  const cls = (el.className || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const textContent = text(el).toLowerCase();
  const dataTestId = (el.getAttribute('data-testid') || '').toLowerCase();
  const dataTest = (el.getAttribute('data-test') || '').toLowerCase();
  const dataQa = (el.getAttribute('data-qa') || '').toLowerCase();
  const contentAttr = (el.getAttribute('content') || '').toLowerCase();
  
  // High priority selectors
  if (dataTestId === 'current-price') s += 10;
  if (cls.includes('notranslate') && (cls.includes('price') || cls.includes('current'))) s += 8;
  
  // Boost score for elements with content attribute containing numbers
  if (contentAttr && /\d/.test(contentAttr)) s += 5;
  
  // Boost for class names with "value" + price-related terms (e.g., PriceWithSchema__value)
  if (cls.includes('value') && (cls.includes('price') || cls.includes('schema') || cls.includes('sale'))) s += 6;
  
  // Depop-specific high priority selector
  if (cls.includes('styles_currentprice__mpqgt')) s += 12;
  
  // Vinted-specific high priority selectors
  if (dataTestId.includes('price-text')) s += 11;
  if (cls.includes('web_ui__text__text') && (textContent.match(/[£$€]\s*\d/) || textContent.match(/\d[\d\s.,]*\s*(?:kr|kč|zł|ft|lei)\b/))) s += 9;
  
  // Selfridges-specific high priority selectors
  if (dataTestId.includes('price') && (textContent.match(/[£$€]\s*\d/) || textContent.match(/\d[\d\s.,]*\s*(?:kr|kč|zł|ft|lei)\b/))) s += 10;
  if (cls.includes('price') && (textContent.match(/[£$€]\s*\d/) || textContent.match(/\d[\d\s.,]*\s*(?:kr|kč|zł|ft|lei)\b/))) s += 8;
  
  // Lyst-specific high priority selectors
  if (dataTestId === 'product-price') s += 12;
  if (cls.includes('ducdwf0') && (textContent.match(/[£$€]\s*\d/) || textContent.match(/\d[\d\s.,]*\s*(?:kr|kč|zł|ft|lei)\b/))) s += 11;
  if (cls.includes('vjlibs2') && (textContent.match(/[£$€]\s*\d/) || textContent.match(/\d[\d\s.,]*\s*(?:kr|kč|zł|ft|lei)\b/))) s += 10;

  // General: any currency symbol near a number (beyond £/$/€)
  if (/\p{Sc}\s*\d/u.test(textContent) || /\d[\d\s.,]*\s*\p{Sc}/u.test(textContent)) s += 4;
  if (/\d[\d\s.,]*\s*(?:kr|kč|zł|ft|lei)\b/.test(textContent)) s += 4;
  
  // EndClothing-specific high priority selectors
  // if (dataTest.includes('price') && textContent.match(/[£$€]\d/)) s += 12;
  // if (dataTestId === 'ProductCard__ProductFinalPrice') s += 13;
  // if (cls.includes('price') && textContent.match(/£\d/)) s += 11;
  // if ((el.tagName === 'SPAN' || el.tagName === 'DIV') && textContent.match(/^£\d+/)) s += 10;
  
  // // MrPorter-specific high priority selectors
  // if (dataTestId.includes('price') && textContent.match(/[£$€]\d/)) s += 12;
  // if (cls.includes('price-current') && textContent.match(/[£$€]\d/)) s += 11;
  // if (cls.includes('product-price') && textContent.match(/[£$€]\d/)) s += 10;
  
  // Check class names and IDs for price-related terms
  if (/(^|[-_])(price|amount|current|now|sale)([-_]|$)/.test(cls + ' ' + id)) s += 3;
  
  // Check data attributes for price-related terms (higher priority than class/id)
  if (/(price|amount|current|now|sale)/.test(dataTestId + ' ' + dataTest + ' ' + dataQa)) s += 4;
  
  // Bonus for specific price patterns in data-testid
  if (/price.*actual|actual.*price|current.*price|price.*current/.test(dataTestId)) s += 2;
  
  // Negative indicators
  if (/(header|footer|banner|promo|toast|modal)/.test(cls + ' ' + id)) s -= 3;
  if (/free|delivery|shipping|returns?/.test(textContent)) s -= 4;
  
  return s;
}

function dedupePrices(cs: PriceCandidate[]): PriceCandidate[] {
  const seen = new Set<string>();
  return cs.filter(c => {
    const k = `${c.currency||'UNK'}:${c.amount.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function countCtas(doc: DOMAdapter): number {
  const CTA_RE = /(add\s+to\s+(?:shopping\s+)?(cart|bag|basket)|add\s+to\s+basket|buy\s+now|add\s+to\s+wishlist|purchase|order\s+now|shop\s+now)/i;
  const nodes = doc.querySelectorAll('button, a, input[type="submit"], input[type="button"]').slice(0, 300);
  let count = 0;
  const matchedCtas: string[] = [];
  
  for (const el of nodes) {
    const t = text(el);
    if (!t) continue;
    if (CTA_RE.test(t)) {
      count++;
      matchedCtas.push(t.trim());
    }
  }
  
  return count;
}

function isProductType(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === 'string') return value.toLowerCase() === 'product';
  if (Array.isArray(value)) return value.some(v => typeof v === 'string' && v.toLowerCase() === 'product');
  return false;
}
