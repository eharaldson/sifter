/**
 * DOM adapters to make extraction logic work with both DOM and Cheerio
 * Enhanced with better implementations from both codebases
 */

import * as cheerio from 'cheerio';
import { DOMAdapter, ElementAdapter } from './types.js';

// Browser DOM Element Adapter
export class BrowserElementAdapter implements ElementAdapter {
  constructor(private element: Element) {}

  get textContent(): string | null {
    if (this.element instanceof HTMLInputElement) {
      return this.element.value || null;
    }
    return this.element.textContent;
  }

  get innerHTML(): string {
    return this.element.innerHTML;
  }

  get tagName(): string {
    return this.element.tagName;
  }

  get className(): string {
    return this.element.className;
  }

  get id(): string {
    return this.element.id;
  }

  getAttribute(name: string): string | null {
    return this.element.getAttribute(name);
  }

  querySelector(selector: string): ElementAdapter | null {
    const el = this.element.querySelector(selector);
    return el ? new BrowserElementAdapter(el) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    return Array.from(this.element.querySelectorAll(selector))
      .map(el => new BrowserElementAdapter(el));
  }

  closest(selector: string): ElementAdapter | null {
    const el = this.element.closest(selector);
    return el ? new BrowserElementAdapter(el) : null;
  }

  get parentElement(): ElementAdapter | null {
    return this.element.parentElement ? new BrowserElementAdapter(this.element.parentElement) : null;
  }

  get attributes(): Array<{ name: string; value: string }> {
    const attrs: Array<{ name: string; value: string }> = [];
    if (this.element.attributes) {
      for (let i = 0; i < this.element.attributes.length; i++) {
        const attr = this.element.attributes[i];
        attrs.push({ name: attr.name, value: attr.value });
      }
    }
    return attrs;
  }
}

// Browser DOM Adapter
export class BrowserDOMAdapter implements DOMAdapter {
  constructor(private doc: Document) {}

  querySelector(selector: string): ElementAdapter | null {
    const el = this.doc.querySelector(selector);
    return el ? new BrowserElementAdapter(el) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    return Array.from(this.doc.querySelectorAll(selector))
      .map(el => new BrowserElementAdapter(el));
  }

  get textContent(): string {
    return this.doc.body?.textContent || '';
  }

  get title(): string {
    return this.doc.title;
  }

  get baseURI(): string {
    return this.doc.baseURI;
  }

  get body(): ElementAdapter | null {
    return this.doc.body ? new BrowserElementAdapter(this.doc.body) : null;
  }

  getPageUrl(): string | null {
    try {
      const href = this.doc.defaultView?.location?.href;
      return typeof href === 'string' ? href : this.doc.baseURI || null;
    } catch {
      return this.doc.baseURI || null;
    }
  }

  getRetailer(): string {
    try {
      const host = this.doc.defaultView?.location?.hostname || '';
      if (host) return host.replace(/^www\./, '');
      const url = new URL(this.doc.baseURI);
      return (url.hostname || '').replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}

// Cheerio Element Adapter
export class CheerioElementAdapter implements ElementAdapter {
  constructor(private el: cheerio.Cheerio, private $: cheerio.CheerioAPI) {}

  get textContent(): string | null {
    return this.el.text() || null;
  }

  get innerHTML(): string {
    return this.el.html() || '';
  }

  get tagName(): string {
    return this.el.prop('tagName')?.toLowerCase() || '';
  }

  get className(): string {
    return this.el.attr('class') || '';
  }

  get id(): string {
    return this.el.attr('id') || '';
  }

  getAttribute(name: string): string | null {
    return this.el.attr(name) || null;
  }

  querySelector(selector: string): ElementAdapter | null {
    const found = this.el.find(selector).first();
    return found.length ? new CheerioElementAdapter(found, this.$) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    const elements: ElementAdapter[] = [];
    this.el.find(selector).each((_: number, el: any) => {
      elements.push(new CheerioElementAdapter(this.$(el), this.$));
    });
    return elements;
  }

  closest(selector: string): ElementAdapter | null {
    const found = this.el.closest(selector);
    return found.length ? new CheerioElementAdapter(found, this.$) : null;
  }

  get parentElement(): ElementAdapter | null {
    const parent = this.el.parent();
    return parent.length ? new CheerioElementAdapter(parent, this.$) : null;
  }

  get attributes(): Array<{ name: string; value: string }> {
    const attrs: Array<{ name: string; value: string }> = [];
    const node = this.el[0];
    if (node && node.type === 'tag' && node.attribs) {
      for (const [name, value] of Object.entries(node.attribs)) {
        attrs.push({ name, value: value || '' });
      }
    }
    return attrs;
  }
}

// Cheerio DOM Adapter
export class CheerioDOMAdapter implements DOMAdapter {
  constructor(private $: cheerio.CheerioAPI, private url: string) {}

  querySelector(selector: string): ElementAdapter | null {
    const el = this.$(selector).first();
    return el.length ? new CheerioElementAdapter(el, this.$) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    const elements: ElementAdapter[] = [];
    this.$(selector).each((_: number, el: any) => {
      elements.push(new CheerioElementAdapter(this.$(el), this.$));
    });
    return elements;
  }

  get textContent(): string {
    return this.$('body').text() || '';
  }

  get title(): string {
    return this.$('title').text() || '';
  }

  get baseURI(): string {
    return this.url;
  }

  get body(): ElementAdapter | null {
    const body = this.$('body').first();
    return body.length ? new CheerioElementAdapter(body, this.$) : null;
  }

  getPageUrl(): string | null {
    return this.url;
  }

  getRetailer(): string {
    try {
      const url = new URL(this.url);
      return (url.hostname || '').replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}
