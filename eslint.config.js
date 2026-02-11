// eslint.config.js
import js from "@eslint/js";
import tsplugin from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import path from "node:path";
import { fileURLToPath } from "node:url";
import globals from "globals";
import sveltePlugin from "eslint-plugin-svelte";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  // 無視パターン
  {
    ignores: ["node_modules", "dist", "build", "coverage", "**/.svelte-kit/**", "**/build/**"],
  },

  // JS の推奨
  js.configs.recommended,

  // TS 用（型情報あり）
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        allowDefaultProject: true,
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        NodeJS: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsplugin },
    rules: {
      // plugin の recommended を取り込む
      ...tsplugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off", // ここはお好みで
    },
  },
  {
    files: [
      "apps/browser/vite.config.ts",
      "apps/browser/vitest.config.ts",
      "apps/browser/svelte.config.js",
    ],
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: false,
        tsconfigRootDir: __dirname,
      },
    },
  },

  ...(() => {
    const base = sveltePlugin.configs["flat/recommended"];
    if (!Array.isArray(base)) {
      throw new Error("eslint-plugin-svelte flat/recommended config is not an array");
    }
    return base.map((config) => {
      if (!config.files) {
        return config;
      }
      const languageOptions = config.languageOptions ?? {};
      const parserOptions = languageOptions.parserOptions ?? {};
      return {
        ...config,
        languageOptions: {
          ...languageOptions,
          parserOptions: {
            ...parserOptions,
            tsconfigRootDir: __dirname,
            parser: {
              ...(typeof parserOptions.parser === "object" ? parserOptions.parser : {}),
              ts: tsparser,
            },
          },
          globals: {
            ...(languageOptions.globals ?? {}),
            ...globals.browser,
          },
        },
      };
    });
  })(),
  {
    files: ["**/*.svelte"],
    rules: {
      "svelte/no-navigation-without-resolve": "off",
      "svelte/no-at-html-tags": "off",
      "svelte/prefer-svelte-reactivity": "off",
      "svelte/require-each-key": "off",
    },
  },

  // Prettier と競合するルールを無効化
  prettier,
];
