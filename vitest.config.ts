import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // O boot do processo (listen + handlers de sinal) e verificado rodando o
      // servidor de verdade, nao em teste unitario; a entidade e so um tipo.
      exclude: ['src/main/index.ts', 'src/domain/entities/**'],
      // Piso, nao meta: impede que uma regressao derrube a cobertura sem que
      // ninguem perceba. Os numeros atuais ficam bem acima destes valores.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
