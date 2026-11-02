---
summary: Why a power cut in the middle of a write can corrupt a filesystem, how journaling makes multi-block updates atomic, what fsync actually guarantees (and costs), and how to write files and logs so they survive crashes.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** One logical change, such as appending a block to a file, updates **several places on disk**: the free-space bitmap, the inode, and the data block. Disks only make single-sector writes atomic and may reorder writes, so a crash in the middle leaves the filesystem **inconsistent**. Old filesystems needed a full **fsck** scan after every crash. **Journaling** filesystems (ext3/ext4, XFS, NTFS) first write the changes to a **journal**, then a **commit record**, then apply them in place. After a crash, they **replay** committed transactions and discard incomplete ones in seconds. Copy-on-write filesystems (ZFS, Btrfs) get the same atomicity by never overwriting live data. But journaling protects the **filesystem's structure**, not your data: `write()` only reaches the page cache, and only **`fsync()`** (or `fdatasync`, `O_DSYNC`) waits until data is on stable storage, including the drive's own cache. `fsync` costs from tens of microseconds (SSDs with power-loss protection) to milliseconds, so databases **batch** commits. To replace a file safely: write a temp file, `fsync` it, `rename` it over the old one, then `fsync` the directory.

## The problem: one change, many writes

![Appending a block updates the bitmap, the inode and the data block. If only some of the writes reach disk before a crash, the file can point at garbage, space can leak, or contents can be wrong.](/figures/journaling/crash.svg "Each partial outcome is a different kind of corruption.")

Appending 4 KiB to a file requires:

1. **Allocation bitmap:** mark the new block as used.
2. **Inode:** increase the file size and add a pointer to the block.
3. **Data block:** the bytes themselves.

The kernel sends these writes to the device in some order, the device may reorder them again, and power can fail at any moment. Depending on which writes landed, you can get a file pointing at someone else's old data (a security problem, not just corruption), leaked space, or blocks claimed by two files.

Before journaling, filesystems like ext2 ran **fsck** after an unclean shutdown: scan every inode and bitmap to find and repair inconsistencies. On large disks, that took hours.

## Journaling

![A circular journal holding a transaction begin record, bitmap, inode and data blocks, and a commit record; checkpointing copies them into the main filesystem area.](/figures/journaling/journal.svg "Log the change, commit it, then apply it. Recovery only reads the log.")

