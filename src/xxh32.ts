//
//  xxh32.ts
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

const XXH_PRIME32_1 = 0x9e3779b1;
const XXH_PRIME32_2 = 0x85ebca77;
const XXH_PRIME32_3 = 0xc2b2ae3d;
const XXH_PRIME32_4 = 0x27d4eb2f;
const XXH_PRIME32_5 = 0x165667b1;

function XXH32_round (acc: number, input: number): number {
  acc = (acc + Math.imul(input, XXH_PRIME32_2)) | 0;
  acc = (acc << 13) | (acc >>> 19); // acc <<< 13
  acc = Math.imul(acc, XXH_PRIME32_1);
  return acc;
}

function XXH_PROCESS1 (acc: number, input: number): number {
  acc = (acc + Math.imul(input, XXH_PRIME32_5)) | 0;
  acc = (acc << 11) | (acc >>> 21); // acc <<< 11
  return Math.imul(acc, XXH_PRIME32_1);
}

function XXH_PROCESS4 (acc: number, input: number): number {
  acc = (acc + Math.imul(input, XXH_PRIME32_3)) | 0;
  acc = (acc << 17) | (acc >>> 15); // acc <<< 17
  return Math.imul(acc, XXH_PRIME32_4);
}

function XXH32_finalize (acc: number, data: DataView, offset: number): number {
  switch (data.byteLength - offset) {
    case 12:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 8:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 4:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      break;

    case 13:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 9:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 5:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      acc = XXH_PROCESS1(acc, data.getUint8(offset + 4));
      break;

    case 14:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 10:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 6:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      acc = XXH_PROCESS1(acc, data.getUint8(offset + 4));
      acc = XXH_PROCESS1(acc, data.getUint8(offset + 5));
      break;

    case 15:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 11:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 7:
      acc = XXH_PROCESS4(acc, data.getInt32(offset, true));
      offset += 4;
    case 3:
      acc = XXH_PROCESS1(acc, data.getUint8(offset));
      offset += 1;
    case 2:
      acc = XXH_PROCESS1(acc, data.getUint8(offset));
      offset += 1;
    case 1:
      acc = XXH_PROCESS1(acc, data.getUint8(offset));
      break;

    default:
      break;
  }

  // XXH32_avalanche
  acc = Math.imul(acc ^ (acc >>> 15), XXH_PRIME32_2);
  acc = Math.imul(acc ^ (acc >>> 13), XXH_PRIME32_3);
  return acc ^ (acc >>> 16);
}

export default function XXH32 (dataViewOrArray: DataView | Uint8Array, seed: number): number {
  let dataView: DataView;
  if (dataViewOrArray instanceof DataView) {
    dataView = dataViewOrArray;
  }
  else {
    dataView = new DataView(dataViewOrArray.buffer, dataViewOrArray.byteOffset, dataViewOrArray.byteLength);
  }
  let offset = 0;
  let acc;
  if (dataView.byteLength >= 16) {
    let v1 = (seed + XXH_PRIME32_1 + XXH_PRIME32_2) | 0;
    let v2 = (seed + XXH_PRIME32_2) | 0;
    let v3 = seed;
    let v4 = (seed - XXH_PRIME32_1) | 0;

    const limit = dataView.byteLength - 16;
    do {
      v1 = XXH32_round(v1, dataView.getInt32(offset, true));
      offset += 4;
      v2 = XXH32_round(v2, dataView.getInt32(offset, true));
      offset += 4;
      v3 = XXH32_round(v3, dataView.getInt32(offset, true));
      offset += 4;
      v4 = XXH32_round(v4, dataView.getInt32(offset, true));
      offset += 4;
    } while (offset <= limit);

    // acc = (v1 <<< 1) + (v2 <<< 7) + (v3 <<< 12) + (v4 <<< 18)
    acc = (v1 << 1) | (v1 >>> 31);
    acc = (acc + ((v2 << 7) | (v2 >>> 25))) | 0;
    acc = (acc + ((v3 << 12) | (v3 >>> 20))) | 0;
    acc = (acc + ((v4 << 18) | (v4 >>> 14))) | 0;
  }
  else {
    acc = (seed + XXH_PRIME32_5) | 0;
  }

  acc = (acc + dataView.byteLength) | 0;

  return XXH32_finalize(acc, dataView, offset);
}
