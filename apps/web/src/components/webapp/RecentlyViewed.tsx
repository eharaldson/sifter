import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, ExternalLink, Heart, TrendingDown, RefreshCw } from "lucide-react";
import { apiClient } from "@/services/api";
import type { SimilarSearchResponse } from "@find/types";

const RecentlyViewed = () => {
  const [recentItems, setRecentItems] = useState<SimilarSearchResponse['results']>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState("All");

  const fetchRecentItems = async () => {
    setIsLoading(true);
    setError(null);

    try {
      console.log('🔍 Fetching trending products for recently viewed...');
      
      // Fetch popular fashion items to simulate recently viewed products
      const queries = [
        "black leather jacket",
        "white sneakers", 
        "wool coat",
        "denim jeans",
        "silk blouse",
        "ankle boots"
      ];

      const allResults: SimilarSearchResponse['results'] = [];
      
      // Fetch a few items from each query to create variety
      for (const query of queries.slice(0, 3)) {
        try {
          const response = await apiClient.searchSimilar({
            text_query: query,
            limit: 2,
            filters: {}
          });
          if (response.results) {
            allResults.push(...response.results);
          }
        } catch (err) {
          console.warn(`Failed to fetch for query "${query}":`, err);
        }
      }

      console.log('✅ Fetched recent items:', allResults.length);
      setRecentItems(allResults);
    } catch (err) {
      console.error('❌ Failed to fetch recent items:', err);
      setError(err instanceof Error ? err.message : 'Failed to load recent items');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecentItems();
  }, []);

  const categories = [
    { name: "All", count: recentItems.length, active: activeCategory === "All" },
    { name: "Clothing", count: recentItems.filter(item => 
      item.title.toLowerCase().includes('jacket') || 
      item.title.toLowerCase().includes('coat') || 
      item.title.toLowerCase().includes('jeans') ||
      item.title.toLowerCase().includes('blouse')
    ).length, active: activeCategory === "Clothing" },
    { name: "Shoes", count: recentItems.filter(item => 
      item.title.toLowerCase().includes('sneakers') || 
      item.title.toLowerCase().includes('boots') ||
      item.title.toLowerCase().includes('shoes')
    ).length, active: activeCategory === "Shoes" },
    { name: "Accessories", count: 0, active: activeCategory === "Accessories" }
  ];

  const filteredItems = activeCategory === "All" ? recentItems : 
    recentItems.filter(item => {
      const title = item.title.toLowerCase();
      switch (activeCategory) {
        case "Clothing":
          return title.includes('jacket') || title.includes('coat') || 
                 title.includes('jeans') || title.includes('blouse');
        case "Shoes":
          return title.includes('sneakers') || title.includes('boots') || 
                 title.includes('shoes');
        case "Accessories":
          return false; // No accessories in current data
        default:
          return true;
      }
    });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Recently Viewed</h1>
        <p className="text-muted-foreground">Items you've looked at recently with updated prices</p>
      </div>

      {/* Categories */}
      <div className="flex space-x-2">
        {categories.map((category) => (
          <Button
            key={category.name}
            variant={category.active ? "secondary" : "outline"}
            size="sm"
            onClick={() => setActiveCategory(category.name)}
          >
            {category.name} ({category.count})
          </Button>
        ))}
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="group hover:shadow-lg transition-all">
              <CardContent className="p-4">
                <div className="space-y-3">
                  <Skeleton className="aspect-square w-full rounded-lg" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-8 w-full" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button onClick={fetchRecentItems} variant="outline" size="sm">
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Items Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredItems.map((item) => (
            <Card key={item.product_id} className="group hover:shadow-lg transition-all">
              <CardContent className="p-4">
                <div className="relative mb-4">
                  {item.images && item.images.length > 0 ? (
                    <img 
                      src={item.images[0]} 
                      alt={item.title}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2 bg-white/80 backdrop-blur-sm"
                  >
                    <Heart className="w-3 h-3" />
                  </Button>
                  {item.similarity_score > 0.8 && (
                    <Badge className="absolute bottom-2 left-2 bg-mint text-white">
                      <TrendingDown className="w-3 h-3 mr-1" />
                      High Match
                    </Badge>
                  )}
                </div>

                <div className="space-y-2">
                  <h3 className="font-medium text-foreground group-hover:text-electric transition-colors line-clamp-2">
                    {item.title}
                  </h3>
                  {item.brand && (
                    <p className="text-sm text-muted-foreground">{item.brand}</p>
                  )}
                  
                  {item.best_offer && (
                    <div className="flex items-center space-x-2">
                      <span className="text-lg font-bold text-foreground">
                        £{item.best_offer.price.toFixed(2)}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {item.best_offer.retailer}
                      </Badge>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center space-x-1">
                      <Clock className="w-3 h-3" />
                      <span>Recently viewed</span>
                    </div>
                    <span>{Math.round(item.similarity_score * 100)}% match</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="text-xs border-mint text-mint">
                      Available
                    </Badge>
                  </div>

                  <div className="flex space-x-2 pt-2">
                    <Button size="sm" className="flex-1">
                      Compare Prices
                    </Button>
                    <Button size="sm" variant="outline">
                      <ExternalLink className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredItems.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-muted-foreground">No items found in this category.</p>
          </CardContent>
        </Card>
      )}

      {/* Load More */}
      {!isLoading && !error && filteredItems.length > 0 && (
        <div className="text-center">
          <Button variant="outline" onClick={fetchRecentItems}>
            Load More Items
          </Button>
        </div>
      )}
    </div>
  );
};

export default RecentlyViewed;