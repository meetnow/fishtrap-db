//
//  types.ts
//  fishtrap-db
//
//  Created by Patrick Schneider on 06.01.2021
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

import { Immutable } from "immer";

export interface FileStats {
  size: number | string;
  mtime: Date | number;
  isFile(): boolean;
}

export interface FishtrapFS {
  join (...paths: string[]): string;
  readdir (dirpath: string): Promise<string[]>;
  stat (filepath: string): Promise<FileStats>;
  readFile (filepath: string): Promise<Uint8Array>;
  writeFile (filepath: string, contents: Uint8Array): Promise<void>;
  appendFile (filepath: string, contents: Uint8Array): Promise<void>;
  rename (oldpath: string, newpath: string): Promise<void>;
  unlink (filepath: string): Promise<void>;
}

export interface FishtrapConfig {
  appUUID: string;
  shardUUID: string;
  fs: FishtrapFS;
  baseDirectory?: string;
  compactionSizeThreshold?: number;
  compactionIntervalMinutes?: number;
  checkIntervalMinutes?: number;
}

export type FishtrapUpdater<T> = (data: T) => void | T | Promise<void | T>

export type FishtrapMerger<T> = (target: T, other: T, base: Immutable<T>) => void | T | Immutable<T> | Promise<void | T | Immutable<T>>

export type FishtrapPostCompactionHook<T> = (final: Immutable<T>, base: Immutable<T>) => void

export interface FileDescriptor {
  name: string;
  size: number;
  mtime: Date;

  uuid: string;
  generation: number;
  lockedBy?: string;
}

export interface DataBlock {
  offset: number;
  length: number;
  data?: any;
}

export interface Snapshot<T> {
  generation: number;
  data: T;
  ancestors: { [uuid: string]: number | undefined };
}

export interface Transaction {
  sequence: number;
  delta: any;
}
