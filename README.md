
fishtrap-db
===========

File-based Shared Transactional Application Database

Puns are always required.

Goals
-----

- Only require a minimum filesystem implementation (read directory, stat/read/write/append/rename/delete file)
- Work across multiple processes concurrently
- Write transaction journal for replay on crash
- Have means to recover transactions on failure
- Work with a single immutable and typesafe data structure in memory

Implementation
--------------

- We keep one central snapshot which only one process can manipulate
- Writes to the central snapshot ("compactions") are coordinated via lockfiles
- Each process has its own exclusive set of transaction logfiles
- A processes can only read foreign transaction logs, never write to them
- Each transaction gets a consecutive number (limits to 2^32 transactions)
- Each snapshot generation gets a consecutive number
- Transactions target a specific snapshot generation
- The filenames encode information about the file's contents; this information is duplicated within the file for recovery and checking

Compaction
----------

- Create lockfile, check timestamp to determine winner
- Find all transaction logs targetting the current generation, for each one replay against the unaltered data structure
- Perform a merge of each resulting data structure
- Store final data structure, including the transaction number for each process involved
- Delete own transaction log
- If no individual transaction log references past generations, delete the respective past generation file
- Delete all lockfiles targetting the past generation

Rebase
------

If a process detects that a compaction has happened and there are unprocessed transactions, it can use the old and the new snapshot to find
out what changed and create a new merging transaction of its own. This transaction is to be put in a new file targeting the newest snapshot generation. The individual process must delete its own old transaction log as soon as the write is completed.

In the best case, when no unprocessed transactions remained, it can delete the old transaction log right away. The last process to delete
its old transaction log will then delete the old snapshot.

In a worst case scenario, this rebase can happen multiple times in a row, but at no point can a transaction be truly lost due to the above
design.

Usage
-----

TODO

Caveats
-------

This database can not guarantee consistency, but availability and partition tolerance (see CAP theorem). You can only see changes made by
other processes right after compaction or rebase (which classifies this database as having "eventual consistency"). This has several
consequences for your application design, e.g. using the database to count something will require you to partition the counter values for
each process. Because at any point in time your individual process will be able to eventually see the changes made by other processes, you
can react to anything that "went wrong" and potentially revert changes. Keep in mind that this might end up in a "fight" between processes,
especially when the merge function is different.

The database is not suitable for very large data structures, since the active structure is always kept fully in memory. Transaction logs and
snapshots cannot grow past 100 MiB.

License
-------

Copyright (c) 2021 MeetNow! GmbH

Licensed under the EUPL, Version 1.2 or – as soon they will be approved by
the European Commission - subsequent versions of the EUPL (the "Licence");
You may not use this work except in compliance with the Licence.
You may obtain a copy of the Licence at:

https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12

Unless required by applicable law or agreed to in writing, software
distributed under the Licence is distributed on an "AS IS" basis,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the Licence for the specific language governing permissions and
limitations under the Licence.
