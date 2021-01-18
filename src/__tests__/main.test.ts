//
//  main.test.ts
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

import path from 'path';
import fs from 'fs/promises';

import { FishtrapConfig, FishtrapDB, FishtrapFS } from '../index';
import { FishtrapMerger } from '../types';

interface SimpleTestDB {
  something: number;
  other: string[];
}

const ffs: FishtrapFS = {
  join: path.join,
  readdir: fs.readdir,
  stat: fs.stat,
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  appendFile: fs.appendFile,
  rename: fs.rename,
  unlink: fs.unlink,
};

describe('main functionality', () => {
  const testInitialData: SimpleTestDB = { something: 0, other: [] };
  const testConfig1: FishtrapConfig = {
    appUUID: '4daba58f-3faf-4fa7-927b-c94eef746e4d',
    shardUUID: '58a5ee12-c5ac-44ef-9684-9dfa3d86c421',
    fs: ffs,
    baseDirectory: 'test_data',
    compactionIntervalMinutes: 0,
    checkIntervalMinutes: 0,
  };
  const testConfig2: FishtrapConfig = {
    appUUID: '4daba58f-3faf-4fa7-927b-c94eef746e4d',
    shardUUID: '08f78ecd-2b6b-45ef-bb1e-55125863db5f',
    fs: ffs,
    baseDirectory: 'test_data',
    compactionIntervalMinutes: 0,
    checkIntervalMinutes: 0,
  };

  beforeEach(async () => {
    for (const name of await fs.readdir(testConfig1.baseDirectory!)) {
      await fs.unlink(path.join(testConfig1.baseDirectory!, name));
    }
  });

  test('create update read', async () => {
    const db = new FishtrapDB<SimpleTestDB>(testConfig1, testInitialData, () => undefined);

    expect((await db.get()).something).toBe(testInitialData.something);

    await db.update((data) => {
      data.something = 2;
    });
    expect((await db.get()).something).toBe(2);

    await db.close();
    await expect(db.get()).rejects.toEqual(new Error('Database closed'));

    await db.open();
    expect((await db.get()).something).toBe(2);
  });

  test('simple snapshot', async () => {
    const db = new FishtrapDB<SimpleTestDB>(testConfig1, testInitialData, () => undefined);

    await db.update((data) => {
      data.something = 2;
    });

    await db.forceCompaction();

    expect((await db.get()).something).toBe(2);

    await db.close();
    await db.open();
    expect((await db.get()).something).toBe(2);
  });

  test('merged snapshot', async () => {
    const testMerger: FishtrapMerger<SimpleTestDB> = (target, other, base) => {
      if (base.something !== other.something) {
        target.something = other.something;
      }
      if (base.other.length !== other.other.length) {
        target.other = other.other;
      }
    };
    const db1 = new FishtrapDB<SimpleTestDB>(testConfig1, testInitialData, testMerger);
    const db2 = new FishtrapDB<SimpleTestDB>(testConfig2, testInitialData, testMerger);

    await db1.update((data) => {
      data.something = 2;
    });
    await db2.update((data) => {
      data.other.push('test1');
    });

    await db1.forceCompaction();

    expect((await db1.get()).other).toEqual(['test1']);

    await db2.forceCheckRebase();

    expect((await db2.get()).something).toBe(2);

    await db1.update((data) => {
      data.something = 3;
    });

    await db1.forceCompaction();

    await db2.update((data) => {
      data.other.push('test2');
    });

    await db2.close();
    await db2.open();

    expect((await db2.get()).other).toEqual(['test1', 'test2']);
  }, 120000);
});
