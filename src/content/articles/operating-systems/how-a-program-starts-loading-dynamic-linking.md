---
summary: What happens between typing ./app and the first line of main(), including how the kernel maps an ELF file, how the dynamic loader finds shared libraries and resolves symbols through the PLT and GOT, and why "GLIBC_2.34 not found", LD_PRELOAD and static Go binaries work the way they do.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** When a shell runs `./app`, it calls **`execve()`**. The kernel reads the **ELF** header, replaces the process's address space with the file's **loadable segments** (code read+execute, data read+write), builds a new **stack** holding `argv`, `envp` and the **auxiliary vector**, and, if the binary is dynamically linked, starts the **dynamic loader** named in its `PT_INTERP` header (`/lib64/ld-linux-x86-64.so.2` on x86-64 glibc systems) instead of the program. The loader **finds and maps every shared library** listed as `DT_NEEDED` (using `RPATH`/`RUNPATH`, `LD_LIBRARY_PATH` and `/etc/ld.so.cache`), applies **relocations**, resolves symbols (immediately, or lazily on first call through the **PLT**, which updates the **GOT**), runs **constructors**, and jumps to `_start`, which calls `__libc_start_main`, which calls `main`. Shared libraries are mapped once in RAM and shared by every process, and **ASLR** puts everything at random addresses. **Static** binaries skip the loader entirely: bigger files, no runtime dependency problems, and no shared security updates.

## The problem: a file on disk isn't a running program

An executable on disk is a recipe: machine code, initialized data, a list of libraries it needs, and placeholders for addresses it doesn't know yet (where `printf` lives, where its own globals end up). To run it, something must:

- create an address space with the code and data at the right places, with the right permissions,
- provide a stack with the command-line arguments and environment,
- load the shared libraries it depends on, and connect calls to their functions,
- run initialization code before `main`.

That work is split between the kernel, the dynamic loader (user space) and the C runtime.

## From execve() to main()

