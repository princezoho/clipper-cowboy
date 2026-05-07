/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0a0a0c",
          900: "#111114",
          800: "#1a1a1f",
          700: "#26262d",
          600: "#3a3a44",
          500: "#5a5a66",
          400: "#8a8a96",
          300: "#b8b8c2",
          200: "#dcdce4",
          100: "#f0f0f4",
        },
        accent: {
          500: "#ff5722",
          400: "#ff7a4d",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
