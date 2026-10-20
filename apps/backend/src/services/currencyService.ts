import { logger } from '../log';

export interface CurrencyRates {
  base: string;
  rates: Record<string, number>;
  timestamp: Date;
}

export interface ConversionResult {
  convertedAmount: number;
  rate: number;
  fromCurrency: string;
  toCurrency: string;
}

export class CurrencyService {
  private cache: CurrencyRates | null = null;
  private readonly CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
  private readonly API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

  async getExchangeRates(): Promise<CurrencyRates> {
    // Check cache first
    if (this.cache && Date.now() - this.cache.timestamp.getTime() < this.CACHE_TTL) {
      logger.debug('Using cached exchange rates');
      return this.cache;
    }

    try {
      const response = await fetch(this.API_URL);
      
      if (!response.ok) {
        throw new Error(`Exchange rate API returned ${response.status}: ${response.statusText}`);
      }

      const data: any = await response.json();
      
      this.cache = {
        base: 'USD',
        rates: data.rates,
        timestamp: new Date()
      };
      
      return this.cache;
    } catch (error) {
      
      // Return stale cache if available
      if (this.cache) {
        return this.cache;
      }
      
      // Fallback to basic rates if no cache available
      return this.getFallbackRates();
    }
  }

  private getFallbackRates(): CurrencyRates {
    // Basic fallback rates for major currencies (approximate values)
    return {
      base: 'USD',
      rates: {
        USD: 1,
        EUR: 0.85,
        GBP: 0.73,
        SEK: 10.5,
        NOK: 10.8,
        DKK: 6.3,
        JPY: 150,
        CAD: 1.35,
        AUD: 1.5,
        CHF: 0.9,
      },
      timestamp: new Date()
    };
  }

  async convertPrice(
    amount: number, 
    fromCurrency: string, 
    toCurrency: string
  ): Promise<ConversionResult> {
    // No conversion needed if currencies are the same
    if (fromCurrency === toCurrency) {
      return {
        convertedAmount: amount,
        rate: 1,
        fromCurrency,
        toCurrency
      };
    }

    try {
      const rates = await this.getExchangeRates();
      
      // Convert to USD first (base currency)
      let usdAmount: number;
      let fromRate: number;
      
      if (fromCurrency === 'USD') {
        usdAmount = amount;
        fromRate = 1;
      } else {
        fromRate = rates.rates[fromCurrency];
        if (!fromRate) {
          throw new Error(`Exchange rate not available for currency: ${fromCurrency}`);
        }
        usdAmount = amount / fromRate;
      }

      // Convert from USD to target currency
      let convertedAmount: number;
      let toRate: number;
      
      if (toCurrency === 'USD') {
        convertedAmount = usdAmount;
        toRate = 1;
      } else {
        toRate = rates.rates[toCurrency];
        if (!toRate) {
          throw new Error(`Exchange rate not available for currency: ${toCurrency}`);
        }
        convertedAmount = usdAmount * toRate;
      }

      // Calculate the direct conversion rate
      const directRate = toCurrency === 'USD' ? (1 / fromRate) : (toRate / fromRate);
      
      // Round to 2 decimal places
      const roundedAmount = Math.round(convertedAmount * 100) / 100;

      return {
        convertedAmount: roundedAmount,
        rate: directRate,
        fromCurrency,
        toCurrency
      };
    } catch (error) {
      logger.error({ 
        error, 
        fromCurrency, 
        toCurrency, 
        amount 
      }, 'Currency conversion failed');
      
      // Return original amount as fallback
      return {
        convertedAmount: amount,
        rate: 1,
        fromCurrency,
        toCurrency
      };
    }
  }

  async convertMultiplePrices(
    prices: Array<{ amount: number; currency: string }>,
    targetCurrency: string
  ): Promise<Array<ConversionResult>> {
    // Get rates once for all conversions
    const rates = await this.getExchangeRates();
    
    return Promise.all(
      prices.map(({ amount, currency }) => 
        this.convertPrice(amount, currency, targetCurrency)
      )
    );
  }

  getSupportedCurrencies(): string[] {
    if (!this.cache) {
      return Object.keys(this.getFallbackRates().rates);
    }
    return Object.keys(this.cache.rates);
  }

  getCacheInfo(): { isCached: boolean; age: number; currencies: number } {
    if (!this.cache) {
      return { isCached: false, age: 0, currencies: 0 };
    }
    
    return {
      isCached: true,
      age: Date.now() - this.cache.timestamp.getTime(),
      currencies: Object.keys(this.cache.rates).length
    };
  }
}

// Export singleton instance
export const currencyService = new CurrencyService();
