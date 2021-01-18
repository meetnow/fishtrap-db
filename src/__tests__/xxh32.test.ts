//
//  xxh32.test.ts
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

import XXH32 from '../xxh32';

describe('XXH32', () => {
  const test1 = Uint8Array.of(78, 111, 98, 111, 100, 121, 32, 105, 110, 115, 112, 101, 99, 116, 115, 32, 116, 104, 101, 32, 115, 112, 97, 109, 109, 105, 115, 104, 32, 114, 101, 112, 101, 116, 105, 116, 105, 111, 110);
  const test2 = Uint8Array.of(84, 104, 101, 32, 113, 117, 105, 99, 107, 32, 98, 114, 111, 119, 110, 32, 102, 111, 120, 32, 106, 117, 109, 112, 115, 32, 111, 118, 101, 114, 32, 116, 104, 101, 32, 108, 97, 122, 121, 32, 100, 111, 103, 46);
  const test3 = Uint8Array.of();
  const test4 = Uint8Array.of(97, 98, 99, 100);
  const test5 = Uint8Array.of(49, 50, 51, 52, 53, 54, 55);

  test('long examples', () => {
    expect(XXH32(test1, 0)).toEqual(-500614353);
    expect(XXH32(test2, 0)).toEqual(1758476744);
  });

  test('short examples', () => {
    expect(XXH32(test3, 0)).toEqual(46947589);
    expect(XXH32(test4, 0)).toEqual(-1553713403);
    expect(XXH32(test5, 0)).toEqual(-577940146);
  });
});
