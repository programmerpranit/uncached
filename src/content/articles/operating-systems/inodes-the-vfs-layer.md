---
summary: How Unix filesystems separate names from files with inodes and directory entries, why hard links, deleted-but-open files and running out of inodes behave the way they do, and how Linux's Virtual File System lets ext4, NFS, FUSE and /proc all answer the same system calls.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** In Unix filesystems, a **file** and its **name** are separate things. The **inode** holds everything about a file except its name: type, permissions, owner, size, timestamps, a **link count**, and pointers to its data blocks (extents in modern filesystems). A **directory** is just a special file mapping **names to inode numbers**. Two names pointing to one inode are **hard links**. A file's data is freed only when its link count reaches zero **and** no process still has it open, which is why deleting a huge open log file doesn't free disk space. Above all filesystems, Linux's **Virtual File System (VFS)** defines one set of objects (superblock, inode, dentry, file) and operations. Every filesystem, whether ext4, XFS, NFS, FUSE or the purely virtual `/proc`, plugs into it, so `open`, `read` and `stat` work the same everywhere, and shared machinery (the **dentry cache** for path lookup, the inode cache, the page cache, permission checks) is written once.

## The problem: many filesystems, one API

A Linux machine might have an ext4 root filesystem, an XFS data volume, an NFS mount, a FUSE-mounted cloud bucket, `tmpfs` in `/tmp`, and kernel-generated files in `/proc` and `/sys`. Programs shouldn't care: `cat` should read any of them. And every filesystem needs the same basic services: resolving paths, checking permissions, caching data and metadata, handling locks.

Unix's answer has two layers: a simple on-disk model of **inodes and directories**, and in the kernel, a **virtual filesystem switch** that abstracts over implementations.

## Inodes and directories

![A directory /home/ana maps notes.txt and todo.txt to inode 1832 and photos/ to inode 2210. Inode 1832 holds permissions, owner, size, timestamps, link count 2 and extents pointing to data blocks.](/figures/vfs/inode.svg "The name lives in the directory. Everything else lives in the inode.")

An **inode** ("index node", from early Unix) stores a file's metadata:

- **type** (regular file, directory, symlink, device, socket, FIFO) and **permission bits**,
- **owner** UID and GID,
- **size**, and **timestamps**: `atime` (access), `mtime` (content modified), `ctime` (inode changed),
- **link count**: how many directory entries refer to it,
- **where the data is**: classic ext2/ext3 used 12 direct block pointers plus single, double and triple indirect blocks. ext4 and XFS use **extents** (start block + length), so a 1 GB contiguous file needs only a few entries.

Inodes are identified by **number** within a filesystem. `ls -i` and `stat` show them.

A **directory** is a file whose contents are entries of **(name → inode number)**. Looking up `notes.txt` in `/home/ana` means reading that directory's entries (ext4 uses a hashed B-tree, `htree`, for large directories) to find inode 1832.

### Consequences of separating names from files

- **Hard links:** `ln notes.txt todo.txt` adds another entry pointing to the same inode, and the link count becomes 2. Neither name is the "original". Hard links can't cross filesystems (inode numbers are per filesystem) and can't point to directories (to avoid cycles).
- **Symbolic links** are different: a small file whose content is a **path**, resolved at lookup time. They can cross filesystems and can dangle.
- **Deleting is unlinking:** `rm` calls `unlink()`, which removes a directory entry and decrements the link count. The inode and data are freed only when the count is 0 **and** no process has the file open. A process writing a 50 GB log that you `rm` keeps writing to it, and the space isn't reclaimed until it closes the file. `lsof +L1` lists such deleted-but-open files.
- **Renaming within a filesystem** just moves a directory entry, so it's instant and atomic regardless of file size. Moving across filesystems means copying.
- **Running out of inodes:** ext4 fixes the number of inodes at `mkfs` time. Millions of tiny files (mail spools, caches, `node_modules`) can exhaust them while plenty of space remains. `df -i` shows inode usage. XFS and Btrfs allocate inodes dynamically.
- **Permissions are on the inode,** so all hard links share them. Directory permissions control who can add, remove or look up **names**.

## The Virtual File System

![System calls go to the VFS, which handles path lookup, dentry cache, inode cache, page cache, permissions and locks, then calls into filesystems: ext4, XFS, Btrfs (on disk), NFS and FUSE (network and user space), procfs, tmpfs and overlayfs (virtual).](/figures/vfs/vfs-layer.svg "A filesystem is a set of callbacks the VFS invokes.")

The Linux VFS (similar designs exist in the BSDs, Solaris and Windows) defines four core in-memory objects:

