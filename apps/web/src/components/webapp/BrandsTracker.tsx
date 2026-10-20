import { useState } from "react";
import { Plus, Bell, Star, ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Brand {
  id: string;
  name: string;
  logo: string;
  category: string;
  following: boolean;
  updates: number;
  lastUpdate: string;
  website: string;
}

const BrandsTracker = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [brands] = useState<Brand[]>([
    {
      id: "1",
      name: "Nike",
      logo: "🏃",
      category: "Sports & Fitness",
      following: true,
      updates: 3,
      lastUpdate: "2 hours ago",
      website: "nike.com"
    },
    {
      id: "2",
      name: "Apple",
      logo: "🍎",
      category: "Technology",
      following: true,
      updates: 1,
      lastUpdate: "1 day ago",
      website: "apple.com"
    },
    {
      id: "3",
      name: "Zara",
      logo: "👗",
      category: "Fashion",
      following: false,
      updates: 5,
      lastUpdate: "3 hours ago",
      website: "zara.com"
    },
    {
      id: "4",
      name: "Samsung",
      logo: "📱",
      category: "Technology",
      following: true,
      updates: 2,
      lastUpdate: "5 hours ago",
      website: "samsung.com"
    },
    {
      id: "5",
      name: "Adidas",
      logo: "👟",
      category: "Sports & Fitness",
      following: false,
      updates: 4,
      lastUpdate: "1 day ago",
      website: "adidas.com"
    }
  ]);

  const filteredBrands = brands.filter(brand =>
    brand.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    brand.category.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const followingBrands = brands.filter(brand => brand.following);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-foreground">Brand Updates</h2>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Add Brand
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search brands or categories..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Following Brands Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Star className="h-5 w-5 mr-2 text-mint" />
            Following ({followingBrands.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground mb-4">
            You're following {followingBrands.length} brands with {followingBrands.reduce((sum, brand) => sum + brand.updates, 0)} total updates
          </div>
          <div className="flex flex-wrap gap-2">
            {followingBrands.map((brand) => (
              <Badge key={brand.id} variant="secondary" className="flex items-center gap-1">
                <span>{brand.logo}</span>
                {brand.name}
                {brand.updates > 0 && (
                  <span className="bg-mint text-white rounded-full px-1 text-xs">
                    {brand.updates}
                  </span>
                )}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Brand List */}
      <div className="grid gap-4">
        {filteredBrands.map((brand) => (
          <Card key={brand.id}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="text-3xl">{brand.logo}</div>
                  <div>
                    <h3 className="font-semibold text-foreground">{brand.name}</h3>
                    <p className="text-sm text-muted-foreground">{brand.category}</p>
                    <p className="text-xs text-muted-foreground">Last update: {brand.lastUpdate}</p>
                  </div>
                </div>
                
                <div className="flex items-center space-x-3">
                  {brand.updates > 0 && (
                    <div className="flex items-center space-x-1">
                      <Bell className="h-4 w-4 text-mint" />
                      <span className="text-sm font-medium text-mint">{brand.updates} updates</span>
                    </div>
                  )}
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(`https://${brand.website}`, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                  
                  <Button
                    variant={brand.following ? "secondary" : "outline"}
                    size="sm"
                  >
                    {brand.following ? "Following" : "Follow"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredBrands.length === 0 && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No brands found matching your search.</p>
        </div>
      )}
    </div>
  );
};

export default BrandsTracker;