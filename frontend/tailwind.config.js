/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#1e1f22",
        panel: "#2b2d31",
        panel2: "#313338",
        accent: "#5865f2",
        text: "#dcddde",
        muted: "#949ba4",
      },
    },
  },
  plugins: [],
};
