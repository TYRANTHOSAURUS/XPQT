/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleNameMapper: {
    // @react-pdf/renderer ships ESM-only and Jest's default CJS transform
    // pipeline can't load it. Map to a no-op stub at test time; the real
    // module loads in the prod path. See src/__mocks__/react-pdf-renderer.js.
    '^@react-pdf/renderer$': '<rootDir>/__mocks__/react-pdf-renderer.js',
  },
};
