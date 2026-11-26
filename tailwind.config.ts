import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#171916",
        paper: "#f6f5f0",
        moss: "#d9e7d6",
        lime: "#c7f36b",
        muted: "#777b73",
      },
      boxShadow: {
        card: "0 24px 80px rgba(27, 35, 26, 0.08)",
      },
      fontFamily: {
        sans: ["Arial", "Helvetica", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
