import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  kit: {
    adapter: adapter({
      precompress: true,
    }),
    typescript: {
      config: (generatedConfig) => {
        // SvelteKit が生成する tsconfig を共有ベース設定に紐付ける
        return {
          ...generatedConfig,
          extends: "../tsconfig.app.json",
        };
      },
    },
  },
  preprocess: [vitePreprocess()],
};

export default config;
