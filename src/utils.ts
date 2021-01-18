//
//  utils.ts
//  fishtrap-db
//
//  Created by Patrick Schneider on 13.01.2021
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

import msgpack from 'msgpack-lite';

import { ReedSolomon } from './reed_solomon';
import { DataBlock, FileDescriptor, Transaction } from './types';
import XXH32 from './xxh32';

const XXH_SEED = 1179210568;
const MAGIC_BYTES = new Uint8Array([102, 105, 115, 104, 116, 114, 97, 112]);

const ecc = new ReedSolomon(4);

export function lpadhex32 (n: number) {
  if (n < 16) {
    return `0000000${n.toString(16)}`;
  }
  else if (n < 256) {
    return `000000${n.toString(16)}`;
  }
  else if (n < 4096) {
    return `00000${n.toString(16)}`;
  }
  else if (n < 65536) {
    return `0000${n.toString(16)}`;
  }
  else if (n < 1048576) {
    return `000${n.toString(16)}`;
  }
  else if (n < 16777216) {
    return `00${n.toString(16)}`;
  }
  else if (n < 268435456) {
    return `0${n.toString(16)}`;
  }
  return n.toString(16);
}

export function compareMtimes ({ mtime: a }: FileDescriptor, { mtime: b }: FileDescriptor) {
  return a.getTime() - b.getTime();
}

export function compareGenerations ({ generation: a }: FileDescriptor, { generation: b }: FileDescriptor) {
  return a - b;
}

export function compareSequences ({ sequence: a }: Transaction, { sequence: b }: Transaction) {
  return a - b;
}

export function readDataBlock (fileData: Uint8Array, offset: number): DataBlock {
  const buffer = new ArrayBuffer(8);
  const bufferBytes = new Uint8Array(buffer);
  const bufferView = new DataView(buffer);

  for (let i = offset; i < fileData.length - 24; i += 1) {
    let m = 0;
    for (let j = 0; j < MAGIC_BYTES.length; j += 1) {
      if (fileData[i + j] === MAGIC_BYTES[j]) {
        m += 1;
      }
    }
    if (m >= MAGIC_BYTES.length - 2) {
      // Detected magic bytes, read length field
      if (ecc.decodeChunk(fileData.subarray(i + 8, i + 16), bufferBytes) == null) {
        const blockLength = bufferView.getUint32(0, false);
        if (fileData.length - i - 24 - blockLength < 0) {
          return { offset: i, length: blockLength + 24 };
        }
        // Read hash field (if there is actual data to hash, otherwise we don't care)
        if (blockLength > 0 && ecc.decodeChunk(fileData.subarray(i + 16, i + 24), bufferBytes) == null) {
          const blockHash = bufferView.getInt32(0, false);
          const blockBytes = fileData.subarray(i + 24, i + 24 + blockLength);
          // Compare hash
          if (XXH32(blockBytes, XXH_SEED) === blockHash) {
            // Decode
            try {
              return { offset: i, length: blockLength + 24, data: msgpack.decode(blockBytes) };
            }
            catch (e) {
              // pass
            }
          }
        }
        // Skip
        i += 23 + blockLength;
      }
    }
  }
  return { offset: fileData.length, length: 0 };
}

export function writeDataBlock (data: any): Uint8Array {
  const buffer = new ArrayBuffer(4);
  const bufferBytes = new Uint8Array(buffer);
  const bufferView = new DataView(buffer);

  // This trick introduces a filler prefix into the MessagePack data which has the exact length of our block header
  const bytes = msgpack.encode([new Uint8Array(20), data]);
  if (bytes[0] !== 146 || bytes[1] !== 199 || bytes[2] !== 20 || bytes[3] !== 18) {
    throw new Error('Assertion failure');
  }
  // Write magic bytes
  bytes.set(MAGIC_BYTES, 0);
  // Write length field
  bufferView.setUint32(0, bytes.length - 24, false);
  ecc.encodeChunk(bufferBytes, bytes, 8);
  // Write hash field
  bufferView.setInt32(0, XXH32(bytes.subarray(24), XXH_SEED), false);
  ecc.encodeChunk(bufferBytes, bytes, 16);

  return bytes;
}