**Write-ahead journaling** (the same idea as a database's write-ahead log):

1. **Journal write:** write the blocks that will change (or descriptions of the changes) into a reserved log area, framed by a transaction-begin record.
2. **Commit:** once those writes are durable, write a **commit record**. The transaction is now committed. The filesystem uses cache **flushes** or **FUA** (force unit access) writes so the commit can't reach the disk before the data it covers.
3. **Checkpoint:** write the blocks to their real locations, at leisure.
4. **Free:** once checkpointed, the journal space can be reused.

**Recovery** after a crash: scan the journal, **replay** every transaction with a commit record (replay is idempotent, so doing it twice is harmless), and ignore transactions without one. It takes seconds regardless of disk size.

To keep it fast, filesystems **batch** many operations into one transaction (ext4 commits every 5 seconds by default, or sooner on `fsync`), and many journal only **metadata**.

### What gets journaled

![ext4 modes: data=journal journals metadata and data and writes data twice; data=ordered (default) journals metadata and writes data before its metadata commits; data=writeback journals metadata only, fastest but may expose stale data.](/figures/journaling/modes.svg "The default, ordered mode, avoids exposing garbage without writing data twice.")

- **ext4 `data=journal`:** data and metadata both go through the journal. Strongest, but every data block is written twice.
- **ext4 `data=ordered` (default):** only metadata is journaled, but data blocks are written **before** the metadata transaction that points to them commits. After a crash, a file never points at garbage. Its new contents may just be missing.
- **ext4 `data=writeback`:** only metadata is journaled, with no ordering. Fastest, but files may contain stale data after a crash.
- **XFS** journals metadata (logically, as operations rather than whole blocks).
- **ZFS and Btrfs** are **copy-on-write**: new data and metadata go to new locations, and a single root pointer update switches to the new tree atomically. ZFS adds a separate intent log (ZIL) to make synchronous writes fast.

## fsync: making your data durable

Journaling keeps the filesystem consistent. It does **not** mean your recent writes survive a crash:

- `write()` copies data into the **page cache** and returns. It might reach the disk 5–30 seconds later.
- Even when the OS writes it, the drive may hold it in a **volatile write cache**.

**`fsync(fd)`** makes the file's data and metadata durable: it writes dirty pages, commits the journal transaction, and issues a **cache flush** to the device, then waits. Variants:

- **`fdatasync(fd)`** skips metadata that isn't needed to read the data (like modification times), often saving a journal write.
- **`O_SYNC` / `O_DSYNC`** make every `write` behave like `write` + `fsync`/`fdatasync`.
- **`sync_file_range`** starts writeback but does **not** guarantee durability (no metadata, no cache flush).
- On **macOS**, `fsync` doesn't flush the drive's cache. You need `fcntl(fd, F_FULLFSYNC)`.

### The directory matters too

Creating or renaming a file changes the **directory**, which is a separate file. To make a new file's existence durable, you need to `fsync` the **directory** as well.

### Atomic file replacement

![Four steps: write config.json.tmp; fsync the temp file; rename temp over config.json; fsync the directory.](/figures/journaling/atomic-replace.svg "rename makes the switch atomic for readers. The two fsyncs make it durable across crashes.")

To update a config or state file so that readers and crashes see either the old version or the complete new one:

1. Write the new contents to a temp file **in the same directory** (same filesystem).
2. `fsync` the temp file.
3. `rename(tmp, final)`: atomic replacement on POSIX filesystems.
4. `fsync` the directory.

In 2009, ext4's **delayed allocation** exposed applications that skipped step 2: after crashes, users found **zero-length** config files, because the rename was committed before the data was written. ext4 added a heuristic to flush data on rename-over, but correct applications shouldn't rely on it.

### What fsync costs

`fsync` waits for the slowest part of the stack:

- **SSDs with power-loss protection** (most datacenter drives) can acknowledge a flush from their capacitor-backed cache: tens of microseconds.
- **Consumer SSDs** without it must actually write to flash: often **milliseconds**.
- **Hard disks:** several milliseconds or more.

That's why databases use **group commit**: many transactions append to the write-ahead log, and a single `fsync` makes all of them durable. PostgreSQL, MySQL and SQLite all do this. Some systems relax durability on purpose: Postgres `synchronous_commit = off` risks losing the last few hundred milliseconds of commits (but not corruption), and Kafka relies on **replication** across brokers rather than `fsync` per message.

### When fsync fails

If writeback fails (a disk error, a full thin-provisioned volume), Linux reports the error to `fsync`, but may mark the pages clean anyway. A retry can then succeed without the data ever being written. PostgreSQL discovered this in 2018 ("fsyncgate") and now treats `fsync` failure as fatal: it crashes and recovers from its WAL. Research (Rebello et al., USENIX ATC 2020) found many applications mishandle fsync failures in similar ways.

## Where it's used

| System | Crash-consistency approach |
| --- | --- |
| **ext4** | Metadata journal (JBD2), `data=ordered` by default |
| **XFS** | Logical metadata journal |
| **ZFS / Btrfs** | Copy-on-write trees with atomic root updates. ZFS intent log for sync writes |
| **NTFS / APFS** | NTFS journals metadata. APFS is copy-on-write |
| **PostgreSQL, MySQL InnoDB** | Their own write-ahead log + group commit `fsync`, plus a doublewrite buffer in InnoDB against torn pages |
| **SQLite** | Rollback journal or WAL file, with carefully ordered `fsync`s |
| **etcd, Raft logs** | `fsync` each batch before acknowledging, since durability is part of consensus correctness |

### Use case walk-through: lost writes after a power outage

An IoT gateway stores sensor readings in a custom append-only file. After a site power failure, the last 20 seconds of data are gone, and one file's tail contains zeros.

1. **Why data was lost.** The app called `write()` but never `fsync`, so data lived in the page cache until periodic writeback. The outage hit before it.
2. **Why zeros.** The file size (metadata) had been committed, but the data blocks hadn't been written yet. The app's records need checksums to detect this.
3. **Fix durability.** Batch readings and `fdatasync` once per second (or per batch). That bounds loss to one batch at a cost of one flush per second.
4. **Fix detection.** Add a length and CRC to each record. On startup, scan from the end and truncate any partial or corrupt tail, the same way database WALs recover.
5. **Check the hardware.** The SD card ignored flush commands, so even `fsync` wasn't fully reliable. They switched to industrial storage with power-loss protection.

## Pitfalls

- **Assuming `write()` or `close()` means durable.** Neither does.
- **Forgetting to `fsync` the directory** after creating or renaming files.
- **Renaming without `fsync`ing the new file first**, causing empty or partial files after a crash.
- **Retrying `fsync` after an error** and trusting success.
- **Calling `fsync` per small write** on slow devices. Batch with group commit.
- **Trusting consumer hardware** to honor flushes, or forgetting `F_FULLFSYNC` on macOS.
- **No checksums** in your own file formats, leaving torn writes undetectable.

> [!TIP]
> To see how often a process syncs and how long it takes, run `strace -T -e trace=fsync,fdatasync -p <pid>`. To test crash safety, tools like **ALICE** (from the OSDI 2014 paper) and `dm-log-writes` replay possible crash states of your application's I/O.

## Discussion questions

1. Why does appending one block need a transaction at all?
2. What does `data=ordered` guarantee that `data=writeback` doesn't, and what does neither guarantee?
3. Why must the commit record be written only after the journal blocks are durable?
4. Walk through what can go wrong if you skip each step of the atomic-replace sequence.
5. How does group commit make databases fast despite `fsync` costing milliseconds?
6. Why is retrying a failed `fsync` dangerous on Linux?

## FAQ

### Does journaling make fsck unnecessary?

Mostly. After a crash, journal replay restores consistency in seconds. fsck is still useful after hardware errors, bugs or bit rot, which journaling doesn't protect against. Checksumming filesystems (ZFS, Btrfs) detect such corruption on read.

### Is `rename()` really atomic?

On POSIX local filesystems, yes for visibility: at any moment, the target name refers to either the old or the new file. Durability of the rename still requires `fsync` on the directory. Some network filesystems give weaker guarantees.

### Why not just mount with `sync`?

Every write would wait for the disk, which is very slow for normal workloads. It's better to let applications decide which data needs `fsync`, and when.

### What's a torn write?

A write of a larger block (say a 16 KiB database page) that's only partly on disk after a crash, because the device only guarantees atomicity for smaller units. Databases detect torn pages with checksums and repair them from the WAL (PostgreSQL's full-page writes) or a doublewrite buffer (InnoDB).

