import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
// Removed Button, Heart, ExternalLink imports - no longer needed
import { ICON_SIZES } from "@/constants/dimensions";
import { extensionAPI } from "@/api-messaging";

interface AiLookalikesProps {
  productId?: number | null;
  productInfo?: any;
}

// Helper function to get currency symbol
function getCurrencySymbol(currency: string): string {
  switch (currency) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    default:
      return currency + ' ';
  }
}

// Helper function to format price with conversion - returns object for flexible display
function formatPriceWithConversion(
  price: number, 
  currency: string, 
  convertedPrice?: number, 
  baseCurrency?: string
): { main: string; secondary?: string; hasConversion: boolean } {
  if (convertedPrice && baseCurrency && currency !== baseCurrency) {
    return {
      main: `${getCurrencySymbol(baseCurrency)}${convertedPrice}`,
      secondary: `${getCurrencySymbol(currency)}${price}`,
      hasConversion: true
    };
  }
  
  return {
    main: `${getCurrencySymbol(currency)}${price}`,
    hasConversion: false
  };
}

const AiLookalikes = ({ productId, productInfo }: AiLookalikesProps) => {
  const [localSimilarProducts, setLocalSimilarProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exchangeRates, setExchangeRates] = useState<Record<string, number> | null>(null);
  const [conditionFilter, setConditionFilter] = useState<'used' | 'new'>('used');
  const [resultLimit, setResultLimit] = useState(10);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  
  // Track request ID to ignore stale responses
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const currentProductIdRef = useRef<number | null | undefined>(null);
  const isLoadingRef = useRef(false);

  // Fetch exchange rates
  const fetchExchangeRates = async () => {
    try {
      const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const data = await response.json();
      setExchangeRates(data.rates);
    } catch (error) {
      // Use fallback rates for major currencies
      setExchangeRates({
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
      });
    }
  };

  // Convert price between currencies
  const convertPrice = (amount: number, fromCurrency: string, toCurrency: string): number => {
    if (!exchangeRates || fromCurrency === toCurrency) return amount;
    
    // Convert to USD first (base currency)
    const usdAmount = fromCurrency === 'USD' ? amount : amount / exchangeRates[fromCurrency];
    // Convert from USD to target currency
    const convertedAmount = toCurrency === 'USD' ? usdAmount : usdAmount * exchangeRates[toCurrency];
    
    return Math.round(convertedAmount * 100) / 100; // Round to 2 decimal places
  };

  // Fetch exchange rates when component mounts
  useEffect(() => {
    fetchExchangeRates();
  }, []);

  // Reset pagination when product or condition changes
  useEffect(() => {
    setResultLimit(10);
    setHasMore(true);
  }, [productId, conditionFilter]);

  // Fetch similar products when component mounts or dependencies change
  useEffect(() => {
    // Reset mounted ref when effect runs
    isMountedRef.current = true;
    
    // Validate required data
    if (!productInfo || !productId || productId === null || productId === undefined || isNaN(Number(productId))) {
      setLoading(false);
      setLocalSimilarProducts([]);
      currentProductIdRef.current = productId;
      isLoadingRef.current = false;
      return;
    }

    // Check if this is the same product ID we're already loading
    if (currentProductIdRef.current === productId && isLoadingRef.current) {
      return; // Already loading this product
    }

    // Increment request ID and store current product ID
    requestIdRef.current += 1;
    const currentRequestId = requestIdRef.current;
    currentProductIdRef.current = productId;
    isLoadingRef.current = true;

    const fetchSimilarProducts = async () => {
      // Don't proceed if component unmounted or this is a stale request
      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) {
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const searchPayload = {
          anchor_id: Number(productId),
          limit: resultLimit,
          filters: {
            condition: conditionFilter
          }
        };

        const searchResult = await extensionAPI.search(searchPayload);

        // Check if this response is for the current request (ignore stale responses)
        if (!isMountedRef.current || currentRequestId !== requestIdRef.current) {
          return;
        }

        // The search API returns an array of ProductCard objects directly
        const products = Array.isArray(searchResult) ? searchResult : [];
        
        setLocalSimilarProducts(products);
        setHasMore(products.length >= resultLimit && products.length < 50);
        setLoading(false);
        isLoadingRef.current = false;
        
      } catch (error: any) {
        // Don't update state if this is a stale request or component unmounted
        if (!isMountedRef.current || currentRequestId !== requestIdRef.current) {
          return;
        }
        
        // Only set error if it's not an extension context error
        if (error?.message !== 'Extension context invalidated') {
          setError('Failed to load similar products');
        }
        setLoading(false);
        isLoadingRef.current = false;
      }
    };

    fetchSimilarProducts();

    // Cleanup function
    return () => {
      isMountedRef.current = false;
      isLoadingRef.current = false;
      // Increment request ID to invalidate any pending requests
      requestIdRef.current += 1;
    };
  }, [productId, productInfo, conditionFilter]);

  const conditionToggle = (
    <div className="flex space-x-2">
      <button
        className={`px-3 py-1 text-sm rounded-md border transition-colors ${
          conditionFilter === 'used'
            ? 'bg-electric text-white border-electric'
            : 'bg-background text-foreground border-border hover:border-electric'
        }`}
        onClick={() => setConditionFilter('used')}
        aria-pressed={conditionFilter === 'used'}
      >
        Second Hand
      </button>
      <button
        className={`px-3 py-1 text-sm rounded-md border transition-colors ${
          conditionFilter === 'new'
            ? 'bg-electric text-white border-electric'
            : 'bg-background text-foreground border-border hover:border-electric'
        }`}
        onClick={() => setConditionFilter('new')}
        aria-pressed={conditionFilter === 'new'}
      >
        New
      </button>
    </div>
  );

  const handleLoadMore = async () => {
    if (!productInfo || !productId || productId === null || productId === undefined || isNaN(Number(productId))) {
      return;
    }

    setLoadingMore(true);
    try {
      const currentCount = localSimilarProducts.length;
      const nextLimit = Math.min(currentCount + 10, 50);

      const searchPayload = {
        anchor_id: Number(productId),
        limit: nextLimit,
        filters: {
          condition: conditionFilter
        }
      };

      const searchResult = await extensionAPI.search(searchPayload);
      const products = Array.isArray(searchResult) ? searchResult : [];
      const newItems = products.slice(currentCount);
      const expectedDelta = nextLimit - currentCount;

      if (newItems.length > 0) {
        setLocalSimilarProducts((prev) => [...prev, ...newItems]);
      }

      // Track how many we have received to inform the button visibility
      setResultLimit(products.length);

      const reachedMax = products.length >= 50;
      const fullBatchReceived = newItems.length === expectedDelta;
      setHasMore(!reachedMax && fullBatchReceived);
      if (newItems.length === 0) {
        setHasMore(false);
      }
    } catch (error: any) {
      // Keep existing items; optionally surface a subtle error via console
      console.error('Failed to load more similar products', error);
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <div className="space-y-3">
            <CardTitle className="flex items-center space-x-2">
              <Sparkles className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
              <span>Similar Items</span>
            </CardTitle>
            {conditionToggle}
            <div className="flex justify-start">
              <Badge variant="outline" className="text-xs">Loading...</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-muted-foreground">Finding similar products...</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <div className="space-y-3">
            <CardTitle className="flex items-center space-x-2">
              <Sparkles className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
              <span>Similar Items</span>
            </CardTitle>
            {conditionToggle}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-red-500">{error}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (localSimilarProducts.length === 0 && !loading) {
    return (
      <Card>
        <CardHeader>
          <div className="space-y-3">
            <CardTitle className="flex items-center space-x-2">
              <Sparkles className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
              <span>Similar Items</span>
            </CardTitle>
            {conditionToggle}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-muted-foreground">No similar products found</div>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  // Use only real similar products data from passed props
  const lookalikes = localSimilarProducts.map((product, index) => {
    const price = product.best_offer?.price || 0;
    const originalPrice = product.best_offer?.original_price || product.best_offer?.price || 0;
    const currency = product.best_offer?.currency || 'USD';
    const baseCurrency = productInfo?.currency;
    
    // Convert prices if we have exchange rates and base currency
    let convertedPrice;
    let convertedOriginalPrice;
    
    if (exchangeRates && baseCurrency && currency !== baseCurrency) {
      convertedPrice = convertPrice(price, currency, baseCurrency);
      if (originalPrice !== price) {
        convertedOriginalPrice = convertPrice(originalPrice, currency, baseCurrency);
      }
    }
    
    return {
      id: product.product_id || index + 1,
      name: product.best_offer?.title || product.title || 'Unknown Product', // Use retailer-specific title, fallback to product title
      source: product.best_offer?.retailer || 'Unknown Store',
      price,
      originalPrice,
      converted_price: convertedPrice,
      converted_original_price: convertedOriginalPrice,
      base_currency: baseCurrency,
      condition: product.best_offer?.condition || 'Good',
      similarity: Math.round((product.similarity_score || 0.8) * 100),
      currency,
      tags: [], // Removed 'Similar' and 'AI Match' tags
      image: product.best_offer?.image_url || product.image_url || '/placeholder.svg', // Use retailer-specific image, fallback to product image
      url: product.best_offer?.url || '#'
    };
  });

  // Sort by similarity score (highest to lowest)
  lookalikes.sort((a, b) => b.similarity - a.similarity);

  return (
    <Card>
      <CardHeader>
        <div className="space-y-3">
          <CardTitle className="flex items-center space-x-2">
            <Sparkles className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
            <span>Similar Items</span>
          </CardTitle>
          {conditionToggle}
          {/* {localSimilarProducts.length > 0 && (
            <div className="flex justify-start">
              <Badge variant="secondary">{localSimilarProducts.length} alternatives found</Badge>
            </div>
          )} */}
        </div>
      </CardHeader>
      <CardContent className="overflow-visible">
        <div className="space-y-4 overflow-visible">
          {lookalikes.map((item) => (
            <div 
              key={item.id} 
              className="relative flex items-center space-x-4 p-3 border border-border rounded-lg hover:border-electric/50 transition-colors duration-200 group cursor-pointer hover:z-50"
              onClick={() => {
                if (item.url && item.url !== '#') {
                  window.open(item.url, '_blank');
                }
              }}
            >
              {/* Image */}
              <div className="relative z-10 w-20 h-20 bg-muted rounded-lg flex-shrink-0 overflow-hidden group-hover:overflow-visible group-hover:z-50">
                {item.image && item.image !== '/placeholder.svg' ? (
                  <img 
                    src={item.image} 
                    alt={item.name}
                    className="relative w-full h-full object-cover rounded-lg transition-transform duration-200 transform-gpu origin-left group-hover:scale-[3] group-hover:z-50 group-hover:shadow-2xl"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-full h-full bg-muted flex items-center justify-center">
                    <span className="text-xs text-muted-foreground">No image</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0 relative z-0">
                <div className="flex items-start justify-between w-full">
                  <div className="flex-1 min-w-0 pr-2">
                    <h3 className="font-medium text-foreground group-hover:text-electric transition-colors break-words">
                      {item.name}
                    </h3>
                    <p className="text-sm text-muted-foreground">{item.source}</p>
                    <div className="flex items-center space-x-2 mt-1">
                      <span className="text-xs text-muted-foreground">Condition:</span>
                      <Badge variant="outline" className="text-xs">{item.condition}</Badge>
                      {/* <span className="text-xs text-mint font-medium">{item.similarity}% match</span> */}
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0 min-w-0">
                    <div className="flex flex-col items-end">
                      {(() => {
                        const priceFormat = formatPriceWithConversion(
                          item.price, 
                          item.currency || 'USD', 
                          item.converted_price, 
                          item.base_currency
                        );
                        return (
                          <>
                            <span className="text-lg font-bold text-foreground">
                              {priceFormat.main}
                            </span>
                            {priceFormat.hasConversion && priceFormat.secondary && (
                              <span className="text-xs text-muted-foreground">
                                {priceFormat.secondary}
                              </span>
                            )}
                          </>
                        );
                      })()}
                      {item.originalPrice && item.originalPrice !== item.price && (() => {
                        const originalPriceFormat = formatPriceWithConversion(
                          item.originalPrice, 
                          item.currency || 'USD', 
                          item.converted_original_price, 
                          item.base_currency
                        );
                        return (
                          <>
                            <span className="text-xs text-muted-foreground line-through">
                              {originalPriceFormat.main}
                            </span>
                            {originalPriceFormat.hasConversion && originalPriceFormat.secondary && (
                              <span className="text-xs text-muted-foreground line-through opacity-75">
                                {originalPriceFormat.secondary}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Tags section removed - no tags to display */}
              </div>
            </div>
          ))}
        </div>
        {hasMore && localSimilarProducts.length < 50 && (
          <div className="mt-4 flex justify-center">
            <button
              className="px-4 py-2 text-sm rounded-md border border-border hover:border-electric transition-colors disabled:opacity-60"
              onClick={handleLoadMore}
              disabled={loading || loadingMore}
            >
              {loadingMore ? 'Loading...' : 'Show more'}
            </button>
          </div>
        )}
        {!hasMore && localSimilarProducts.length > 0 && (
          <div className="mt-4 flex justify-center text-sm text-muted-foreground">
            Sorry we couldn't find any more similar items
          </div>
        )}

        {/* Removed AI Recommendations card */}
      </CardContent>
    </Card>
  );
};

export default AiLookalikes;