import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign } from "lucide-react";
import { ICON_SIZES, PRODUCT_THUMBNAIL_SIZE } from "@/constants/dimensions";
import { extensionAPI } from "@/api-messaging";

interface PriceComparisonProps {
  productId?: number | null;
  productInfo?: any; // Add product info to get the base currency
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

const PriceComparison = ({ productId, productInfo }: PriceComparisonProps) => {
  const [offers, setOffers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (productId) {
      fetchOffers();
    }
  }, [productId]);

  const fetchOffers = async () => {
    if (!productId) {
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await extensionAPI.offers({
        productId,
        params: {
          base_currency: productInfo?.currency, // Pass the current product's currency as base currency
          in_stock_only: true
        }
      });
      
      // The offers endpoint now returns a single ProductOffer or null
      const offersArray = response ? [response] : [];
      
      setOffers(offersArray);
    } catch (err) {
      setError('Failed to load other options');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <DollarSign className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
            <span>Where to Buy</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-muted-foreground">Loading other options...</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <DollarSign className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
            <span>Where to Buy</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-red-500">{error}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!productId || offers.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <DollarSign className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
            <span>Where to Buy</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-muted-foreground">No other options available</div>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  // Flatten all offers from the product into individual cards
  const priceComparisons: any[] = [];
  
  offers.forEach((product, _) => {
    
    product.offers.forEach((offer: any, offerIndex: number) => {
      
      const mapped = {
        id: `${product.product_id}-${offerIndex}`,
        name: offer.title || product.title, // Use retailer-specific title, fallback to product title
        source: offer.retailer,
        price: offer.price,
        originalPrice: offer.original_price || null,
        currency: offer.currency,
        converted_price: offer.converted_price,
        converted_original_price: offer.converted_original_price,
        base_currency: offer.base_currency,
        conversion_rate: offer.conversion_rate,
        condition: offer.condition,
        url: offer.url,
        image: offer.image_url || product.image_url || null // Use retailer-specific image, fallback to product image
      };

      priceComparisons.push(mapped);
    });
  });

  // Sort by price (lowest to highest) - use converted price if available, otherwise original price
  priceComparisons.sort((a, b) => {
    const priceA = a.converted_price || a.price;
    const priceB = b.converted_price || b.price;
    return priceA - priceB;
  });

  return (
    <Card>
      <CardHeader>
        <div className="space-y-2">
          <CardTitle className="flex items-center space-x-2">
            <DollarSign className={`${ICON_SIZES.LARGE.tailwind} text-electric`} />
            <span>Where to Buy</span>
          </CardTitle>
          {priceComparisons.length > 0 && (
            <div className="flex justify-start">
              <Badge variant="secondary">{priceComparisons.length} offers found</Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {priceComparisons.map((item) => (
            <div 
              key={item.id} 
              className="flex items-center space-x-4 p-3 border border-border rounded-lg hover:border-electric/50 transition-all group cursor-pointer"
              onClick={() => {
                if (item.url && item.url !== '#') {
                  window.open(item.url, '_blank');
                }
              }}
            >
              {/* Image */}
              <div className={`${PRODUCT_THUMBNAIL_SIZE.tailwind} bg-muted rounded-lg flex-shrink-0 overflow-hidden`}>
                {item.image && item.image !== '/placeholder.svg' ? (
                  <img 
                    src={item.image} 
                    alt={item.name}
                    className="w-full h-full object-cover"
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
              <div className="flex-1 min-w-0 relative">
                <div className="flex items-start justify-between w-full">
                  <div className="flex-1 min-w-0 pr-2">
                    <h3 className="font-medium text-foreground group-hover:text-electric transition-colors break-words">
                      {item.name}
                    </h3>
                    <p className="text-sm text-muted-foreground">{item.source}</p>
                    <div className="flex items-center space-x-2 mt-1">
                      <span className="text-xs text-muted-foreground">Condition:</span>
                      <Badge variant="outline" className="text-xs">{item.condition}</Badge>
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
                            <span className="text-lg font-bold text-foreground whitespace-nowrap">
                              {priceFormat.main}
                            </span>
                            {priceFormat.hasConversion && priceFormat.secondary && (
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
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
                            <span className="text-xs text-muted-foreground line-through whitespace-nowrap">
                              {originalPriceFormat.main}
                            </span>
                            {originalPriceFormat.hasConversion && originalPriceFormat.secondary && (
                              <span className="text-xs text-muted-foreground line-through whitespace-nowrap opacity-75">
                                {originalPriceFormat.secondary}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

export default PriceComparison;