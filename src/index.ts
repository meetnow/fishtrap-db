//
//  index.ts
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

import { castImmutable, enablePatches, freeze, Immer, Immutable } from 'immer';

import {
  FileStats,
  FishtrapFS,
  FishtrapConfig,
  FishtrapMerger,
  FileDescriptor,
  Snapshot,
  Transaction,
  FishtrapPostCompactionHook,
} from './types';

import { lpadhex32, compareMtimes, compareGenerations, compareSequences, readDataBlock, writeDataBlock } from './utils';

enablePatches();

const SD_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8})\.sd(sn|sh|lk)$/i;

class FishtrapDB<T> {
  readonly appUUID: string;
  readonly shardUUID: string;
  readonly fs: FishtrapFS;
  readonly baseDirectory: string;
  readonly compactionSizeThreshold: number;
  readonly compactionIntervalMinutes: number;
  readonly checkIntervalMinutes: number;

  private _immer = new Immer({ autoFreeze: true });
  private _generation = 0;
  private _sequence = 0;
  private _shardSize = 0;
  private _initialSnapshot: Snapshot<T>;
  private _merger: FishtrapMerger<T>;
  private _data: T;
  private _activeTx: Promise<any>;
  private _compactionTimer: ReturnType<typeof setTimeout> | undefined;
  private _checkTimer: ReturnType<typeof setTimeout> | undefined;

  constructor (
    config: FishtrapConfig,
    initialData: T,
    merger: FishtrapMerger<T>,
    public postCompactionHook?: FishtrapPostCompactionHook<T>,
  ) {
    this.appUUID = config.appUUID;
    this.shardUUID = config.shardUUID;
    this.fs = config.fs;
    this.baseDirectory = config.baseDirectory || '';
    this.compactionSizeThreshold = (config.compactionSizeThreshold ?? 0x10000);
    if (this.compactionSizeThreshold === 0 || this.compactionSizeThreshold > 0x6300000) {
      this.compactionSizeThreshold = 0x6300000;
    }
    this.compactionIntervalMinutes = config.compactionIntervalMinutes || 30;
    this.checkIntervalMinutes = config.checkIntervalMinutes || 15;
    const frozenInitialData = freeze(initialData, true);
    this._initialSnapshot = { generation: 0, data: frozenInitialData, ancestors: {} };
    this._merger = merger;
    this._data = frozenInitialData;
    this._activeTx = this._open();
  }

  /**
   * Retrieves the data
   *
   * The promise resolves as soon as the database has been opened (if not already) and the last update transaction was completed.
   */
  async get (): Promise<Immutable<T>> {
    await this._activeTx;
    return castImmutable(this._data);
  }

  /**
   * Performs an update transaction on the database
   *
   * Resolves to the updated data if the transaction was finished successfully.
   * @param updater Function that is executed in order to manipulate the data
   */
  update (updater: (data: T) => void | T | Promise<void> | Promise<T>): Promise<Immutable<T>> {
    const nextTx = this._activeTx.then(async () => {
      const [updated, delta] = await Promise.resolve(this._immer.produceWithPatches(this._data, updater));
      if (delta.length > 0) {
        this._sequence += 1;
        await this._appendToShard({ sequence: this._sequence, delta });
        this._data = updated;
      }
      return updated;
    });
    this._activeTx = nextTx.catch(() => undefined);
    return nextTx;
  }

  /**
   * Closes the database
   *
   * Pending transactions will be waited for; subsequent get or update calls will fail. It is possible to reopen the database.
   */
  async close () {
    try {
      await this._activeTx;
    }
    catch (e) {
      // pass
    }
    if (this._compactionTimer != null) {
      clearTimeout(this._compactionTimer);
      this._compactionTimer = undefined;
    }
    if (this._checkTimer != null) {
      clearTimeout(this._checkTimer);
      this._checkTimer = undefined;
    }
    this._activeTx = Promise.reject(new Error('Database closed'));
  }

  /**
   * Reopens the database
   *
   * The database is automatically opened on instantiation, this call is only useful after calling `close()` or after errors while opening.
   */
  async open () {
    try {
      await this._activeTx;
    }
    catch (e) {
      this._activeTx = this._open();
    }
    return this._activeTx;
  }

  /**
   * Force a compaction
   *
   * May fail if any process holds a lockfile (including ourselves).
   */
  forceCompaction () {
    if (this._compactionTimer != null) {
      clearTimeout(this._compactionTimer);
      this._compactionTimer = undefined;
    }
    return this._performCompaction();
  }