### Do SSDs need journaling?

Yes. SSDs have their own internal mapping layers, but from the filesystem's point of view, multi-block updates still aren't atomic, and volatile caches still exist. Datacenter SSDs with power-loss protection make flushes fast, not unnecessary.

## Key takeaways

- One filesystem operation touches **several blocks**. Crashes in between cause **inconsistency**.
- **Journaling** logs changes, commits them, then applies them. Recovery **replays** committed transactions in seconds. **Copy-on-write** filesystems get the same effect by never overwriting.
- Journaling protects the **filesystem**, not your **data**. Use **`fsync`/`fdatasync`** for durability, including on **directories** after create or rename.
- Replace files with **write temp → fsync → rename → fsync dir**.
- `fsync` is slow on many devices: **batch** with group commit, and treat **fsync errors** as fatal.

## References

1. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapter 42: [Crash Consistency: FSCK and Journaling](https://pages.cs.wisc.edu/~remzi/OSTEP/file-journaling.pdf).
2. T. S. Pillai et al. [All File Systems Are Not Created Equal: On the Complexity of Crafting Crash-Consistent Applications](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai). *OSDI 2014*.
3. A. Rebello et al. [Can Applications Recover from fsync Failures?](https://www.usenix.org/conference/atc20/presentation/rebello) *USENIX ATC 2020*.
4. Linux kernel docs. [ext4 data mode](https://docs.kernel.org/admin-guide/ext4.html) and [Journal (jbd2)](https://docs.kernel.org/filesystems/ext4/journal.html).
5. Linux man pages. [fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html), [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html).
6. J. Corbet. [PostgreSQL's fsync() surprise](https://lwn.net/Articles/752063/). *LWN*, 2018.
7. J. Corbet. [ext4 and data loss](https://lwn.net/Articles/322823/). *LWN*, 2009.
8. SQLite docs. [Atomic Commit In SQLite](https://www.sqlite.org/atomiccommit.html).
