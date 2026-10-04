import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'web/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettier,
	{
		// The plain-Node scripts: the globals Node gives them, named rather than pulled in as a package.
		files: ['scripts/**/*.mjs', 'bin/**/*.mjs'],
		languageOptions: { globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly', URL: 'readonly' } }
	},
	{
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off'
		}
	}
);