  /**
   * Force a check/rebase
   */
  forceCheckRebase (): Promise<void> {
    if (this._checkTimer != null) {
      clearTimeout(this._checkTimer);
      this._checkTimer = undefined;
    }
    return this._checkRebase();
  }

  private async _unlinkIgnoreError (name: string) {
    try {
      await this.fs.unlink(this.fs.join(this.baseDirectory, name));
    }
    catch (e) {
      // pass
    }
  }

  private async _renameBrokenFile (name: string) {
    for (let c = 0; c < 0x100000000; c += 1) {
      const newName = `${name}.${lpadhex32(c)}.sdbf`;
      try {
        await this.fs.stat(this.fs.join(this.baseDirectory, newName));
      }
      catch (e) {
        try {
          await this.fs.rename(this.fs.join(this.baseDirectory, name), this.fs.join(this.baseDirectory, newName));
        }
        catch (ee) {
          // pass
        }
      }
    }
  }

  private async _inspectBaseDirectory (ownShardsOnly: boolean) {
    const snapshotFiles: FileDescriptor[] = [];
    const lockFiles: FileDescriptor[] = [];
    const shardFiles: FileDescriptor[] = [];
    const now = new Date();
    for (const name of await this.fs.readdir(this.baseDirectory)) {
      let stats: FileStats | null = null;
      try {
        stats = await this.fs.stat(this.fs.join(this.baseDirectory, name));
      }
      catch (e) {
        // pass
      }
      if (stats != null) {
        const m = SD_FILE_RE.exec(name);
        if (m != null && stats.isFile()) {
          const [, uuid, genstr, filetype] = m;
          const desc: FileDescriptor = {
            name,
            size: (typeof stats.size === 'string' ? parseInt(stats.size, 10) : stats.size),
            mtime: (typeof stats.mtime === 'number' ? new Date(stats.mtime * 1000) : stats.mtime),
            uuid,
            generation: parseInt(genstr, 16),
          };
          if (filetype === 'lk') {
            if ((ownShardsOnly && uuid === this.shardUUID) || now.getTime() - desc.mtime.getTime() > 72e5) {
              // Stale lockfile
              await this._unlinkIgnoreError(name);
            }
            else if (await this._verifyLockfile(desc)) {
              lockFiles.push(desc);
            }
          }
          else if (filetype === 'sn' && uuid === this.appUUID) {
            snapshotFiles.push(desc);
          }
          else if (filetype === 'sh' && stats.size > 0 && (!ownShardsOnly || desc.uuid === this.shardUUID)) {
            shardFiles.push(desc);
          }
        }
      }
    }

    // Sort files
    lockFiles.sort(compareMtimes);
    snapshotFiles.sort(compareGenerations);
    shardFiles.sort(compareGenerations);

    // Process lockfiles
    for (const desc of snapshotFiles) {
      const firstLockfile = lockFiles.find(({ generation }) => generation === desc.generation);
      if (firstLockfile != null) {
        desc.lockedBy = firstLockfile.uuid;
      }
    }
    const nextGeneration = (snapshotFiles.length === 0 ? 1 : snapshotFiles[snapshotFiles.length - 1].generation + 1);
    const nextGenerationLockfile = lockFiles.find(({ generation }) => generation === nextGeneration);

    return {
      snapshotFiles,
      shardFiles,
      nextGeneration,
      nextGenerationLockedBy: (nextGenerationLockfile != null ? nextGenerationLockfile.uuid : null),
    };
  }

  private async _rebase (snapshot: Snapshot<T>, base: Snapshot<T>) {
    const oldGeneration = this._generation;
    if (snapshot.generation === oldGeneration + 1 && snapshot.ancestors[this.shardUUID] === this._sequence) {
      // Fast forward
      this._generation = snapshot.generation;
      this._shardSize = 0;
      this._data = snapshot.data;
      return this._deleteShard(oldGeneration);
    }

    // Full merge
    const [updated, delta] = await Promise.resolve(this._immer.produceWithPatches(this._data, (d: T) =>
      this._merger(d, snapshot.data, castImmutable(base.data))));

    this._generation = snapshot.generation;
    this._shardSize = 0;
    if (delta.length > 0) {
      // Write merge transaction
      this._sequence += 1;
      await this._appendToShard({ sequence: this._sequence, delta });
      this._data = updated;
    }

    return this._deleteShard(oldGeneration);
  }

