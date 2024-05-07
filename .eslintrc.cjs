module.exports = {
  ignorePatterns: [
    "dist",
    "build",
    "docs",
    "*.md"
  ],
  settings: {
    "import/parsers": {
      "@typescript-eslint/parser": [".ts", ".tsx"]
    },
    "import/resolver": {
      typescript: {
        alwaysTryTypes: true
      }
    }
  },
  parserOptions: {
    "ecmaVersion": 2018,
    "sourceType": "module",
    "tsconfigRootDir": __dirname,
    "project": [__dirname + '/tsconfig.json', __dirname + '/tsconfig.src.json', __dirname + '/tsconfig.test.json'],
  },
  extends: ["love", "plugin:@effect/recommended"],
  plugins: ["import"],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-redeclare": "off",
    "no-void": "off",
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
  },
}