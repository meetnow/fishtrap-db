//
//  jest.config.js
//  fishtrap-db
//
//  Created by Patrick Schneider on 04.01.2021
//  Copyright (c) 2021 MeetNow! GmbH
//
//  Licensed under the EUPL, Version 1.2 or – as soon they will be approved by
//  the European Commission - subsequent versions of the EUPL (the "Licence");
//  You may not use this work except in compliance with the Licence.
//  You may obtain a copy of the Licence at:
//
//  https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the Licence is distributed on an "AS IS" basis,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the Licence for the specific language governing permissions and
//  limitations under the Licence.
//

const { defaults: tsjPreset } = require('ts-jest/presets');
const { pathsToModuleNameMapper } = require('ts-jest/utils');
const { compilerOptions } = require('./tsconfig.base');

module.exports = {
  ...tsjPreset,
  automock: false,
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
      babelConfig: {
        presets: [
          '@babel/preset-env',
        ],
        plugins: [
          '@babel/plugin-transform-modules-commonjs',
          ['@babel/plugin-transform-runtime', { regenerator: true }],
        ],
      },
    },
  },
  moduleFileExtensions: [
    'ts',
    'js',
  ],
  testMatch: [
    '**/src/__tests__/*.test.ts',
  ],
  testPathIgnorePatterns: [
    '\\.snap$',
    '<rootDir>/node_modules/',
  ],
  cacheDirectory: '.jest/cache',
  // collectCoverage: true,
  // collectCoverageFrom: ['src/**/*.ts', '!**/*.d.ts', '!**/__tests__/*.ts'],
};