  private async _open () {
    const { snapshotFiles, shardFiles } = await this._inspectBaseDirectory(true);

    let lastSnapshot = this._initialSnapshot;

    // Load last unlocked and undamaged snapshot
    for (let i = snapshotFiles.length - 1; i >= 0; i -= 1) {
      if (snapshotFiles[i].lockedBy == null) {
        try {
          lastSnapshot = await this._readSnapshot(snapshotFiles[i]);
          break;
        }
        catch (e) {
          console.log(`FishtrapDB@${this.appUUID}: Snapshot \"${snapshotFiles[i].name}\" appears to be broken, skipping.`);
          snapshotFiles.splice(i, 1);
          i += 1;
        }
      }
    }

    this._generation = lastSnapshot.generation;
    this._sequence = lastSnapshot.ancestors[this.shardUUID] || 0;
    this._shardSize = 0;
    this._data = lastSnapshot.data;

    // Load last undamaged shard
    for (let desc = shardFiles.pop(); desc != null; desc = shardFiles.pop()) {
      const { name, size, generation: shardGeneration } = desc;
      const snapshotFile = snapshotFiles.find(({ generation }) => generation === shardGeneration);
      if (size === 0) {
        // Blank shard, delete it
        await this._unlinkIgnoreError(name);
      }
      else if (snapshotFile == null && shardGeneration > 0) {
        // Snapshot missing
        console.log(`FishtrapDB@${this.appUUID}: Shard \"${name}\" references a non-existing or locked snapshot, skipping and moving file.`);
        await this._renameBrokenFile(name);
      }
      else if (lastSnapshot.generation === shardGeneration) {
        // It's a match
        let shardSequence = lastSnapshot.ancestors[this.shardUUID] || 0;
        let shardData = lastSnapshot.data;
        try {
          const transactions = await this._readShard(desc);
          for (const { sequence, delta } of transactions) {
            shardSequence = sequence;
            shardData = this._immer.applyPatches(shardData, delta);
          }
          // Success
          this._sequence = shardSequence;
          this._shardSize = desc.size;
          this._data = shardData;
          break;
        }
        catch (e) {
          console.log(`FishtrapDB@${this.appUUID}: Shard \"${name}\" appears to be broken, skipping and moving file.`);
          await this._renameBrokenFile(name);
        }
      }
      else {
        // Referencing an old snapshot, needs rebase
        let baseSnapshot: Snapshot<T> | null = this._initialSnapshot;
        if (snapshotFile != null) {
          try {
            baseSnapshot = await this._readSnapshot(snapshotFile);
          }
          catch (e) {
            console.log(`FishtrapDB@${this.appUUID}: Shard \"${name}\" references a broken snapshot, skipping and moving file.`);
            await this._renameBrokenFile(name);
            baseSnapshot = null;
          }
        }
        if (baseSnapshot != null) {
          let shardSequence = baseSnapshot.ancestors[this.shardUUID] || 0;
          let shardData = baseSnapshot.data;
          try {
            const transactions = await this._readShard(desc);
            for (const { sequence, delta } of transactions) {
              shardSequence = sequence;
              shardData = this._immer.applyPatches(shardData, delta);
            }
            // Success
            this._generation = baseSnapshot.generation;
            this._sequence = shardSequence;
            this._shardSize = desc.size;
            this._data = shardData;
          }
          catch (e) {
            console.log(`FishtrapDB@${this.appUUID}: Shard \"${name}\" appears to be broken, skipping and moving file.`);
            await this._renameBrokenFile(name);
            baseSnapshot = null;
          }
        }
        if (baseSnapshot != null) {
          // Perform rebase
          await this._rebase(lastSnapshot, baseSnapshot);
          break;
        }
      }
    }

    // Setup timers
    if (this._shardSize > this.compactionSizeThreshold) {
      this._compactionTimer = setTimeout(() => this._performCompaction(), 1000);
    }
    else if (this.compactionIntervalMinutes > 0) {
      this._compactionTimer = setTimeout(() => this._performCompaction(), this.compactionIntervalMinutes * 60000);
    }

    if (this.checkIntervalMinutes > 0) {
      this._checkTimer = setTimeout(() => this._checkRebase(), this.compactionIntervalMinutes * 60000);
    }
  }

