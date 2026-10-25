import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', '.next/**', 'next-env.d.ts', 'node_modules/**', '.pnpm-store/**'] },
  ...tseslint.configs.recommended,
);
