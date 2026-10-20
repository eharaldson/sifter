/**
 * DOM adapters to make extension extraction logic work with both DOM and Cheerio
 */

import * as cheerio from 'cheerio';
import { DOMAdapter, ElementAdapter } from './types';

// Cheerio adapter for server-side scraping
export class CheerioElementAdapter implements ElementAdapter {
  constructor(private element: cheerio.Cheerio<any>) {}

  get textContent(): string | null {
    return this.element.text() || null;
  }

  getAttribute(name: string): string | null {
    return this.element.attr(name) || null;
  }

  querySelector(selector: string): ElementAdapter | null {
    const found = this.element.find(selector).first();
    return found.length > 0 ? new CheerioElementAdapter(found) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    const elements: ElementAdapter[] = [];
    this.element.find(selector).each((_, el) => {
      const $ = cheerio.load('');
      elements.push(new CheerioElementAdapter($(el)));
    });
    return elements;
  }

  get tagName(): string {
    return this.element.prop('tagName')?.toLowerCase() || '';
  }

  get className(): string {
    return this.element.attr('class') || '';
  }

  get id(): string {
    return this.element.attr('id') || '';
  }

  closest(selector: string): ElementAdapter | null {
    const found = this.element.closest(selector);
    return found.length > 0 ? new CheerioElementAdapter(found) : null;
  }

  get parentElement(): ElementAdapter | null {
    const parent = this.element.parent();
    return parent.length > 0 ? new CheerioElementAdapter(parent) : null;
  }
}

export class CheerioDOMAdapter implements DOMAdapter {
  constructor(private $: cheerio.CheerioAPI, private url: string) {}

  querySelector(selector: string): ElementAdapter | null {
    const found = this.$(selector).first();
    return found.length > 0 ? new CheerioElementAdapter(found) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    const elements: ElementAdapter[] = [];
    this.$(selector).each((_, el) => {
      elements.push(new CheerioElementAdapter(this.$(el)));
    });
    return elements;
  }

  get title(): string {
    return this.$('title').text() || '';
  }

  get baseURI(): string {
    return this.url;
  }

  get body(): ElementAdapter | null {
    const body = this.$('body').first();
    return body.length > 0 ? new CheerioElementAdapter(body) : null;
  }
}

// Browser DOM adapter for extension
export class BrowserElementAdapter implements ElementAdapter {
  constructor(private element: any) {}

  get textContent(): string | null {
    return this.element.textContent;
  }

  getAttribute(name: string): string | null {
    return this.element.getAttribute(name);
  }

  querySelector(selector: string): ElementAdapter | null {
    const found = this.element.querySelector(selector);
    return found ? new BrowserElementAdapter(found) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    return Array.from(this.element.querySelectorAll(selector))
      .map(el => new BrowserElementAdapter(el));
  }

  get tagName(): string {
    return this.element.tagName.toLowerCase();
  }

  get className(): string {
    return this.element.className;
  }

  get id(): string {
    return this.element.id;
  }

  closest(selector: string): ElementAdapter | null {
    const found = this.element.closest(selector);
    return found ? new BrowserElementAdapter(found) : null;
  }

  get parentElement(): ElementAdapter | null {
    return this.element.parentElement ? new BrowserElementAdapter(this.element.parentElement) : null;
  }
}

export class BrowserDOMAdapter implements DOMAdapter {
  constructor(private document: any) {}

  querySelector(selector: string): ElementAdapter | null {
    const found = this.document.querySelector(selector);
    return found ? new BrowserElementAdapter(found) : null;
  }

  querySelectorAll(selector: string): ElementAdapter[] {
    return Array.from(this.document.querySelectorAll(selector))
      .map(el => new BrowserElementAdapter(el));
  }

  get title(): string {
    return this.document.title;
  }

  get baseURI(): string {
    return this.document.baseURI;
  }

  get body(): ElementAdapter | null {
    return this.document.body ? new BrowserElementAdapter(this.document.body) : null;
  }
}