  private async _checkRebase () {
    const { snapshotFiles } = await this._inspectBaseDirectory(true);

    for (let i = snapshotFiles.length - 1; i >= 0; i -= 1) {
      if (snapshotFiles[i].lockedBy == null && snapshotFiles[i].generation > this._generation) {
        console.log(`FishtrapDB@${this.appUUID}: Detected new snapshot (#${snapshotFiles[i].generation} > #${this._generation}), performing rebase...`);
        let newerSnapshot: Snapshot<T>;
        try {
          newerSnapshot = await this._readSnapshot(snapshotFiles[i]);
        }
        catch (e) {
          console.log(`FishtrapDB@${this.appUUID}: Rebase failed, new snapshot damaged.`);
          continue;
        }

        let baseSnapshot = this._initialSnapshot;
        if (this._generation > 0) {
          const baseSnapshotFile = snapshotFiles.find(({ generation }) => generation === this._generation);
          if (baseSnapshotFile == null || baseSnapshotFile.lockedBy != null) {
            console.log(`FishtrapDB@${this.appUUID}: Rebase failed, base snapshot lost or locked.`);
            break;
          }
          try {
            baseSnapshot = await this._readSnapshot(baseSnapshotFile);
          }
          catch (e) {
            console.log(`FishtrapDB@${this.appUUID}: Rebase failed, base snapshot damaged.`);
            break;
          }
        }

        this._activeTx = this._activeTx.then(() =>
          this._rebase(newerSnapshot, baseSnapshot));
        break;
      }
    }

    // Next check
    if (this.checkIntervalMinutes > 0) {
      this._checkTimer = setTimeout(() => this._checkRebase(), this.compactionIntervalMinutes * 60000);
    }
  }

  private async _readSnapshot (desc: FileDescriptor): Promise<Snapshot<T>> {
    if (desc.size === 0) {
      throw new Error('No data');
    }
    if (desc.size > 104857600) {
      throw new Error('Snapshot size exceeds 100MiB');
    }
    const fileData = await this.fs.readFile(this.fs.join(this.baseDirectory, desc.name));
    const { data: blockData } = readDataBlock(fileData, 0);
    if (blockData == null) {
      throw new Error('No data');
    }
    if (typeof blockData !== 'object'
        || blockData.typ !== 'snp'
        || blockData.aid !== this.appUUID
        || blockData.gen !== desc.generation
        || !('dat' in blockData)
        || typeof blockData.anc !== 'object'
        || blockData.anc == null) {
      throw new Error('Invalid data');
    }

    const snapshot: Snapshot<T> = {
      generation: desc.generation,
      data: blockData.dat,
      ancestors: {},
    };

    for (let uuid of Object.keys(blockData.anc)) {
      const txseq = blockData.anc[uuid];
      if (typeof txseq !== 'number') {
        throw new Error('Invalid data');
      }
      snapshot.ancestors[uuid] = txseq;
    }

    return snapshot;
  }

  private async _writeSnapshot (snapshot: Snapshot<T>) {
    const name = `${this.appUUID}.${lpadhex32(snapshot.generation)}.sdsn`;
    const fileData = writeDataBlock({
      typ: 'snp',
      aid: this.appUUID,
      gen: snapshot.generation,
      dat: snapshot.data,
      anc: snapshot.ancestors,
    });
    await this.fs.writeFile(this.fs.join(this.baseDirectory, name), fileData);
  }

  private async _readShard (desc: FileDescriptor): Promise<Transaction[]> {
    if (desc.size > 104857600) {
      throw new Error('Shard size exceeds 100MiB');
    }
    const fileData = await this.fs.readFile(this.fs.join(this.baseDirectory, desc.name));
    const transactions: Transaction[] = [];
    let offset = 0;
    while (offset < fileData.length) {
      const dataBlock = readDataBlock(fileData, offset);
      if (dataBlock.length === 0 || dataBlock.offset + dataBlock.length > fileData.length) {
        // Broken shard (trailing garbage or cut off data)
        if (desc.uuid === this.shardUUID) {
          // Own shard, fix problems
          if (transactions.length === 0) {
            // No valid transactions
            throw new Error('No or invalid data');
          }
          else {
            // Write valid data, then rename
            try {
              const tmpName = `${desc.name}.tmp`;
              await this.fs.writeFile(this.fs.join(this.baseDirectory, tmpName), fileData.subarray(0, offset));
              await this.fs.rename(this.fs.join(this.baseDirectory, tmpName), this.fs.join(this.baseDirectory, desc.name));
            }
            catch (e) {
              console.warn(`FishtrapDB@${this.appUUID}: Failed to truncate partial shard \"${desc.name}\".`);
            }
            desc.size = offset;
          }
        }
        break;
      }
      // Got block data
      const { data: blockData } = dataBlock;
      if (blockData != null
          && typeof blockData === 'object'
          && blockData.typ === 'txn'
          && blockData.aid === this.appUUID
          && blockData.sid === desc.uuid
          && blockData.gen === desc.generation
          && typeof blockData.seq === 'number'
          && 'dat' in blockData) {
        transactions.push({
          sequence: blockData.seq,
          delta: blockData.dat,
        });
      }
      offset = dataBlock.offset + dataBlock.length;
    }
    transactions.sort(compareSequences);
    return transactions;
  }

