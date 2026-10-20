import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, Calendar, ShoppingBag, Target, ExternalLink } from "lucide-react";

const SavingsTracker = () => {
  const savingsData = {
    totalSaved: 2540.80,
    itemsTracked: 47,
    averageSaving: 54.06,
    thisMonth: 312.45
  };

  const recentSavings = [
    {
      id: 1,
      item: "Black Leather Jacket",
      brand: "AllSaints",
      originalPrice: 129.99,
      paidPrice: 89.99,
      saved: 40.00,
      date: "2024-01-15",
      store: "ASOS"
    },
    {
      id: 2,
      item: "White Sneakers",
      brand: "Nike",
      originalPrice: 85.00,
      paidPrice: 67.50,
      saved: 17.50,
      date: "2024-01-12",
      store: "Size?"
    },
    {
      id: 3,
      item: "Denim Jeans",
      brand: "Levi's",
      originalPrice: 95.00,
      paidPrice: 72.00,
      saved: 23.00,
      date: "2024-01-10",
      store: "John Lewis"
    },
    {
      id: 4,
      item: "Wool Scarf",
      brand: "COS",
      originalPrice: 49.00,
      paidPrice: 31.50,
      saved: 17.50,
      date: "2024-01-08",
      store: "COS Outlet"
    }
  ];

  const monthlyData = [
    { month: "Sep", saved: 156.20 },
    { month: "Oct", saved: 234.80 },
    { month: "Nov", saved: 298.45 },
    { month: "Dec", saved: 412.30 },
    { month: "Jan", saved: 312.45 }
  ];

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <TrendingUp className="w-5 h-5 text-mint" />
              <span className="text-sm font-medium text-muted-foreground">Total Saved</span>
            </div>
            <div className="text-2xl font-bold text-mint mt-1">£{savingsData.totalSaved.toFixed(2)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <ShoppingBag className="w-5 h-5 text-electric" />
              <span className="text-sm font-medium text-muted-foreground">Items Tracked</span>
            </div>
            <div className="text-2xl font-bold text-electric mt-1">{savingsData.itemsTracked}</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Target className="w-5 h-5 text-coral" />
              <span className="text-sm font-medium text-muted-foreground">Avg. Saving</span>
            </div>
            <div className="text-2xl font-bold text-coral mt-1">£{savingsData.averageSaving.toFixed(2)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Calendar className="w-5 h-5 text-secondary-dark" />
              <span className="text-sm font-medium text-muted-foreground">This Month</span>
            </div>
            <div className="text-2xl font-bold text-secondary-dark mt-1">£{savingsData.thisMonth.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Savings Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Monthly Savings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {monthlyData.map((data, index) => (
                <div key={index} className="flex items-center space-x-4">
                  <div className="w-12 text-sm text-muted-foreground">{data.month}</div>
                  <div className="flex-1">
                    <div className="bg-muted rounded-full h-2 relative overflow-hidden">
                      <div 
                        className="bg-mint h-full rounded-full transition-all duration-500"
                        style={{ width: `${(data.saved / 450) * 100}%` }}
                      ></div>
                    </div>
                  </div>
                  <div className="text-sm font-medium text-mint">£{data.saved.toFixed(2)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Savings */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Savings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentSavings.map((saving) => (
                <div key={saving.id} className="border border-border rounded-lg p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-medium text-foreground">{saving.item}</h3>
                      <p className="text-sm text-muted-foreground">{saving.brand} • {saving.store}</p>
                      <div className="flex items-center space-x-2 mt-1">
                        <span className="text-xs text-muted-foreground">Paid:</span>
                        <span className="text-sm font-medium">£{saving.paidPrice.toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground line-through">£{saving.originalPrice.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge className="bg-mint text-white">
                        -£{saving.saved.toFixed(2)}
                      </Badge>
                      <div className="text-xs text-muted-foreground mt-1">{saving.date}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <Button variant="outline" className="w-full mt-4">
              View All Savings
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Savings Goals */}
      <Card>
        <CardHeader>
          <CardTitle>Savings Goals</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Monthly Goal: £500</span>
                  <span className="text-sm text-muted-foreground">62%</span>
                </div>
                <div className="bg-muted rounded-full h-2">
                  <div className="bg-electric h-full rounded-full w-[62%]"></div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">£312.45 of £500</p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Yearly Goal: £3,000</span>
                  <span className="text-sm text-muted-foreground">85%</span>
                </div>
                <div className="bg-muted rounded-full h-2">
                  <div className="bg-mint h-full rounded-full w-[85%]"></div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">£2,540.80 of £3,000</p>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="font-medium text-foreground">Achievement Badges</h4>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary" className="bg-mint/10 text-mint border-mint/20">
                  First £100 Saved
                </Badge>
                <Badge variant="secondary" className="bg-electric/10 text-electric border-electric/20">
                  Deal Hunter
                </Badge>
                <Badge variant="secondary" className="bg-coral/10 text-coral border-coral/20">
                  Consistent Saver
                </Badge>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SavingsTracker;