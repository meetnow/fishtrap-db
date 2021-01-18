//
//  reed_solomon.test.ts
//  fishtrap-db
//
//  Created by Patrick Schneider on 05.01.2021
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

import { ReedSolomon } from '../reed_solomon';

describe('ReedSolomon', () => {
  const test1d = Uint8Array.of(116, 101, 115, 116);
  const test1e = Uint8Array.of(116, 101, 115, 116, 102, 82, 51, 17);

  const test2d = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    test2d[i] = i;
  }
  const test2e = new Uint8Array(276);
  for (let i = 0; i < 245; i += 1) {
    test2e[i] = i;
  }
  test2e.set(Uint8Array.of(89, 93, 74, 214, 71, 176, 9, 117, 144, 119), 245);
  for (let i = 245; i < 256; i += 1) {
    test2e[i + 10] = i;
  }
  test2e.set(Uint8Array.of(253, 153, 22, 176, 236, 113, 69, 142, 146, 242), 266);

  test('encode', () => {
    let rs = new ReedSolomon(4);
    expect(rs.encode(test1d)).toEqual(test1e);

    rs = new ReedSolomon();
    expect(rs.encode(test2d)).toEqual(test2e);
  });

  test('decode', () => {
    let rs = new ReedSolomon(4);
    expect(rs.decode(test1e)).toEqual(test1d);
    const test1em = test1e.slice(0);
    test1em[1] = 0x32;
    expect(rs.decode(test1em)).toEqual(test1d);
    test1em[4] = 0x32;
    expect(rs.decode(test1em)).toEqual(test1d);
    test1em[6] = 0x32;
    expect(() => rs.decode(test1em)).toThrowError('Could not find errors');

    rs = new ReedSolomon();
    expect(rs.decode(test2e)).toEqual(test2d);
    const test2em = test2e.slice(0);
    test2em[20] ^= 0xff;
    test2em[48] ^= 0xff;
    test2em[67] ^= 0xff;
    test2em[81] ^= 0xff;
    test2em[92] ^= 0xff;
    test2em[259] ^= 0xff;
    test2em[260] ^= 0xff;
    test2em[261] ^= 0xff;
    test2em[268] ^= 0xff;
    test2em[275] ^= 0xff;
    expect(rs.decode(test2em)).toEqual(test2d);
  });
});
