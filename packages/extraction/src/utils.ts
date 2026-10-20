/**
 * Shared utility functions for product extraction
 * Merges the best logic from both backend and frontend implementations
 */

import { DOMAdapter, ElementAdapter, ProductInfo } from './types.js';

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(title: string): string {
  if (!title) return '';
  
  return title
    .trim()
    .toLowerCase() // Convert to lowercase
    .replace(/\s+/g, ' ')
    .replace(/[™®©]/g, '')
    .replace(/\b(size|sz)\s*:?\s*\w+/gi, '')
    .replace(/\b(sku|item)\s*:?\s*[\w-]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeBrand(brand: string | null): string | null {
  if (!brand) return null;
  
  return brand
    .trim()
    .toLowerCase() // Keep lowercase for consistency
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

export function isMeaningfulText(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = stripHtml(s);
  if (t.length < 25) return false;                    // too short to be a description
  const letters = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters / t.length < 0.25) return false;       // mostly non-letters
  const bad = /\b(home|shop now|add to cart|buy now)\b/i;
  if (bad.test(t)) return false;
  return true;
}

export function normalizeNumber(s: string): number | null {
  // handle "1,299.99" and "1.299,99"
  // Also handle "1 299,99" (spaces/NBSP as thousands separators)
  const raw = s.replace(/[\s\u00A0\u202F]/g, '');
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  let cleaned = raw;
  
  if (hasComma && hasDot) {
    // Both comma and dot present - last punctuation is decimal sep
    const lastCommaIdx = raw.lastIndexOf(',');
    const lastDotIdx = raw.lastIndexOf('.');
    const lastIdx = Math.max(lastCommaIdx, lastDotIdx);
    cleaned = raw.replace(/[.,]/g, (match, idx) => idx === lastIdx ? '.' : '');
  } else if (hasComma && !hasDot) {
    // Only comma present - need to determine if it's thousands separator or decimal
    const commaIdx = raw.lastIndexOf(',');
    const digitsAfterComma = raw.length - commaIdx - 1;
    
    // If there are exactly 3 digits after the comma, it's likely a thousands separator (e.g., "2,270")
    // If there are 1-2 digits after the comma, it's likely a decimal separator (e.g., "2,27" or "2,5")
    if (digitsAfterComma === 3) {
      cleaned = raw.replace(/,/g, ''); // US/UK-style thousands separator
    } else {
      cleaned = raw.replace(',', '.'); // EU-style decimal
    }
  } else {
    cleaned = raw.replace(/,/g, ''); // US/UK-style thousand sep
  }
  
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCurrency(val: string | null | undefined): string | null {
  if (!val) return null;
  const s = val.trim().toUpperCase();
  if (!s) return null;
  // If symbol passed in, map it
  if (s === '$') return 'USD';
  if (s === '€') return 'EUR';
  if (s === '£') return 'GBP';
  if (s === '¥') return 'JPY';
  if (s === '₽') return 'RUB';
  if (s === '₺') return 'TRY';
  if (s === '₹') return 'INR';
  if (s === '₪') return 'ILS';
  if (s === '฿') return 'THB';
  if (s === '₫') return 'VND';
  if (s === '₱') return 'PHP';
  if (s === '₦') return 'NGN';
  if (s === 'HK$') return 'HKD';
  if (s === 'NZ$') return 'NZD';
  if (s === 'AU$') return 'AUD';
  if (s === 'CA$') return 'CAD';
  if (s === 'SG$') return 'SGD';
  if (s === 'S$') return 'SGD';
  if (s === 'US$') return 'USD';
  if (s === 'KR') return 'SEK';
  if (s === 'KČ') return 'CZK';
  if (s === 'ZŁ') return 'PLN';
  if (s === 'FT') return 'HUF';
  if (s === 'LEI') return 'RON';
  if (s === '₩') return 'KRW';
  if (s === '₽') return 'RUB';
  if (s === '₺') return 'TRY';
  if (s === '₹') return 'INR';
  if (s === '₪') return 'ILS';
  if (s === '฿') return 'THB';
  if (s === '₫') return 'VND';
  if (s === '₱') return 'PHP';
  if (s === '₦') return 'NGN';
  // Otherwise assume ISO code
  if (/^[A-Z]{3}$/.test(s)) return s;
  return null;
}

function currencyHintFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.').filter(Boolean);
    const tld = parts[parts.length - 1] || '';
    // Conservative mapping for locales where currency is very likely
    if (tld === 'se') return 'SEK';
    if (tld === 'no') return 'NOK';
    if (tld === 'dk') return 'DKK';
    if (tld === 'is') return 'ISK';
    if (tld === 'ch') return 'CHF';
    if (tld === 'pl') return 'PLN';
    if (tld === 'cz') return 'CZK';
    if (tld === 'hu') return 'HUF';
    if (tld === 'ro') return 'RON';
    if (tld === 'tr') return 'TRY';
    if (tld === 'jp') return 'JPY';
    if (tld === 'kr') return 'KRW';
    if (tld === 'in') return 'INR';
    if (tld === 'sg') return 'SGD';
    if (tld === 'hk') return 'HKD';
    if (tld === 'nz') return 'NZD';
    if (tld === 'au') return 'AUD';
    if (tld === 'ca') return 'CAD';
    return null;
  } catch {
    return null;
  }
}

function normalizeCurrencyToken(token: string | null | undefined, currencyHint?: string | null): string | null {
  if (!token) return normalizeCurrency(currencyHint || null);
  const hint = normalizeCurrency(currencyHint || null);
  const raw = token.trim();
  if (!raw) return hint;
  const upper = raw.toUpperCase();

  // ISO code or basic symbols
  const iso = normalizeCurrency(upper);

  if (iso) return iso;

  // Multi-character dollar forms (unambiguous)
  const dollarMap: Record<string, string> = {
    'HK$': 'HKD',
    'NZ$': 'NZD',
    'AU$': 'AUD',
    'A$': 'AUD',
    'CA$': 'CAD',
    'C$': 'CAD',
    'SG$': 'SGD',
    'S$': 'SGD',
    'US$': 'USD'
  };
  if (dollarMap[upper]) return dollarMap[upper];

  // Common suffix tokens / symbols
  if (upper === 'KR') {
    // Ambiguous: SEK/NOK/DKK/ISK. Use a hint if available.
    if (hint && ['SEK', 'NOK', 'DKK', 'ISK'].includes(hint)) return hint;
    return null;
  }
  if (upper === 'KČ') return 'CZK';
  if (upper === 'ZŁ') return 'PLN';
  if (upper === 'FT') return 'HUF';
  if (upper === 'LEI') return 'RON';

  // Single-character currency symbols (some are ambiguous; use hint if it helps)
  if (raw === '₩') return 'KRW';
  if (raw === '₽') return 'RUB';
  if (raw === '₺') return 'TRY';
  if (raw === '₹') return 'INR';
  if (raw === '₪') return 'ILS';
  if (raw === '฿') return 'THB';
  if (raw === '₫') return 'VND';
  if (raw === '₱') return 'PHP';
  if (raw === '₦') return 'NGN';
  if (raw === '¥') {
    if (hint && ['JPY', 'CNY'].includes(hint)) return hint;
    return 'JPY';
  }
  if (raw === '$') {
    if (hint && ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD'].includes(hint)) return hint;
    return 'USD';
  }

  return hint;
}

export function parseNumericPrice(text: string, currencyHint?: string): { amount: number; currency: string | null } | null {
  const PRICE_NEG = /\b(free|delivery|shipping|orders?\s+(above|over)|spend|return|returns|save|%|off|voucher|promo|discount)\b/i;
  const t = stripHtml(text).replace(/[\u00A0\u202F]/g, ' ');
  if (PRICE_NEG.test(t)) return null;
  
  const hint =
    normalizeCurrency(currencyHint || null) ||
    currencyHintFromUrl(currencyHint || null) || // allow callers to pass a URL as a "hint"
    null;

  // Match a number with separators (.,,) and optional spaces.
  const NUM_RE = /\d[\d\s.,]*/;
  const m = NUM_RE.exec(t);
  if (!m) return null;
  
  const a = normalizeNumber(m[0]);
  if (a == null || a < 0.01) return null; // Ensure we have a meaningful price
  
  // Try to detect currency token close to the numeric portion (prefix/suffix).
  const start = m.index ?? 0;
  const end = start + m[0].length;
  const before = t.slice(Math.max(0, start - 12), start);
  const after = t.slice(end, Math.min(t.length, end + 12));

  const tokenRe = /(?:HK\$|NZ\$|AU\$|CA\$|SG\$|US\$|[A-Z]{3}|kr|kč|zł|ft|lei|[$€£¥₩₽₺₹₪฿₫₱₦]|\p{Sc})/iu;
  const token =
    (after.match(tokenRe)?.[0] || before.match(tokenRe)?.[0] || null);

  const c = normalizeCurrencyToken(token, hint);
  return { amount: a, currency: c };
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // Replace decimal comma with dot when appropriate
    const normalized = s.replace(/\s/g, '').replace(',', '.');
    const num = Number(normalized);
    return isFinite(num) ? num : null;
  }
  return null;
}

export function toNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function mapItemCondition(val: string | null | undefined): ProductInfo['condition'] | null {
  if (!val) return null;
  const s = val.toLowerCase();
  if (s.includes('new')) return 'new';
  if (s.includes('used') || s.includes('preowned') || s.includes('pre-owned')) return 'used';
  if (s.includes('refurb')) return 'refurbished';
  return null;
}

export function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function toAbsoluteUrl(url: string, doc: DOMAdapter): string {
  try {
    return new URL(url, doc.baseURI || doc.getPageUrl() || undefined).toString();
  } catch {
    return url;
  }
}

export function text(el: ElementAdapter | null): string {
  if (!el) return '';
  if (el.tagName === 'input' || el.tagName === 'INPUT') {
    // For input elements, try to get value attribute
    const value = el.getAttribute('value');
    if (value) return value.trim();
  }
  return (el.textContent || '').trim();
}

export function chooseBestImageUrl(img: ElementAdapter): string | null {
  // Priority 1: Check src attribute first (most reliable for End Clothing)
  const src = img.getAttribute('src');
  if (src && src.trim()) {
    return src.trim();
  }
  
  // Priority 2: Check srcset and extract highest quality image
  const srcset = img.getAttribute('srcset');
  if (srcset) {
    const parts = srcset.split(',').map(s => s.trim());
    // Pick the highest density/width candidate (last)
    const last = parts[parts.length - 1];
    const url = last?.split(' ')[0];
    if (url) {
      return url;
    }
  }
  
  // Priority 3: Check common lazy-loading attributes
  const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-original');
  if (dataSrc && dataSrc.trim()) {
    return dataSrc.trim();
  }
  
  // Priority 4: Scan all attributes for image URLs (fallback for unusual patterns)
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif'];
  const attributes = img.attributes || [];
  
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    const value = attr?.value || '';
    
    // Check if the attribute value looks like an image URL
    const lowerValue = value.toLowerCase();
    if (imageExtensions.some(ext => lowerValue.includes(ext))) {
      // Extract the URL (it might be in a complex string)
      const urlMatch = value.match(/(https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|gif|svg|avif)[^\s"']*)/i);
      if (urlMatch) {
        return urlMatch[0];
      }
    }
  }
  
  return null;
}

export function guessCurrencyFromSymbols(doc: DOMAdapter): string | null {
  const textContent = ((doc.textContent || doc.body?.textContent || '')).slice(0, 50000);
  const urlHint = currencyHintFromUrl(doc.getPageUrl());
  const upper = textContent.toUpperCase();

  // Prefer explicit ISO currency codes if present.
  const codes = [
    'USD','EUR','GBP','CAD','AUD','NZD','HKD','SGD',
    'JPY','CNY','KRW','INR',
    'SEK','NOK','DKK','ISK','CHF',
    'PLN','CZK','HUF','RON','TRY',
    'ILS','THB','VND','PHP','NGN','RUB','BRL'
  ];
  for (const code of codes) {
    const re = new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`);
    if (re.test(upper)) return code;
  }

  // Unambiguous multi-character forms.
  if (upper.includes('HK$')) return 'HKD';
  if (upper.includes('NZ$')) return 'NZD';
  if (upper.includes('AU$') || upper.includes('A$')) return 'AUD';
  if (upper.includes('CA$') || upper.includes('C$')) return 'CAD';
  if (upper.includes('SG$') || upper.includes('S$')) return 'SGD';
  if (upper.includes('US$')) return 'USD';

  // Symbols and common tokens.
  if (textContent.includes('€')) return 'EUR';
  if (textContent.includes('£')) return 'GBP';
  if (textContent.includes('₩')) return 'KRW';
  if (textContent.includes('₽')) return 'RUB';
  if (textContent.includes('₺')) return 'TRY';
  if (textContent.includes('₹')) return 'INR';
  if (textContent.includes('₪')) return 'ILS';
  if (textContent.includes('฿')) return 'THB';
  if (textContent.includes('₫')) return 'VND';
  if (textContent.includes('¥')) return (urlHint === 'CNY' ? 'CNY' : 'JPY');

  // "kr" appears for Nordic currencies; disambiguate via TLD when possible.
  if (/\b\d[\d\s.,]*\s*kr\b/i.test(textContent)) {
    if (urlHint && ['SEK', 'NOK', 'DKK', 'ISK'].includes(urlHint)) return urlHint;
  }

  if (textContent.includes('$')) {
    if (urlHint && ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD'].includes(urlHint)) return urlHint;
    return 'USD';
  }
  
  return null;
}