- **superblock:** a mounted filesystem instance, with its operations (`super_operations`: allocate and write inodes, sync, report usage).
- **inode:** an in-memory file object, with `inode_operations` (lookup, create, link, unlink, mkdir, rename, permission).
- **dentry:** a cached **directory entry** linking a name in a parent directory to an inode. Dentries form the in-memory tree used for path lookup.
- **file:** an **open file**, with a current offset, open flags, and `file_operations` (read, write, mmap, ioctl, fsync, poll).

A filesystem implements these operations. ext4 reads and writes disk blocks. NFS turns them into RPCs to a server. FUSE forwards them to a user-space daemon (sshfs, rclone, s3fs). **procfs** and **sysfs** generate contents on the fly from kernel data structures, so `/proc/<pid>/status` is produced fresh on every read. **overlayfs** stacks layers of other filesystems, which is how container images work.

That's the practical meaning of "everything is a file": anything that implements `file_operations` can be opened, read, written and polled with the same calls.

### File descriptors, open files and inodes

![Process A has fd 3 and fd 4 (a dup) pointing to open file #1 with offset 4096, and fd 5 pointing to open file #2 with offset 0. Forked process B's fd 3 also points to open file #1. Both open files point to inode 1832.](/figures/vfs/descriptors.svg "Three levels of indirection, each with different sharing rules.")

- A **file descriptor** is an index into the process's **fd table**.
- Each entry points to an **open file description** (the VFS `file`), which holds the **offset** and flags.
- That points to the **inode**.

`dup()` and `fork()` copy fd table entries, so both point to the **same** open file description and share its offset: two processes appending through it won't overwrite each other. Calling `open()` twice creates two descriptions with independent offsets. Permission checks happen at **`open()`**, so an fd stays usable after a `chmod`, and can be passed to another process over a Unix domain socket (`SCM_RIGHTS`) as a capability.

### Path lookup and the dentry cache

![Resolving /home/ana/notes.txt: root dentry cached; home and ana are dentry cache hits; notes.txt is a miss, so ext4 reads the directory block and finds inode 1832.](/figures/vfs/lookup.svg "Most path components are resolved from memory.")

Resolving a path walks it one component at a time. At each step the VFS:

1. checks **search (execute) permission** on the current directory,
2. looks up `(parent dentry, name)` in the **dentry cache (dcache)**, a hash table of recently used names, including **negative dentries** that remember "this name doesn't exist" (great for `PATH` searches and build systems probing many files),
3. on a miss, asks the filesystem's `lookup()` to read the directory and creates a dentry,
4. crosses **mount points** and follows **symlinks** as needed.

Since Linux 2.6.38, the common case runs in **RCU-walk** mode, without taking locks or reference counts, so path lookup scales across many cores. Both the dcache and the inode cache are reclaimable memory, part of what `free` reports as cache.

## Where it's used

| Thing | How it relies on inodes / VFS |
| --- | --- |
| **Container images** | overlayfs stacks read-only image layers with a writable layer |
| **`/proc`, `/sys`, cgroupfs** | Kernel state exposed as virtual files |
| **FUSE (sshfs, rclone, s3fs)** | User-space filesystems behind the same API |
| **Backup and dedup tools** (rsync `-H`, restic) | Detect hard links via inode numbers |
| **Build systems** (Make, Bazel) | Rely on `stat` timestamps and fast negative dentries |
| **Log rotation** | Rename the log and signal the writer to reopen, or `copytruncate` |
| **Atomic deploys** | Swap a symlink or rename a directory to switch versions instantly |

### Use case walk-through: "disk full" but `du` says it's not

A server alerts that `/var` is 100% full, but `du -sh /var` adds up to only 40% of the volume.

1. **Suspect deleted-but-open files.** `lsof +L1 /var` shows a 30 GB `app.log (deleted)` still open by the application.
2. **What happened.** Log rotation `rm`ed the file, removing its name. The app kept its fd and kept writing. The link count is 0, but the inode and blocks stay allocated until the fd is closed. `du` walks names, so it can't see them, while `df` counts blocks.
3. **Immediate fix.** Restart or signal the app to reopen its log (many daemons reopen on `SIGHUP` or `SIGUSR1`). In an emergency, truncate through the fd: `: > /proc/<pid>/fd/<n>`.
4. **Permanent fix.** Configure logrotate to rename the file and signal the app (`postrotate`), or use `copytruncate` for apps that can't reopen. Or log to stdout and let the system journal handle rotation.
5. **Also check inodes.** `df -i` showed 92% inode usage from a cache directory with millions of tiny files. They added cleanup and moved the cache to XFS.

## Pitfalls

- **Assuming `rm` frees space immediately**: not while a process has the file open.
- **Running out of inodes** on ext4 with millions of small files. Check `df -i`.
- **Assuming file names are unique identifiers**: hard links give one file many names, and renames change names without changing the file. Use (device, inode) when you need identity, and remember inode numbers are reused after deletion.
- **Relying on `atime`**: most systems mount with `relatime` or `noatime`, so access times are only updated occasionally.
- **Treating network or FUSE filesystems like local ones**: different consistency, locking, `rename` and `fsync` semantics.
- **Huge directories on filesystems without indexed directories**, which makes lookups slow.

> [!TIP]
> `stat <file>` shows the inode number, link count, blocks and all three timestamps. `findmnt` shows what filesystem backs each path, and `cat /proc/self/mountinfo` shows it with mount options.

## Discussion questions

1. Why can renaming a 100 GB file be instant, while moving it to another disk takes minutes?
2. What happens to a file's data when it has two hard links and you delete one?
3. Why can't hard links point to directories?
4. How does the VFS let `cat /proc/meminfo` work, even though no such file exists on disk?
5. Why do `dup()` and `fork()` share a file offset, while two `open()` calls don't?
6. How do negative dentries speed up running commands from `PATH`?

## FAQ

### What's the difference between a hard link and a symbolic link?

A **hard link** is another directory entry for the same inode: same file, same permissions, same data, and it works even if the "original" name is deleted. A **symlink** is a separate small file containing a path that's resolved at access time. It can point anywhere (even across filesystems or to nothing) and breaks if the target moves.

### Where's the file name stored if not in the inode?

Only in directory entries. That's why one inode can have several names, and why finding all names of an inode requires scanning directories (`find -inum`).

### Do all filesystems have inodes?

Not on disk. FAT and exFAT store metadata in directory entries, and network filesystems store it on the server. But the Linux VFS always creates in-memory inode objects, so every file looks like it has one, with an inode number synthesized if necessary.

### What's the difference between mtime and ctime?

`mtime` changes when the file's **contents** are modified. `ctime` changes when the **inode** changes: contents, permissions, ownership, link count or rename. You can set `mtime` with `touch`, but not `ctime`, which makes `ctime` useful for detecting tampering. Neither is a creation time. Linux exposes creation time as **birth time** via `statx`, where the filesystem supports it.

### What is FUSE and why is it slower?

**Filesystem in Userspace**: a kernel module that forwards VFS operations to a user-space process over `/dev/fuse`. It makes writing filesystems easy (and safe from kernel crashes), but every operation crosses the user/kernel boundary twice and involves extra copies, so metadata-heavy workloads are noticeably slower than in-kernel filesystems.

## Key takeaways

- An **inode** holds a file's metadata and data location. **Directories** map **names → inode numbers**.
- **Hard links** are multiple names for one inode. Data is freed at **link count 0 and no open fds**.
- The **VFS** defines superblock, inode, dentry and file objects. Every filesystem, real or virtual, implements their operations.
- **fd → open file description (offset) → inode**: `dup`/`fork` share offsets, separate `open`s don't.
- The **dentry cache** (with negative entries and RCU-walk) makes path lookup fast.

## References

1. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapters 39–40: [Files and Directories](https://pages.cs.wisc.edu/~remzi/OSTEP/file-intro.pdf) and [File System Implementation](https://pages.cs.wisc.edu/~remzi/OSTEP/file-implementation.pdf).
2. Linux kernel docs. [Overview of the Linux Virtual File System](https://docs.kernel.org/filesystems/vfs.html).
3. Linux kernel docs. [Pathname lookup](https://docs.kernel.org/filesystems/path-lookup.html).
4. Linux kernel docs. [ext4 Data Structures and Algorithms](https://docs.kernel.org/filesystems/ext4/index.html).
5. D. Ritchie, K. Thompson. [The UNIX Time-Sharing System](https://dsf.berkeley.edu/cs262/unix.pdf). *CACM*, 1974.
6. Linux man pages. [inode(7)](https://man7.org/linux/man-pages/man7/inode.7.html), [link(2)](https://man7.org/linux/man-pages/man2/link.2.html), [unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html), [statx(2)](https://man7.org/linux/man-pages/man2/statx.2.html).
7. B. Vangoor, V. Tarasov, E. Zadok. [To FUSE or Not to FUSE: Performance of User-Space File Systems](https://www.usenix.org/conference/fast17/technical-sessions/presentation/vangoor). *FAST 2017*.
