import love from "eslint-config-love"
import effectPlugin from "@effect/eslint-plugin"

export default [
  {
    ignores: ["dist/**", "build/**", "docs/**", "**/*.md"]
  },
  love,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: ["./tsconfig.json", "./tsconfig.src.json", "./tsconfig.test.json"]
      }
    },
    plugins: {
      "@effect": effectPlugin
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-redeclare": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/prefer-function-type": "off",
      "no-void": "off",
      "max-nested-callbacks": "off",
      "@effect/dprint": [
        "error",
        {
          config: {
            indentWidth: 2,
            lineWidth: 120,
            semiColons: "asi",
            quoteStyle: "alwaysDouble",
            trailingCommas: "never",
            operatorPosition: "maintain",
            "arrowFunction.useParentheses": "force"
          }
        }
      ]
    }
  }
]