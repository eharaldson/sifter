import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import WebApp from "./pages/WebApp";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";
import { AuthProvider } from "./hooks/useAuth";
import DebugTest from "./components/DebugTest";

console.log("📦 App.tsx imports loaded");

const queryClient = new QueryClient();
console.log("🔧 QueryClient created");

const AppWithTheme = () => {
  console.log("🎨 AppWithTheme component rendering");
  const location = useLocation();
  console.log("📍 Current location:", location.pathname);
  const isAppRoute = location.pathname === "/webapp" || location.pathname === "/auth";
  
  return (
    <ThemeProvider 
      attribute="class" 
      defaultTheme="system" 
      enableSystem={true}
    >
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <Routes>
            <Route path="/" element={<WebApp />} />
            <Route path="/webapp" element={<WebApp />} />
            <Route path="/auth" element={<Auth />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};

const App = () => {
  console.log("🚀 App component rendering");
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppWithTheme />
      </BrowserRouter>
    </QueryClientProvider>
  );
};

export default App;
