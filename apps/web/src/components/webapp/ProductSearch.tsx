import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, Star, TrendingUp, AlertCircle, RefreshCw } from "lucide-react";
import { apiClient } from "@/services/api";
import type { SimilarSearchResponse } from "@find/types";

interface ProductSearchProps {
  searchQuery: string;
}

const ProductSearch = ({ searchQuery }: ProductSearchProps) => {
  const [results, setResults] = useState<SimilarSearchResponse['results']>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchProducts = async (query: string) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      console.log('🔍 Searching products for query:', query);
      const response = await apiClient.searchSimilar({
        text_query: query,
        limit: 12,
        filters: {}
      });

      console.log('✅ Search response:', response);
      setResults(response.results || []);
    } catch (err) {
      console.error('❌ Failed to search products:', err);
      setError(err instanceof Error ? err.message : 'Failed to search products');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      searchProducts(searchQuery);
    }, 300); // Debounce search

    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2 text-destructive">
            <AlertCircle className="w-5 h-5" />
            <span>Search Error</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">{error}</p>
          <Button 
            onClick={() => searchProducts(searchQuery)} 
            variant="outline" 
            size="sm"
            className="flex items-center space-x-2"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Retry Search</span>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Searching...</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="h-48 w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (results.length === 0 && searchQuery) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Results Found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            No products found for "{searchQuery}". Try a different search term.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (results.length === 0 && !searchQuery) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Search Products</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Start typing to search for products across thousands of stores...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Search Results
          <Badge variant="secondary">{results.length} products found</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {results.map((product) => (
            <div key={product.product_id} className="group border border-border rounded-lg p-4 hover:shadow-lg transition-all">
              {/* Product Image */}
              <div className="relative mb-4">
                {product.images && product.images.length > 0 ? (
                  <img 
                    src={product.images[0]} 
                    alt={product.title}
                    className="aspect-square w-full object-cover rounded-lg"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      e.currentTarget.nextElementSibling?.classList.remove('hidden');
                    }}
                  />
                ) : null}
                <div className="aspect-square bg-muted rounded-lg flex items-center justify-center text-muted-foreground">
                  No Image
                </div>
                {product.similarity_score > 0.8 && (
                  <Badge className="absolute top-2 left-2 bg-electric text-white">
                    <TrendingUp className="w-3 h-3 mr-1" />
                    High Match
                  </Badge>
                )}
              </div>

              {/* Product Info */}
              <div className="space-y-2">
                <h3 className="font-semibold text-foreground group-hover:text-electric transition-colors line-clamp-2">
                  {product.title}
                </h3>
                {product.brand && (
                  <p className="text-sm text-muted-foreground">{product.brand}</p>
                )}
                
                {/* Similarity Score */}
                <div className="flex items-center space-x-1">
                  <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                  <span className="text-sm font-medium">
                    {Math.round(product.similarity_score * 100)}% match
                  </span>
                </div>

                {/* Price */}
                {product.best_offer && (
                  <div className="flex items-center space-x-2">
                    <span className="text-lg font-bold text-foreground">
                      £{product.best_offer.price.toFixed(2)}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {product.best_offer.retailer}
                    </Badge>
                  </div>
                )}

                {/* Description */}
                {product.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {product.description}
                  </p>
                )}

                {/* Action Buttons */}
                <div className="flex space-x-2 pt-2">
                  <Button size="sm" className="flex-1">
                    Compare Prices
                  </Button>
                  <Button size="sm" variant="outline">
                    <ExternalLink className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

export default ProductSearch;