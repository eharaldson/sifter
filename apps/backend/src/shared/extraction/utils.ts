/**
 * Utility functions adapted from extension extraction logic
 */

import { DOMAdapter, ElementAdapter } from './types';

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isMeaningfulText(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = stripHtml(s);
  if (t.length < 25) return false;
  const letters = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters / t.length < 0.25) return false;
  const bad = /\b(home|shop now|add to cart|buy now)\b/i;
  if (bad.test(t)) return false;
  return true;
}

export function normalizeNumber(s: string): number | null {
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  let cleaned = s;
  if (hasComma && hasDot) {
    const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    cleaned = s.replace(/[.,]/g, (_, idx) => idx === last ? '.' : '');
  } else if (hasComma && !hasDot) {
    cleaned = s.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = s.replace(/,/g, '');
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCurrency(val: string | null | undefined): string | null {
  if (!val) return null;
  const s = val.trim().toUpperCase();
  if (!s) return null;
  if (s === '$') return 'USD';
  if (s === '€') return 'EUR';
  if (s === '£') return 'GBP';
  if (/^[A-Z]{3}$/.test(s)) return s;
  return null;
}

export function parseNumericPrice(text: string, currencyHint?: string): { amount: number; currency: string | null } | null {
  const PRICE_NEG = /\b(free|delivery|shipping|orders?\s+(above|over)|spend|return|returns|save|%|off|voucher|promo|discount)\b/i;
  const t = stripHtml(text);
  if (PRICE_NEG.test(t)) return null;
  
  // Enhanced regex to better handle currency symbols and numbers
  const re = /(?:([€£$]|[A-Z]{3})\s*)?(\d[\d.,]+)(?:\s*([€£$]|[A-Z]{3}))?/;
  const m = t.match(re);
  if (!m) return null;
  
  const a = normalizeNumber(m[2]);
  if (a == null || a < 0.01) return null; // Ensure we have a meaningful price
  
  const c = normalizeCurrency(m[1] || m[3] || currencyHint || null);
  return { amount: a, currency: c };
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const normalized = s.replace(/\s/g, '').replace(',', '.');
    const num = Number(normalized);
    return isFinite(num) ? num : null;
  }
  return null;
}

export function toNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function mapItemCondition(val: string | null | undefined): 'new' | 'used' | 'refurbished' | null {
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

export function toAbsoluteUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

export function text(el: ElementAdapter | null): string {
  if (!el) return '';
  return (el.textContent || '').trim();
}

export function getRetailer(doc: DOMAdapter): string {
  try {
    const url = new URL(doc.baseURI);
    return (url.hostname || '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function chooseBestImageUrl(img: ElementAdapter): string | null {
  const srcset = img.getAttribute('srcset');
  if (srcset) {
    const parts = srcset.split(',').map(s => s.trim());
    const last = parts[parts.length - 1];
    const url = last?.split(' ')[0];
    if (url) return url;
  }
  const src = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src');
  return src || null;
}
