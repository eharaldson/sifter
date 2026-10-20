/*
  Detection helpers for product pages.
  Pure functions that only read from the provided Document.
*/
import { detectCategoryAndSubcategory } from '../../../packages/extraction/src/attribute-detection';

// Expanded Price Regex: handles more formats including thousands separators and spaces
const PRICE_RE = /([€£$¥₩₽]\s?\d[\d\s,.']*|\d[\d\s,.']*\s?[€£$¥₩₽])/;

// Expanded CTA Regex: covers more purchase intent phrases including nested text and aria-labels
const CTA_RE = /(add\s+to\s+(?:my\s+)?(?:shopping\s+)?(cart|bag|basket|tote|wishlist)|buy\s+(?:it\s+)?now|get\s+it\s+now|checkout|add\s+to\s+order|purchase(?:\s+now)?|order\s+now|shop\s+now)/i;
// Travel/hospitality CTAs that should exclude product detection
const TRAVEL_CTA_RE = /(book\s+now|reserve\s+(?:now|a\s+room)?|see\s+availability|check\s+availability|select\s+room|choose\s+room|view\s+rooms|find\s+rooms|show\s+rooms|view\s+deals|book\s+this\s+hotel)/i;
const MEDIA_CONTROL_RE = /\b(play|pause|next|previous|prev|subscribe|share|like|dislike|follow|comment|watch|replay)\b/i;

// Sites we never want to classify as product pages
const HOST_DENYLIST = ['youtube.com', 'youtu.be', 'airbnb.com', 'vrbo.com', 'booking.com', 'maps.google.', 'netflix.com', 'hulu.com'];

// Currency hints for price extraction (symbols + common codes)
const CURRENCY_HINT_RE = /[€£$¥₩₽]|(?:\b(?:GBP|USD|EUR|CAD|AUD|NZD|JPY|CNY|HKD|SGD|INR|KRW|SEK|NOK|DKK|CHF|PLN|CZK)\b)/i;

// Known product URL patterns for major retailers
const KNOWN_PRODUCT_PATH_PATTERNS: Record<string, RegExp> = {
  'asos.com': /\/prd\//,
  'zara.com': /\/p\d+\.html/,
  'hm.com': /\/productpage\./,
  'uniqlo.com': /\/products\/E\d+/,
  'endclothing.com': /\.html$/,
  'mrporter.com': /\/product\//,
  'net-a-porter.com': /\/product\//,
  'farfetch.com': /\/shopping\/.+item/,
  'ssense.com': /\/\w+\/product\//,
  'matchesfashion.com': /\/products\//,
};

// Helper to check visibility
function isProbablyVisible(el: Element): boolean {
  const anyEl = el as HTMLElement;
  if (!anyEl) return true;
  if ((anyEl as any).hidden === true) return false;
  
  const win = anyEl.ownerDocument?.defaultView;
  if (!win) return true;

  try {
    const style = win.getComputedStyle(anyEl);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  } catch {
    return true; // Assume visible if we can't check (e.g., in JSDOM)
  }
}

function getText(el: Element): string {
  if (el instanceof HTMLInputElement) return (el.value || '').trim();
  return (el.textContent || '').trim();
}

function hasTravelDateFields(doc: Document): boolean {
  const dateSelectors = [
    '[name*="checkin" i]',
    '[name*="check-in" i]',
    '[id*="checkin" i]',
    '[id*="check-in" i]',
    '[aria-label*="check in" i]',
    '[placeholder*="check in" i]',
    '[name*="checkout" i]',
    '[name*="check-out" i]',
    '[id*="checkout" i]',
    '[id*="check-out" i]',
    '[aria-label*="check out" i]',
    '[placeholder*="check out" i]'
  ].join(', ');

  const dateInputs = Array.from(doc.querySelectorAll('input[type="date"], input[type="datetime-local"], input[type="text"]'))
    .filter((el) => {
      const t = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
      return t.includes('checkin') || t.includes('check-in') || t.includes('checkout') || t.includes('check-out');
    });

  const explicit = doc.querySelectorAll(dateSelectors);
  // Strong signal only if we see both check-in and check-out style inputs
  const hasCheckin = !!doc.querySelector('[name*="checkin" i], [id*="checkin" i], [placeholder*="check in" i], [aria-label*="check in" i]');
  const hasCheckout = !!doc.querySelector('[name*="checkout" i], [id*="checkout" i], [placeholder*="check out" i], [aria-label*="check out" i]');
  return (hasCheckin && hasCheckout) || dateInputs.length >= 2 || explicit.length >= 2;
}

