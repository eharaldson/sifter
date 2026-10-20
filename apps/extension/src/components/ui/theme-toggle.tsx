import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ThemeToggleProps {
  onThemeChange?: (isDark: boolean) => void;
}

export function ThemeToggle({ onThemeChange }: ThemeToggleProps) {
  const [isDark, setIsDark] = useState(false);

  const toggleTheme = () => {
    const newTheme = !isDark;
    setIsDark(newTheme);
    // Call the callback if provided
    if (onThemeChange) {
      onThemeChange(newTheme);
    }
    // In a browser extension, we could store theme preference in chrome.storage
    // For now, this is a simple toggle without persistence
  };

  return (
    <Button variant="ghost" size="sm" onClick={toggleTheme}>
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}