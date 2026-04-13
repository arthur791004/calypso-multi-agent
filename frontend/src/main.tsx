import React from "react";
import ReactDOM from "react-dom/client";
import { ChakraProvider, createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";
import { ThemeProvider } from "next-themes";
import { App } from "./App";
import { Toaster } from "./Toaster";
import "./styles.css";

const system = createSystem(
  defaultConfig,
  defineConfig({
    globalCss: {
      "html, body, #root": { height: "100%", margin: 0, overflow: "hidden" },
      body: { bg: "gray.900", color: "gray.100" },
    },
  })
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChakraProvider value={system}>
      <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" enableSystem={false}>
        <App />
        <Toaster />
      </ThemeProvider>
    </ChakraProvider>
  </React.StrictMode>
);
