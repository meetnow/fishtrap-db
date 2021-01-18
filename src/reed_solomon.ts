//
//  reed_solomon.ts
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

/* eslint-disable no-fallthrough */

class GaloisField {
  exp: Uint8Array;
  log: Uint8Array;

  constructor () {
    this.exp = new Uint8Array(512);
    this.log = new Uint8Array(256);
    for (let i = 0, x = 0; i < 255; i += 1) {
      x <<= 1;
      if (x === 0) {
        x = 1;
      }
      if (x & 0x100) {
        x ^= 0x11d;
      }
      this.exp[i] = x;
      this.exp[i + 255] = x;
      this.log[x] = i;
    }
    this.exp[510] = 1;
    this.exp[511] = 2;
  }

  mul (x: number, y: number) {
    if (x === 0 || y === 0) {
      return 0;
    }
    return this.exp[this.log[x] + this.log[y]];
  }

  div (x: number, y: number) {
    if (y === 0) {
      throw new Error('Div by zero');
    }
    if (x === 0) {
      return 0;
    }
    return this.exp[this.log[x] + 255 - this.log[y]];
  }

  polyScale (p: Uint8Array, x: number) {
    const r = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i += 1) {
      r[i] = this.mul(p[i], x);
    }
    return r;
  }

  polyAdd (p: Uint8Array, q: Uint8Array) {
    const ml = Math.max(p.length, q.length);
    const r = new Uint8Array(ml);
    for (let i = 0; i < p.length; i += 1) {
      r[i + ml - p.length] = p[i];
    }
    for (let i = 0; i < q.length; i += 1) {
      r[i + ml - q.length] ^= q[i];
    }
    return r;
  }

  polyMul (p: Uint8Array | number[], q: Uint8Array | number[]) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let j = 0; j < q.length; j += 1) {
      for (let i = 0; i < p.length; i += 1) {
        r[i + j] ^= this.mul(p[i], q[j]);
      }
    }
    return r;
  }

  polyEval (p: Uint8Array, x: number) {
    let y = p[0];
    for (let i = 1; i < p.length; i += 1) {
      y = this.mul(y, x) ^ p[i];
    }
    return y;
  }
}

const gf = new GaloisField();

export class ReedSolomon {
  chunkSize: number;
  gen: Uint8Array;

  constructor (public nSym: number = 10) {
    if (nSym <= 0 || nSym >= 255) {
      throw new Error('Number of ecc symbols must be between 0 and 256 (exclusive)');
    }
    this.chunkSize = 255 - this.nSym;

    // Build generator polynome
    let gen = gf.polyMul([1], [1, gf.exp[0]]);
    for (let i = 1; i < nSym; i += 1) {
      gen = gf.polyMul(gen, [1, gf.exp[i]]);
    }
    this.gen = gen;
  }

  encode (data: Uint8Array) {
    const chunkSize = this.chunkSize;
    const fullChunks = Math.floor(data.length / chunkSize);
    const restChunk = data.length % chunkSize;
    const enc = new Uint8Array(fullChunks * 255 + (restChunk > 0 ? restChunk + this.nSym : 0));

    for (let i = 0, j = 0; i < data.length; i += chunkSize, j += 255) {
      this.encodeChunk(data.subarray(i, i + chunkSize), enc, j);
    }

    return enc;
  }

  decode (data: Uint8Array): Uint8Array {
    const chunkSize = this.chunkSize;
    const fullChunks = Math.floor(data.length / 255);
    const restChunk = data.length % 255;
    const dec = new Uint8Array(fullChunks * chunkSize + (restChunk > 0 ? restChunk : this.nSym));

    let errorMessage: string | null = null;
    for (let i = 0, j = 0; i < data.length; i += 255, j += chunkSize) {
      errorMessage = this.decodeChunk(data.subarray(i, i + 255), dec, j);
      if (errorMessage != null) {
        throw new Error(errorMessage);
      }
    }

    return dec.subarray(0, dec.length - this.nSym);
  }

  encodeChunk (input: Uint8Array, output: Uint8Array, outputOffset = 0) {
    const ilen = input.length;
    const gen = this.gen;
    const genl = gen.length;
    output.set(input, outputOffset);
    for (let i = 0, c = 0; i < ilen; i += 1) {
      c = output[outputOffset + i];
      if (c !== 0) {
        for (let j = 0; j < genl; j += 1) {
          output[outputOffset + i + j] ^= gf.mul(gen[j], c);
        }
      }
    }
    output.set(input, outputOffset);
  }

  private _syndromesOf (input: Uint8Array) {
    const n = this.nSym;
    const r = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      r[i] = gf.polyEval(input, gf.exp[i]);
    }
    return r;
  }

  decodeChunk (input: Uint8Array, output: Uint8Array, outputOffset = 0): string | null {
    const ilen = input.length;
    const n = this.nSym;
    output.set(input, outputOffset);
    let s = this._syndromesOf(input);
    if (s.some(x => x !== 0)) {
      // Find errors
      let ep = new Uint8Array([1]);
      let op = new Uint8Array([1]);
      for (let i = 0; i < n; i += 1) {
        let np = new Uint8Array(op.length + 1);
        np.set(op);
        op = np;
        let d = s[i];
        for (let j = 1; j < ep.length; j += 1) {
          d ^= gf.mul(ep[ep.length - 1 - j], s[i - j]);
        }
        if (d !== 0) {
          if (op.length > ep.length) {
            np = gf.polyScale(op, d);
            op = gf.polyScale(ep, gf.div(1, d));
            ep = np;
          }
          ep = gf.polyAdd(ep, gf.polyScale(op, d));
        }
      }
      if ((ep.length - 1) * 2 > n) {
        return 'Could not find errors';
      }
      const epos = [];
      for (let i = 0; i < ilen; i += 1) {
        if (gf.polyEval(ep, gf.exp[255 - i]) === 0) {
          epos.push(ilen - 1 - i);
        }
      }
      if (epos.length !== ep.length - 1) {
        return 'Could not find errors';
      }

      // Correct errors
      let q = new Uint8Array([1]);
      for (let i = 0; i < epos.length; i += 1) {
        q = gf.polyMul(q, [gf.exp[ilen - 1 - epos[i]], 1]);
      }
      s = s.subarray(0, epos.length);
      s.reverse();
      s = gf.polyMul(s, q);
      s = s.subarray(s.length - epos.length);
      const o = q.length & 1;
      const qlh = (q.length - o) / 2;
      for (let i = 0; i < qlh; i += 1) {
        q[i] = q[i * 2 + o];
      }
      q = q.subarray(0, qlh);
      for (let i = 0; i < epos.length; i += 1) {
        const x = gf.exp[epos[i] + 256 - ilen];
        output[outputOffset + epos[i]] ^= gf.div(gf.polyEval(s, x), gf.mul(x, gf.polyEval(q, gf.mul(x, x))));
      }

      // Check success
      s = this._syndromesOf(output.subarray(outputOffset, outputOffset + ilen));
      if (s.some(x => x !== 0)) {
        return 'Could not correct errors';
      }
    }

    return null;
  }
}
