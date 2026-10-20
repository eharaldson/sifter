import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Bell, TrendingDown, ExternalLink, Trash2, Plus } from "lucide-react";

const PriceAlerts = () => {
  const [alerts, setAlerts] = useState([
    {
      id: 1,
      item: "MacBook Pro 14-inch",
      brand: "Apple",
      currentPrice: 1899.00,
      targetPrice: 1699.00,
      lowestPrice: 1799.00,
      priceHistory: "£1899 → £1849 → £1899",
      active: true,
      stores: ["Apple Store", "John Lewis", "Currys"],
      lastChecked: "2 hours ago",
      created: "2024-01-10"
    },
    {
      id: 2,
      item: "Nike Air Max 90",
      brand: "Nike",
      currentPrice: 89.99,
      targetPrice: 75.00,
      lowestPrice: 79.99,
      priceHistory: "£94.99 → £89.99",
      active: true,
      stores: ["Nike", "Size?", "JD Sports"],
      lastChecked: "1 hour ago",
      created: "2024-01-08"
    },
    {
      id: 3,
      item: "Leather Sofa 3-Seater",
      brand: "IKEA",
      currentPrice: 449.00,
      targetPrice: 399.00,
      lowestPrice: 429.00,
      priceHistory: "£479 → £449",
      active: false,
      stores: ["IKEA", "Wayfair"],
      lastChecked: "6 hours ago",
      created: "2024-01-05"
    }
  ]);

  const recentDrops = [
    {
      id: 1,
      item: "Wireless Headphones",
      brand: "Sony",
      oldPrice: 129.99,
      newPrice: 99.99,
      discount: 23,
      store: "Amazon",
      timeAgo: "3 hours ago"
    },
    {
      id: 2,
      item: "Coffee Machine",
      brand: "Nespresso",
      oldPrice: 199.00,
      newPrice: 159.00,
      discount: 20,
      store: "John Lewis",
      timeAgo: "1 day ago"
    }
  ];

  const toggleAlert = (id: number) => {
    setAlerts(alerts.map(alert => 
      alert.id === id ? { ...alert, active: !alert.active } : alert
    ));
  };

  const deleteAlert = (id: number) => {
    setAlerts(alerts.filter(alert => alert.id !== id));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">Price Alerts</h1>
          <p className="text-muted-foreground">Get notified when items drop to your target price</p>
        </div>
        <Button>
          <Plus className="w-4 h-4 mr-2" />
          Create Alert
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Bell className="w-5 h-5 text-electric" />
              <span className="text-sm font-medium text-muted-foreground">Active Alerts</span>
            </div>
            <div className="text-2xl font-bold text-electric mt-1">
              {alerts.filter(alert => alert.active).length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <TrendingDown className="w-5 h-5 text-mint" />
              <span className="text-sm font-medium text-muted-foreground">Price Drops</span>
            </div>
            <div className="text-2xl font-bold text-mint mt-1">12</div>
            <div className="text-xs text-muted-foreground">This week</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <span className="text-sm font-medium text-muted-foreground">Potential Savings</span>
            </div>
            <div className="text-2xl font-bold text-coral mt-1">£249</div>
            <div className="text-xs text-muted-foreground">If all targets hit</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Active Alerts */}
        <Card>
          <CardHeader>
            <CardTitle>Your Price Alerts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {alerts.map((alert) => (
                <div key={alert.id} className="border border-border rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                      <h3 className="font-medium text-foreground">{alert.item}</h3>
                      <p className="text-sm text-muted-foreground">{alert.brand}</p>
                      <div className="flex items-center space-x-2 mt-1">
                        <span className="text-xs text-muted-foreground">Watching:</span>
                        {alert.stores.slice(0, 2).map((store, index) => (
                          <Badge key={index} variant="outline" className="text-xs">
                            {store}
                          </Badge>
                        ))}
                        {alert.stores.length > 2 && (
                          <span className="text-xs text-muted-foreground">+{alert.stores.length - 2} more</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Switch
                        checked={alert.active}
                        onCheckedChange={() => toggleAlert(alert.id)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteAlert(alert.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Current:</span>
                      <div className="font-semibold">£{alert.currentPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Target:</span>
                      <div className="font-semibold text-mint">£{alert.targetPrice.toFixed(2)}</div>
                    </div>
                  </div>

                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Last checked: {alert.lastChecked}</span>
                      <span>Lowest seen: £{alert.lowestPrice.toFixed(2)}</span>
                    </div>
                  </div>

                  {alert.currentPrice <= alert.targetPrice && (
                    <div className="mt-2 p-2 bg-mint/10 rounded border border-mint/20">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-mint">Target price reached!</span>
                        <Button size="sm" variant="outline">
                          <ExternalLink className="w-3 h-3 mr-1" />
                          Buy Now
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Price Drops */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Price Drops</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentDrops.map((drop) => (
                <div key={drop.id} className="flex items-center space-x-4 p-3 bg-mint/5 rounded-lg border border-mint/10">
                  <div className="w-12 h-12 bg-muted rounded-lg flex-shrink-0"></div>
                  <div className="flex-1">
                    <h3 className="font-medium text-foreground">{drop.item}</h3>
                    <p className="text-sm text-muted-foreground">{drop.brand} • {drop.store}</p>
                    <div className="flex items-center space-x-2 mt-1">
                      <span className="text-sm font-semibold text-mint">£{drop.newPrice.toFixed(2)}</span>
                      <span className="text-sm text-muted-foreground line-through">£{drop.oldPrice.toFixed(2)}</span>
                      <Badge className="bg-mint text-white text-xs">
                        -{drop.discount}%
                      </Badge>
                    </div>
                  </div>
                  <div className="text-right">
                    <Button size="sm" variant="outline">
                      <ExternalLink className="w-3 h-3" />
                    </Button>
                    <div className="text-xs text-muted-foreground mt-1">{drop.timeAgo}</div>
                  </div>
                </div>
              ))}
            </div>

            <Button variant="outline" className="w-full mt-4">
              View All Price Drops
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default PriceAlerts;