function hasTravelGuestOrRoomSelectors(doc: Document): boolean {
  const sel = [
    '[name*="guests" i]',
    '[id*="guests" i]',
    '[aria-label*="guests" i]',
    '[placeholder*="guests" i]',
    '[name*="rooms" i]',
    '[id*="rooms" i]',
    '[aria-label*="rooms" i]',
    '[placeholder*="rooms" i]',
    '[data-testid*="guests" i]',
    '[data-testid*="rooms" i]'
  ].join(', ');
  return !!doc.querySelector(sel);
}

function hasTravelCta(doc: Document): boolean {
  const nodes = Array.from(doc.querySelectorAll('button, a, [role="button"], input[type="submit"]')).slice(0, 200);
  return nodes.some((el) => {
    if (!isProbablyVisible(el)) return false;
    const t = getText(el);
    const aria = el.getAttribute('aria-label') || '';
    return TRAVEL_CTA_RE.test(`${t} ${aria}`);
  });
}

function isLikelyTravelBooking(doc: Document): boolean {
  let signals = 0;
  if (hasTravelDateFields(doc)) signals += 2; // strong
  if (hasTravelGuestOrRoomSelectors(doc)) signals += 1;
  if (hasTravelCta(doc)) signals += 1;

  // Look for hotel keywords in title or main heading as a softer signal
  const titleText = (doc.title || '').toLowerCase();
  const heading = doc.querySelector('main h1, h1');
  const headingText = getText(heading || doc.createElement('div')).toLowerCase();
  if (/(hotel|stay|resort|villa|bnb|apartment|hostel)/i.test(titleText) || /(hotel|resort|villa|apartment|hostel)/i.test(headingText)) {
    signals += 1;
  }

  return signals >= 2;
}