![Seven steps: the kernel handles execve, maps segments and starts the interpreter; the dynamic loader loads libraries, relocates and binds symbols, and runs initializers; libc's _start calls __libc_start_main, which calls main.](/figures/program-start/steps.svg "Most of the work happens in user space, in the dynamic loader.")

### 1. The kernel: execve

`execve(path, argv, envp)` replaces the current process image (usually right after `fork()`):

1. Check permissions, and identify the format. ELF binaries start with `\x7fELF`. Scripts starting with `#!` are handled by running the named interpreter instead. Other formats can be registered with `binfmt_misc` (which is how Docker runs foreign-architecture images through QEMU).
2. Read the ELF **program headers**. Each `PT_LOAD` segment says which part of the file to map where, with which permissions. Typically `.text` and `.rodata` are mapped read-only and executable or read-only, and `.data` and `.bss` read-write (`.bss` is zero-filled, not stored in the file).
3. Tear down the old address space and **map the segments** (lazily, so pages are read on first touch).
4. Build the **initial stack**: `argc`, the `argv` and `envp` pointer arrays and strings, and the **auxiliary vector** (`auxv`): the program's entry point, where its headers are, the page size, 16 random bytes for stack canaries (`AT_RANDOM`), and the address of the **vDSO**.
5. If there's a **`PT_INTERP`** header, map that interpreter (the dynamic loader) too, and start executing at **its** entry point. Otherwise start at the program's entry point (`_start`).

### 2. The dynamic loader: ld.so

The loader (`ld-linux-x86-64.so.2` for glibc, `ld-musl-*.so.1` for musl) is itself a shared library that relocates itself first, then:

1. **Finds dependencies.** It reads the program's `DT_NEEDED` entries (`libc.so.6`, `libssl.so.3`, ...) and, recursively, theirs. For each name it searches, in order: the binary's `DT_RPATH` (legacy), `LD_LIBRARY_PATH`, `DT_RUNPATH`, the cache in `/etc/ld.so.cache` (built by `ldconfig`), then default directories like `/lib` and `/usr/lib`.
2. **Maps each library** with `mmap`, at a random base address. Code pages are file-backed and shared with every other process using the same library.
3. **Relocates.** Shared libraries and position-independent executables (PIE) are compiled to work at any address. Relocation records tell the loader which pointers to adjust by the base address, and which ones need a **symbol lookup**.
4. **Resolves symbols** by searching loaded objects in order. The first definition wins, which is what makes `LD_PRELOAD` interposition possible.
5. **Sets up thread-local storage** and runs **initializers**: `.init_array` entries, C++ global constructors and `__attribute__((constructor))` functions, dependencies first.
6. Jumps to the program's `_start`.

### 3. The C runtime: _start to main

`_start` (from `crt1.o`) sets up the initial frame and calls `__libc_start_main`, which initializes libc (stdio, locale, security checks), registers cleanup, calls `main(argc, argv, envp)`, and passes its return value to `exit()`, which runs `atexit` handlers and destructors and flushes stdio.

## The resulting address space

![From high to low addresses: stack, vdso, the dynamic loader, libssl, libc, the mmap region growing down, the heap growing up, .data/.bss, .rodata and .text, each with permissions.](/figures/program-start/layout.svg "Every library appears in every process, but its code pages exist once in RAM.")

`cat /proc/<pid>/maps` shows this for any running process. With **ASLR**, the stack, heap, mmap area, libraries and (for PIE executables, now the default on most distributions) the program itself are placed at random addresses on every run, so exploits can't hardcode addresses.

## Calling into a shared library: PLT and GOT

![The app calls puts@plt; the PLT stub jumps through GOT[puts]; after binding the GOT entry holds the real address of puts in libc; before binding it points to the ld.so resolver, which patches the GOT on first call.](/figures/program-start/plt-got.svg "Code stays read-only and shared. Only a small table of addresses is written per process.")

The program's code can't contain `puts`' address, which isn't known until load time, and patching the code would make it unshareable. Instead:

- Calls go to a small stub in the **Procedure Linkage Table (PLT)**: `call puts@plt`.
- The stub jumps through an entry in the **Global Offset Table (GOT)**, a per-process writable table of addresses.
- With **lazy binding**, the GOT entry initially points back into the loader's resolver. The first call resolves `puts`, writes its address into the GOT, and jumps to it. Later calls go straight through.
- With **immediate binding** (`-z now`, `LD_BIND_NOW=1`), all symbols are resolved at startup. Combined with **full RELRO**, the loader then makes the GOT read-only, so an attacker can't overwrite GOT entries to hijack calls. Many distributions build with full RELRO by default.

Global variables in libraries are accessed through the GOT similarly.

### dlopen: loading at runtime

Programs can also load libraries on demand with `dlopen()` and look up symbols with `dlsym()`. Plugins, Python C extensions, JVM native libraries and database extensions (PostgreSQL's `.so` modules) all work this way, using the same loader machinery.

## Static vs dynamic linking

![Table: static linking starts faster, makes bigger binaries, gives each process its own copy, needs rebuilding for security updates and runs anywhere; dynamic linking needs the loader, makes small binaries, shares libc in RAM, updates libraries once and needs matching library versions.](/figures/program-start/static-vs-dynamic.svg "Containers changed the calculus, but not the trade-offs.")

- **Dynamic linking** (the default for C and C++ on Linux): small binaries, shared memory, and a fixed security bug in OpenSSL or libc is fixed for every program by updating one file. The cost is **dependency management**: the binary only works with compatible library versions present.
- **Static linking** copies library code into the binary: no loader, no missing-library errors, faster startup. Go links statically by default (unless cgo is used), and Rust can target musl for fully static binaries. But every binary must be rebuilt to pick up library fixes. glibc doesn't fully support static linking for features like NSS (user and host lookups) and `dlopen`, which is why fully static Linux binaries usually use **musl**.

### Symbol versioning and "GLIBC_2.34 not found"

glibc keeps old behavior available by **versioning** symbols: a binary records that it needs, say, `memcpy@GLIBC_2.14`. A binary built on a newer system may reference symbols that only exist in newer glibc versions, so running it on an older system fails with `version 'GLIBC_2.34' not found`. glibc is backward compatible (old binaries run on new systems) but not forward compatible. The usual fix is to build on the **oldest** system you need to support (the idea behind Python's manylinux wheels), or link statically with musl.

## Where it's used

| Thing | Mechanism |
| --- | --- |
| **`LD_PRELOAD`** | Load a library first so its symbols win: allocators (jemalloc, tcmalloc), debugging and profiling shims |
| **`ldd` / `readelf -d`** | Show a binary's needed libraries and its RPATH/RUNPATH |
| **Python manylinux wheels** | Built against an old glibc baseline so they run on most distributions |
| **Distroless / scratch images** | Static binaries or carefully copied libraries plus the loader |
| **Security hardening** | PIE + ASLR, full RELRO, stack canaries from `AT_RANDOM` |
| **Plugins** | `dlopen`/`dlsym` for runtime-loaded modules |

### Use case walk-through: "No such file or directory" for a file that exists

A team copies a Go-with-cgo binary into an Alpine-based container. Running it fails with `exec ./app: no such file or directory`, though `ls -l ./app` shows it's there and executable.

1. **Inspect the interpreter.** `readelf -l ./app | grep interpreter` shows `/lib64/ld-linux-x86-64.so.2`, the glibc loader. Alpine uses musl and doesn't have that file. The kernel's `execve` failed to open the **interpreter**, and reported `ENOENT`.
2. **Options.** Build with `CGO_ENABLED=0` for a fully static Go binary, build inside an Alpine image so it links against musl, or use a glibc-based base image (Debian slim, distroless).
3. **They chose static.** `CGO_ENABLED=0` plus the pure-Go DNS resolver gives a binary with no interpreter at all (`readelf -l` shows no `PT_INTERP`), which runs in a `FROM scratch` image.
4. **Gotcha.** The static binary also needs CA certificates and time zone data, which used to come from the OS. Copy `/etc/ssl/certs` into the image, and embed zoneinfo with Go's `time/tzdata` package.

## Pitfalls

- **Running `ldd` on untrusted binaries**: with some loaders, `ldd` works by running the binary's loader with special variables, which can execute code. Use `readelf -d` or `objdump -p` instead.
- **Relying on `LD_LIBRARY_PATH`** in production. It's fragile, and ignored for setuid programs. Prefer `RUNPATH` (for example `$ORIGIN/../lib`) or proper packaging.
- **Building on a new distribution, deploying on an old one** (glibc symbol versions).
- **Expensive global constructors** in many shared libraries slow startup, and initialization order across libraries is hard to control.
- **Symbol interposition surprises**: two libraries defining the same symbol, where the first loaded wins.
- **Assuming static linking means no dependencies**: you still depend on the kernel ABI, and often on files like CA certificates, `/etc/passwd` and time zone data.

> [!TIP]
> `LD_DEBUG=libs ./app` makes the glibc loader print how it searches for each library, and `LD_DEBUG=bindings` shows every symbol binding. `LD_DEBUG=statistics` prints how long relocation took.

## Discussion questions

1. Why does the kernel start the dynamic loader instead of the program itself?
2. How do the PLT and GOT let library code stay shared and read-only?
3. What does full RELRO protect against, and what does it cost?
4. Why does a binary built on Ubuntu 24.04 fail on CentOS 7, but not the other way around?
5. What are the trade-offs of static linking in a container world?
6. How does `LD_PRELOAD` let you replace `malloc` without recompiling?

## FAQ

### What's the difference between the dynamic linker and the dynamic loader?

On Linux they're the same program, `ld.so` (`ld-linux*.so`). It loads libraries and links symbols at runtime. The **static linker** (`ld`, `lld`, `mold`) runs at build time and produces the executable.

### What's a position-independent executable (PIE)?

An executable compiled like a shared library, so it can be loaded at any address. That lets ASLR randomize the program's own code location, not just libraries'. Most distributions now build PIE by default.

### Why does `main` receive `envp`?

The environment is part of what `execve` passes to the new program, on its stack next to `argv`. libc also exposes it as the global `environ`, and `getenv` reads from it.

### What is the vDSO in the address space?

A small shared library the kernel maps into every process (announced through the auxiliary vector), with fast implementations of calls like `clock_gettime` that don't need to enter the kernel.

### How do scripts with #! run?

The kernel sees `#!` at the start of the file, and runs the named interpreter with the script path as an argument, as if you'd typed `/usr/bin/python3 script.py`. The interpreter itself is an ELF binary that goes through the normal loading process.

## Key takeaways

- **`execve`**: the kernel maps the ELF's `PT_LOAD` segments, builds the stack (`argv`, `envp`, `auxv`), and starts the **interpreter** from `PT_INTERP`.
- The **dynamic loader** finds `DT_NEEDED` libraries, maps them (shared, ASLR-randomized), **relocates**, binds symbols, and runs constructors.
- Library calls go through the **PLT and GOT**. Lazy or immediate binding, and **RELRO** makes the GOT read-only.
- **Static** binaries skip the loader: portable and fast to start, but rebuilt for every library fix.
- Many startup failures are loader problems: missing interpreter, missing libraries, or **glibc symbol versions**.

## References

1. D. Drysdale. [How programs get run: ELF binaries](https://lwn.net/Articles/631631/). *LWN*, 2015.
2. U. Drepper. [How To Write Shared Libraries](https://www.akkadia.org/drepper/dsohowto.pdf). 2011.
3. Linux man pages. [execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html), [ld.so(8)](https://man7.org/linux/man-pages/man8/ld.so.8.html), [elf(5)](https://man7.org/linux/man-pages/man5/elf.5.html), [getauxval(3)](https://man7.org/linux/man-pages/man3/getauxval.3.html).
4. I. L. Taylor. [Linkers](https://www.airs.com/blog/archives/38) (20-part blog series). 2007.
5. J. Levine. *Linkers and Loaders*. Morgan Kaufmann, 1999.
6. PyPA. [PEP 600: Future 'manylinux' Platform Tags](https://peps.python.org/pep-0600/).
7. System V Application Binary Interface. [AMD64 Architecture Processor Supplement](https://gitlab.com/x86-psABIs/x86-64-ABI).