  private async _deleteShard (generation: number) {
    try {
      await this.fs.unlink(this.fs.join(this.baseDirectory, `${this.shardUUID}.${lpadhex32(generation)}.sdsh`));
    }
    catch (e) {
      // pass
    }

    // Check if there are no more references to a snapshot
    const { snapshotFiles, shardFiles } = await this._inspectBaseDirectory(false);

    for (const snapshotFile of snapshotFiles) {
      if (snapshotFile.generation < this._generation
          && snapshotFile.lockedBy == null
          && !shardFiles.some(({ generation }) => generation === snapshotFile.generation)) {
        console.log(`FishtrapDB@${this.appUUID}: Removing unreferenced snapshot #${snapshotFile.generation}.`);
        await this._unlinkIgnoreError(snapshotFile.name);
      }
    }
  }

  private async _verifyLockfile (desc: FileDescriptor): Promise<boolean> {
    // Note: When a lockfile's contents was not written properly, we give it the benefit of the doubt
    if (desc.size < 48) {
      return true;
    }
    if (desc.size > 1024) {
      // Size unnacceptable
      return false;
    }
    const fileData = await this.fs.readFile(this.fs.join(this.baseDirectory, desc.name));
    const { data: blockData } = readDataBlock(fileData, 0);
    if (blockData == null || (typeof blockData === 'object'
        && blockData.typ === 'lck'
        && blockData.aid === this.appUUID
        && blockData.sid === desc.uuid
        && blockData.gen === desc.generation)) {
      return true;
    }
    return false;
  }

  private async _writeLockfile (generation: number) {
    const name = `${this.shardUUID}.${lpadhex32(generation)}.sdlk`;
    const fileData = writeDataBlock({
      typ: 'lck',
      aid: this.appUUID,
      sid: this.shardUUID,
      gen: generation,
    });
    await this.fs.writeFile(this.fs.join(this.baseDirectory, name), fileData);
  }

  private async _deleteLockfile (generation: number) {
    try {
      await this.fs.unlink(this.fs.join(this.baseDirectory, `${this.shardUUID}.${lpadhex32(generation)}.sdlk`));
    }
    catch (e) {
      // pass
    }
  }

  private async _appendToShard (transaction: Transaction) {
    const name = `${this.shardUUID}.${lpadhex32(this._generation)}.sdsh`;
    const fileData = writeDataBlock({
      typ: 'txn',
      aid: this.appUUID,
      sid: this.shardUUID,
      gen: this._generation,
      seq: transaction.sequence,
      dat: transaction.delta,
    });
    await this.fs.appendFile(this.fs.join(this.baseDirectory, name), fileData);
    const oldShardSize = this._shardSize;
    this._shardSize = oldShardSize + fileData.length;
    if (oldShardSize <= this.compactionSizeThreshold && this._shardSize > this.compactionSizeThreshold) {
      if (this._compactionTimer != null) {
        clearTimeout(this._compactionTimer);
      }
      this._compactionTimer = setTimeout(() => this._performCompaction(), 1000);
    }
  }

  private async _precheckCompaction () {
    const { snapshotFiles, nextGeneration, nextGenerationLockedBy } = await this._inspectBaseDirectory(false);
    if (nextGenerationLockedBy != null) {
      throw new Error('already locked');
    }

    if (nextGeneration > 1) {
      const lastSnapshotFile = snapshotFiles.find(({ generation }) => generation === nextGeneration - 1);
      if (lastSnapshotFile == null || lastSnapshotFile.lockedBy != null) {
        throw new Error('already locked');
      }
    }

    try {
      await this._writeLockfile(nextGeneration);
    }
    catch (e) {
      throw new Error('could not write lockfile');
    }

    return nextGeneration;
  }