function parseLooseNumber(raw: string): number | null {
  const s0 = raw.replace(/[\s']/g, '').trim();
  if (!s0) return null;
  
  // Heuristic handling of comma/period thousands/decimals
  let s = s0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  
  if (hasComma && hasDot) {
    // Assume commas are thousands separators: "1,234.56"
    s = s.replace(/,/g, '');
  } else if (hasComma && !hasDot) {
    // Could be "1,234" or "123,45"
    const lastComma = s.lastIndexOf(',');
    const decimals = s.length - lastComma - 1;
    if (decimals === 2) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  }
  
  // Drop any remaining non-numeric noise except dot and minus
  s = s.replace(/[^\d.-]/g, '');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function extractMinPriceFromText(t: string): number | null {
  if (!t) return null;
  if (!CURRENCY_HINT_RE.test(t)) return null;
  
  // Find currency+number patterns. Prefer symbol/code directly adjacent to the amount.
  const re = /(?:([€£$¥₩₽])\s*([\d][\d\s,.']*)|([\d][\d\s,.']*)\s*([€£$¥₩₽])|(?:\b(GBP|USD|EUR|CAD|AUD|NZD|JPY|CNY|HKD|SGD|INR|KRW|SEK|NOK|DKK|CHF|PLN|CZK)\b)\s*([\d][\d\s,.']*)|([\d][\d\s,.']*)\s*\b(GBP|USD|EUR|CAD|AUD|NZD|JPY|CNY|HKD|SGD|INR|KRW|SEK|NOK|DKK|CHF|PLN|CZK)\b)/gi;
  
  let min: number | null = null;
  let m: RegExpExecArray | null;
  
  while ((m = re.exec(t)) !== null) {
    const numStr =
      m[2] || // symbol before number
      m[3] || // number before symbol
      m[6] || // code before number
      m[7] || // number before code
      '';
    
    const n = parseLooseNumber(numStr);
    if (n == null || !(n > 0)) continue;
    if (min == null || n < min) min = n;
  }
  
  return min;
}

function findTitleElement(doc: Document): Element | null {
  const selectors = [
    // Retailer-specific/high-signal
    '#productTitle',
    // General
    'main h1',
    '[data-testid*="title" i]',
    '[data-test*="title" i]',
    '[data-test*="product-title" i]',
    '[class*="product-title" i]',
    '[itemprop="name"]',
    'h1'
  ];
  
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    if (!isProbablyVisible(el)) continue;
    const t = getText(el);
    if (t && t.trim().length >= 2) return el;
  }
  
  return null;
}

function findMinPriceNearTitle(doc: Document): { amount: number; element: Element } | null {
  const titleEl = findTitleElement(doc);
  if (!titleEl) return null;
  
  let container: Element | null = titleEl;
  for (let i = 0; i < 3; i++) {
    container = container?.parentElement || null;
    if (!container) break;
  }
  container = container || titleEl.parentElement || doc.body;
  
  const nodes = Array.from(container.querySelectorAll('*')).slice(0, 600);
  let best: { amount: number; element: Element } | null = null;
  
  for (const el of nodes) {
    if (!isProbablyVisible(el)) continue;
    const t = getText(el);
    if (!t) continue;
    if (!CURRENCY_HINT_RE.test(t)) continue;
    
    const n = extractMinPriceFromText(t);
    if (n == null) continue;
    
    if (!best || n < best.amount) {
      best = { amount: n, element: el };
    }
  }
  
  return best;
}

/**
 * 1. JSON-LD CHECK
 * Checks for a "Product" type in JSON-LD.
 * Accepts any Product type, but filters out products nested inside ItemList/BreadcrumbList.
 */
function isDetailedProduct(node: any, parentType?: string): boolean {
  if (!node || typeof node !== 'object') return false;
  
  // Skip products that are nested inside ItemList or BreadcrumbList (category pages)
  if (parentType && (parentType.toLowerCase().includes('itemlist') || parentType.toLowerCase().includes('breadcrumb'))) {
    return false;
  }
  
  // Must be type Product
  const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (!type.some((t: string) => t && t.toLowerCase() === 'product')) return false;

  // Accept any Product type - having offers/sku/brand/name are strong signals but not required
  // This maintains compatibility with minimal JSON-LD while still detecting products
  return true;
}

export function hasJsonLdProduct(doc: Document): boolean {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  
  for (const s of scripts) {
    const raw = s.textContent?.trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const graph = (data as any)['@graph'] || (Array.isArray(data) ? data : [data]);

      for (const node of graph) {
        if (isDetailedProduct(node)) return true;
      }
    } catch { continue; }
  }
  return false;
}

/**
 * 2. OPEN GRAPH CHECK
 * Strict check for og:type=product
 */
export function hasOgProduct(doc: Document): boolean {
  const meta = doc.querySelector('meta[property="og:type"], meta[name="og:type"]');
  const content = meta?.getAttribute('content')?.trim().toLowerCase();
  // Standard OG types for products
  return content === 'product' || content === 'og:product';
}

/**
 * 3. MICRODATA/SCHEMA.ORG CHECK
 * Checks for Schema.org microdata attributes
 */
export function hasMicrodataProduct(doc: Document): boolean {
  // Check for Schema.org microdata with itemtype
  const hasItemScope = !!doc.querySelector('[itemtype*="schema.org/Product"], [itemtype*="schema.org/product"]');
  // Check for product-specific itemprops that indicate a product context
  const hasProductItemprop = !!doc.querySelector('[itemprop="offers"], [itemprop="sku"]');
  return hasItemScope || hasProductItemprop;
}

/**
 * 4. NEXT.JS DATA CHECK
 * Detects product pages on Next.js/SSR sites by examining __NEXT_DATA__
 */
export function hasNextDataProduct(doc: Document): boolean {
  const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
  if (!nextDataScript?.textContent) return false;
  
  try {
    const data = JSON.parse(nextDataScript.textContent);
    // Check if the page path looks like a product page
    const path = data.asPath || data.page || '';
    const hasProductPath = /\/(product|p|item|pdp|prd)\/|\/prd\d+|\/product\d+/.test(path);
    
    // Look for product-like keys in props (search in stringified version for simplicity)
    const propsStr = JSON.stringify(data.props || {}).toLowerCase();
    const hasProductKeys = /(\"product\":|\"productdata\":|\"pdpdata\":|\"productdetail\":|\"singleproduct\":)/i.test(propsStr);
    
    // Also check for price-related keys which strongly indicate a product page
    const hasPriceKeys = /(\"price\":|\"saleprice\":|\"currentprice\":)/i.test(propsStr);
    
    return hasProductPath || (hasProductKeys && hasPriceKeys);
  } catch {
    return false;
  }
}

/**
 * 5. URL PATTERN CHECK
 * Matches known product URL patterns for major retailers
 */
export function hasProductUrlPattern(doc: Document): boolean {
  try {
    const hostname = doc.location?.hostname || doc.defaultView?.location?.hostname || '';
    const pathname = doc.location?.pathname || doc.defaultView?.location?.pathname || '';
    
    for (const [domain, pattern] of Object.entries(KNOWN_PRODUCT_PATH_PATTERNS)) {
      if (hostname.includes(domain) && pattern.test(pathname)) {
        return true;
      }
    }
  } catch {
    // Ignore errors from accessing location
  }
  return false;
}

/**
 * 6. DOM HEURISTICS
 * Buy Box signals, CTA detection, and price detection
 */

function hasBuyBoxSignals(doc: Document): boolean {
  // A. QUANTITY SELECTOR
  // Product pages usually allow you to pick a quantity. Category pages almost never do.
  const qtyParams = ['quantity', 'qty', 'amount'];
  const qtySelectors = qtyParams.map(p => `input[name*="${p}"], select[name*="${p}"], [data-testid*="${p}"]`).join(', ');
  const qtyInput = doc.querySelector(qtySelectors);
  if (qtyInput && isProbablyVisible(qtyInput)) return true;

  // B. ADD TO CART FORM
  // Look for a form that specifically posts to a cart endpoint
  const cartForm = doc.querySelector('form[action*="/cart"], form[action*="/basket"], form[action*="/bag"], form[action*="add-to-cart"], form[action*="addtocart"]');
  if (cartForm) return true;

  // C. VARIANT SELECTORS
  // Look for radio buttons or selects often used for Size/Color
  const variantSelectors = [
    'select[name*="size"]', 
    'select[name*="color"]',
    'select[name*="colour"]',
    '[data-testid*="size-selector"]',
    '[data-testid*="color-selector"]',
    '[data-testid*="colour-selector"]',
    'input[type="radio"][name*="size"]',
    'input[type="radio"][name*="variant"]',
    '[class*="swatch"]:not([class*="grid"])',
    '[class*="size-picker"]',
    '[class*="color-picker"]',
    '[class*="variant-picker"]'
  ].join(', ');
  
  const variantElements = doc.querySelectorAll(variantSelectors);
  // Require at least 2 variant elements to avoid false positives
  if (variantElements.length >= 2) return true;

  return false;
}

function analyzeCtas(doc: Document): { count: number, isGrid: boolean, primaryButton?: Element } {
  const nodes = Array.from(doc.querySelectorAll('button, a, input[type="submit"], [role="button"]')).slice(0, 300);
  
  let validCtas: Element[] = [];
  const classMap = new Map<string, number>();

  for (const el of nodes) {
    if (!isProbablyVisible(el)) continue;
    
    // Check both direct text AND aria-label (for icon buttons)
    const t = getText(el);
    const ariaLabel = el.getAttribute('aria-label') || '';
    const dataAction = el.getAttribute('data-action') || '';
    const combinedText = `${t} ${ariaLabel} ${dataAction}`;
    
    if (!combinedText.trim()) continue;
    if (MEDIA_CONTROL_RE.test(combinedText)) continue; // Skip media/navigation controls
    
    if (CTA_RE.test(combinedText)) {
      validCtas.push(el);
      // Track class names to detect repeated grids
      const className = el.className;
      if (className) {
        classMap.set(className, (classMap.get(className) || 0) + 1);
      }
    }
  }
  
  // Improved grid detection: check for repeated buttons AND grid container context
  let maxRepeats = 0;
  for (const count of classMap.values()) {
    if (count > maxRepeats) maxRepeats = count;
  }
  
  // Only flag as grid if:
  // 1. Many repeated buttons (5+) with same class
  // 2. AND they appear to be in a list/grid container
  const isInGridContainer = validCtas.length >= 5 && validCtas.some(el => {
    const parent = el.closest('ul, ol, [class*="grid"], [class*="list"], [class*="collection"], [class*="products"]');
    return parent !== null;
  });
  
  const isGrid = maxRepeats >= 5 && isInGridContainer;

  return { 
    count: validCtas.length, 
    isGrid,
    primaryButton: validCtas[0]
  };
}

// Optimized price detection - uses targeted selectors instead of searching all elements
function hasPrice(doc: Document): boolean {
  // High-confidence structured data
  if (doc.querySelector('[itemprop="price"]')) return true;
  if (doc.querySelector('meta[property="product:price:amount"]')) return true;
  if (doc.querySelector('meta[property="og:price:amount"]')) return true;
  
  // High-confidence DOM selectors (case-insensitive where possible)
  const priceSelectors = [
    '[data-testid*="price" i]',
    '[data-test*="price" i]',
    '[data-price]',
    '[data-component*="Price"]',
    '[data-qa*="price" i]',
    '[class*="product-price" i]',
    '[class*="productprice" i]',
    '[class*="current-price" i]',
    '[class*="currentprice" i]',
    '[class*="sale-price" i]',
    '[class*="saleprice" i]',
    '[id*="product-price" i]',
    // Retailer-specific selectors
    '.pdp-price',
    '.product__price',
    '.price-current',
    '.notranslate[class*="price"]',
    '[data-testid="current-price"]',
    '[data-testid="product-price"]'
  ].join(', ');
  
  const candidates = Array.from(doc.querySelectorAll(priceSelectors)).slice(0, 50);
  for (const el of candidates) {
    if (!isProbablyVisible(el)) continue;
    if (PRICE_RE.test(getText(el))) return true;
  }
  
  // Fallback: check generic price class
  const genericPriceElements = Array.from(doc.querySelectorAll('[class*="price" i]')).slice(0, 30);
  for (const el of genericPriceElements) {
    if (!isProbablyVisible(el)) continue;
    const text = getText(el);
    // Be more strict for generic price classes - must have currency symbol
    if (/[€£$¥₩₽]/.test(text) && PRICE_RE.test(text)) return true;
  }

  // Fallback: look near the title container for any currency strings and pick the smallest.
  // This catches designs where price classes don't contain "price" at all.
  const nearby = findMinPriceNearTitle(doc);
  if (nearby) return true;
  
  return false;
}

// Simplified getBestPrice - now only checks structured data (DOM proximity removed for reliability)
export function getBestPrice(doc: Document, _buyButton?: Element): string | null {
  
  // --- STRATEGY 1: Structured Data (100% Reliability) ---
  
  // 1A. Check Open Graph / Meta Tags
  const metaPrice = doc.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"], meta[name="twitter:data1"]');
  if (metaPrice) {
    const content = metaPrice.getAttribute('content');
    if (content) return content.trim();
  }

  // 1B. Check JSON-LD (Search for "Offer")
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent || '');
      const graph = (data['@graph'] || (Array.isArray(data) ? data : [data]));
      for (const node of graph) {
        // Look for an Offer inside a Product or standalone
        const offers = node.offers || (node['@type'] === 'Offer' ? node : null);
        if (offers) {
          // Handle array of offers (e.g. variants) - taking the first or lowPrice
          const offer = Array.isArray(offers) ? offers[0] : offers;
          if (offer.price) return offer.price.toString();
          if (offer.lowPrice) return offer.lowPrice.toString();
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // --- STRATEGY 2: DOM Selectors (High Reliability) ---
  const priceSelectors = [
    '[itemprop="price"]',
    '[data-testid="current-price"]',
    '[data-testid="product-price"]',
    '[data-price]',
    '.product-price',
    '.current-price',
    '.price-current'
  ].join(', ');
  
  const priceEl = doc.querySelector(priceSelectors);
  if (priceEl) {
    const text = getText(priceEl);
    if (PRICE_RE.test(text)) return text;
    
    // Check content attribute
    const content = priceEl.getAttribute('content');
    if (content && /\d/.test(content)) return content;
  }

  // Fallback: scan a small subtree near the title for currency strings and choose the smallest.
  const nearby = findMinPriceNearTitle(doc);
  if (nearby) {
    const t = getText(nearby.element);
    return t || nearby.amount.toString();
  }

  return null;
}

// Result type for DOM heuristics with confidence level
type DomHeuristicsResult = {
  detected: boolean;
  confidence: 'high' | 'medium' | 'low';
};

function analyzeDomHeuristics(doc: Document): DomHeuristicsResult {
  // 1. Analyze CTAs first
  const { count, isGrid } = analyzeCtas(doc);

  // 2. Fail fast on Grid/Category pages
  if (isGrid) return { detected: false, confidence: 'low' };
  if (count === 0) return { detected: false, confidence: 'low' };

  // 3. Check for Buy Box signals (quantity selectors, variant pickers, cart forms)
  const hasBuyBox = hasBuyBoxSignals(doc);
  
  // 4. Check for price
  const priceFound = hasPrice(doc);
  // const detectedPrice = getBestPrice(doc, primaryButton);

  // Strong signal: Buy box features present (quantity selector, variant picker, cart form)
  if (hasBuyBox && priceFound) return { detected: true, confidence: 'high' };
  
  // Standard signal: Price + CTA
  if (priceFound && count > 0 && hasBuyBox) return { detected: true, confidence: 'medium' };

  // Weak signal: Single CTA (likely a focused product page)
  // if (count === 1) return { detected: true, confidence: 'low' };

  return { detected: false, confidence: 'low' };
}

export function hasDomHeuristics(doc: Document): boolean {
  return analyzeDomHeuristics(doc).detected;
}

// Image detection for product pages
function hasImage(doc: Document): boolean {
  const hasOg = !!doc.querySelector('meta[property="og:image"]');
  const hasDom = !!doc.querySelector('main img, [class*="product"] img, [class*="gallery"] img, [data-testid*="image"] img');
  return hasOg || hasDom;
}

/**
 * Main detection function - orchestrates all detection strategies
 */
export function isProductPage(doc: Document): boolean {
  try {
    const hostname = doc.location?.hostname || doc.defaultView?.location?.hostname || '';
    if (HOST_DENYLIST.some((h) => hostname.includes(h))) {
      return false;
    }

    if (isLikelyTravelBooking(doc)) {
      return false;
    }

    const priceSignal = hasPrice(doc);
    if (!priceSignal) {
      return false;
    }

    // Priority 1: High Confidence Metadata
    if (hasOgProduct(doc) || hasJsonLdProduct(doc) || hasMicrodataProduct(doc) || hasNextDataProduct(doc)) {
      return true;
    }
    
    // Priority 2: Known retailer URL patterns (only if price is present)
    if (hasProductUrlPattern(doc)) {
      return true;
    }

    // Priority 3: DOM Heuristics (fallback for sites without good metadata)
    const domResult = analyzeDomHeuristics(doc);
    const hasImg = hasImage(doc);

    // Optional subcategory confidence booster
    let hasSubcategory = false;
    try {
      const title = doc.title || '';
      const desc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const catHit = detectCategoryAndSubcategory(title, desc);
      hasSubcategory = !!catHit?.subcategory;
    } catch {
      hasSubcategory = false;
    }

    if (domResult.detected) {
      if (domResult.confidence === 'high') return true;
      if (domResult.confidence === 'medium') return hasImg || hasSubcategory;
      // low confidence: require image AND subcategory hint
      return hasImg && hasSubcategory;
    }

    return false;

  } catch (e) {
    return false;
  }
}