  private async _tryCompaction (lockedGeneration: number) {
    const { snapshotFiles, shardFiles, nextGeneration, nextGenerationLockedBy } = await this._inspectBaseDirectory(false);
    if (nextGeneration !== lockedGeneration || nextGenerationLockedBy !== this.shardUUID) {
      await this._deleteLockfile(lockedGeneration);
      throw new Error('could not lock');
    }

    let baseSnapshot = this._initialSnapshot;
    if (nextGeneration > 1) {
      const lastSnapshotFile = snapshotFiles.find(({ generation }) => generation === nextGeneration - 1);
      if (lastSnapshotFile == null || lastSnapshotFile.lockedBy != null) {
        await this._deleteLockfile(lockedGeneration);
        throw new Error('last snapshot lost or locked');
      }
      try {
        baseSnapshot = await this._readSnapshot(lastSnapshotFile);
      }
      catch (e) {
        await this._unlinkIgnoreError(lastSnapshotFile.name);
        await this._deleteLockfile(lockedGeneration);
        throw new Error('last snapshot damaged');
      }
    }

    const generationShardFiles = shardFiles.filter(({ size, generation }) => size > 0 && generation === nextGeneration - 1);
    if (generationShardFiles.length === 0) {
      await this._deleteLockfile(lockedGeneration);
      throw new Error('no shards');
    }

    console.log(`FishtrapDB@${this.appUUID}: Compacting #${nextGeneration} from ${generationShardFiles.length} shard(s)...`);

    const compactedSnapshot: Snapshot<T> = {
      generation: nextGeneration,
      data: baseSnapshot.data,
      ancestors: {},
    };
    let first = true;
    for (const shardFile of generationShardFiles) {
      let finalSequence = -1;
      let shardData = baseSnapshot.data;
      try {
        const transactions = await this._readShard(shardFile);
        for (const { sequence, delta } of transactions) {
          finalSequence = sequence;
          shardData = this._immer.applyPatches(shardData, delta);
        }
      }
      catch (e) {
        finalSequence = -1;
      }
      if (finalSequence !== -1) {
        if (first) {
          first = false;
          compactedSnapshot.data = shardData;
        }
        else {
          try {
            compactedSnapshot.data = await Promise.resolve(this._immer.produce(compactedSnapshot.data, (d: T) =>
              this._merger(d, shardData, castImmutable(baseSnapshot.data))));
          }
          catch (e) {
            await this._deleteLockfile(lockedGeneration);
            throw new Error(`could not merge shard ${shardFile.uuid}`);
          }
        }
        compactedSnapshot.ancestors[shardFile.uuid] = finalSequence;
      }
      else {
        console.warn(`FishtrapDB@${this.appUUID}: Could not read/apply shard ${shardFile.uuid} during compaction, skipping.`);
      }
    }

    if (first) {
      await this._deleteLockfile(lockedGeneration);
      throw new Error('shards don\'t contain any (valid) data');
    }

    try {
      await this._writeSnapshot(compactedSnapshot);
    }
    catch (e) {
      await this._deleteLockfile(lockedGeneration);
      throw new Error('failed to write snapshot');
    }

    await this._deleteLockfile(lockedGeneration);

    // Run hook
    if (this.postCompactionHook != null) {
      const hook = this.postCompactionHook;
      const finalData = castImmutable(compactedSnapshot.data);
      const baseData = castImmutable(baseSnapshot.data);
      setTimeout(() => hook(finalData, baseData), 0);
    }

    // Instant rebase if possible
    this._activeTx = this._activeTx.then(() => {
      if (this._generation === baseSnapshot.generation) {
        return this._rebase(compactedSnapshot, baseSnapshot);
      }
      return undefined;
    });
  }

  private async _performCompaction () {
    console.log(`FishtrapDB@${this.appUUID}: Starting compaction...`);

    try {
      await this._tryCompaction(await this._precheckCompaction());
      console.log(`FishtrapDB@${this.appUUID}: Compaction completed.`);
    }
    catch (e) {
      if (e.message === 'no shards' || e.message === 'already locked' || e.message === 'could not lock') {
        console.log(`FishtrapDB@${this.appUUID}: Compaction cancelled, ${e.message}.`);
      }
      else {
        console.warn(`FishtrapDB@${this.appUUID}: Compaction failed, ${e.message}.`);
      }
    }

    if (this.compactionIntervalMinutes > 0) {
      this._compactionTimer = setTimeout(() => this._performCompaction(), this.compactionIntervalMinutes * 60000);
    }
  }
}

export {
  FileStats,
  FishtrapFS,
  FishtrapConfig,
  FishtrapMerger,
  FishtrapPostCompactionHook,

  FishtrapDB,
};
