---
summary: What happens between pressing the power button and getting a login prompt. Covers the firmware's job, legacy BIOS vs UEFI, bootloaders, how the kernel brings itself up, why the initramfs exists, how systemd starts services in parallel as PID 1, and how Secure Boot and measured boot build a chain of trust.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Booting is a relay. Each stage initialises a bit more of the machine and hands control to the next:
>
> 1. **Firmware** (UEFI, or legacy BIOS) runs from flash at a fixed reset address. It trains RAM, enumerates devices, and finds something to boot.
> 2. A **bootloader** (GRUB, systemd-boot) picks a kernel and loads it, together with an **initramfs**.
> 3. The **kernel** decompresses itself, switches on paging, brings up the other CPUs and probes drivers.
> 4. The kernel runs `/init` from the initramfs. Its job is to find, unlock and mount the real root filesystem (LVM, RAID, LUKS, network storage), then `switch_root` to it.
> 5. There, **PID 1** (systemd on most distros) starts services **in parallel**, ordered by declared dependencies, until it reaches the target state.
>
> UEFI replaced the 512-byte MBR boot sector with firmware that reads FAT partitions and runs `.efi` programs. It also added **Secure Boot**: each stage verifies the next stage's signature. With a **TPM**, **measured boot** records a hash of each stage, so secrets like disk encryption keys are released only if the chain is untampered. Boot time is mostly firmware on servers and mostly userspace on desktops. `systemd-analyze` shows where it goes.

## The problem: a computer starts knowing almost nothing

At power-on, the CPU has no RAM configured, no idea what disks exist, no filesystem driver and no operating system. On x86 it is in a 16-bit mode and fetches its first instruction from a fixed address near the top of the 4 GiB space, which the chipset maps to firmware flash. Everything after that is bootstrapping: using a small amount of capability to load a larger one. The term comes from "pulling yourself up by your bootstraps".

## How it works

![Boot chain from firmware to bootloader, kernel, initramfs, systemd and finally login or the workload](/figures/boot/chain.svg "Six handoffs between power and a usable system.")

### 1. Firmware

The firmware is UEFI on almost all modern machines, often with a legacy-BIOS compatibility mode. It:

- runs on-chip init (on x86, microcode and the Intel ME or AMD PSP come up even earlier);
- **trains memory**, which on servers with many DIMMs can take tens of seconds;
- enumerates PCIe devices and runs option ROMs (RAID controllers, NICs for PXE);
- picks a boot target from its configured order.

### Legacy BIOS vs UEFI

![Comparison of legacy BIOS and UEFI boot: what is loaded, partition scheme, CPU mode, boot entries and verification](/figures/boot/bios-uefi.svg "UEFI firmware understands filesystems; BIOS only understands sector 0.")

- **BIOS** loads the first 512-byte sector (the MBR) into memory at `0x7C00` and jumps to it in 16-bit real mode. That's 446 bytes of code, so bootloaders chain-load: a tiny stage in the MBR loads a larger stage from the gap after it, which then reads the filesystem.
- **UEFI** reads a FAT-formatted **EFI System Partition (ESP)** and executes a PE binary such as `\EFI\BOOT\BOOTX64.EFI`, or whatever an NVRAM boot entry points to (`efibootmgr` lists them). It hands off in 64-bit mode, uses GPT partitioning, and offers runtime services: variables, clock, reset.

### 2. Bootloader

**GRUB** reads its config, shows a menu, loads the kernel image (`vmlinuz`) and the initramfs into memory, sets the **kernel command line** (`root=UUID=… ro quiet`), and jumps in. **systemd-boot** is a much simpler UEFI-only menu. Increasingly, the bootloader is optional:

- The kernel can be built as an **EFI stub**, so firmware can run it directly.
- A **Unified Kernel Image (UKI)** bundles the kernel, initramfs and command line into one signed `.efi` file.

Cloud VMs and containers-on-VMs often go through a minimal bootloader, or none at all (Firecracker loads the kernel directly).

### 3. Kernel

The compressed image unpacks itself, then the kernel:

- sets up **page tables** and enables paging;
- parses the firmware-provided memory map (e820/UEFI) and ACPI tables;
- starts the other CPU cores (SMP bring-up);
- initialises the scheduler, timers and interrupt controllers;
- runs built-in driver init.

`dmesg` is a transcript of this stage. Finally the kernel unpacks the initramfs into a RAM filesystem and executes its `/init` as **PID 1**.

### 4. initramfs

Why not mount root directly? Because finding the root filesystem can require a lot of code that shouldn't be baked into every kernel:

- storage drivers built as modules;
- assembling **software RAID** or **LVM**;
- unlocking **LUKS** (prompting for a passphrase, or asking the TPM);
- mounting root over **NFS/iSCSI**;
- running `fsck`.

The initramfs is a small compressed cpio archive with just enough userspace to do that, generated by dracut, mkinitcpio or initramfs-tools. When the real root is mounted, it calls `switch_root`, which frees the initramfs and `exec`s the real init.

### 5. PID 1 and userspace

PID 1 is special:

- if it exits, the kernel panics;
- it reaps orphaned processes;
- it's the root of the service tree.

Old SysV init ran shell scripts **sequentially**. systemd builds a **dependency graph** from unit files (`Requires=`, `Wants=`, `After=`) and starts everything it can **in parallel**. Its **socket activation** creates listening sockets before the service starts, so dependents can connect early and their requests queue in the kernel. It also mounts filesystems, starts udev for device events, brings up networking, and reaches a **target**: `multi-user.target` on servers, `graphical.target` on desktops.

## Chain of trust: Secure Boot and measured boot

![Secure Boot chain of signature checks from UEFI firmware through shim, bootloader and kernel, with TPM PCR measurements for measured boot](/figures/boot/secure-boot.svg "Verify before running; record what ran.")

Malware that runs before the OS (a **bootkit**) can hide from the OS entirely. Two complementary defences:

- **Secure Boot.** UEFI holds key databases: the platform key **PK**, the key-exchange keys **KEK**, the allowed list **db** and the revocation list **dbx**. Firmware runs only signed EFI binaries.
  - Linux distros ship **shim**, signed by Microsoft's UEFI CA, which contains the distro's own key and verifies GRUB or the UKI.
  - The kernel then verifies modules and enters **lockdown** mode, which blocks root from modifying the running kernel.
  - **MOK** (Machine Owner Keys) let you enroll your own keys.
- **Measured boot.** Before running each stage, the previous stage hashes it into a **TPM PCR** (Platform Configuration Register) by *extending* it: `PCR = H(PCR ‖ measurement)`. A PCR can't be set directly, only extended, so its final value commits to the whole sequence. Secrets can be **sealed** to specific PCR values, for example with `systemd-cryptenroll --tpm2-pcrs=7` or BitLocker. A remote service can also verify a signed PCR **quote** (remote attestation).

Secure Boot *blocks* untrusted code. Measured boot *proves* what ran.

## Where it's used

| Context | Boot specifics |
|---|---|
| Cloud VMs | virtual UEFI (OVMF), often Secure Boot + vTPM ("Shielded/Trusted Launch" VMs); cloud-init runs early in userspace |
| Firecracker microVMs (Lambda, Fly.io) | no firmware or bootloader; kernel loaded directly, boots in ~100 ms |
| Bare-metal fleets | PXE/HTTP network boot into an installer or a stateless image; firmware time dominates |
| Laptops | UEFI + Secure Boot + TPM-sealed disk encryption (BitLocker, LUKS with TPM) |
| Embedded / phones | ROM → signed bootloader chain (U-Boot, Android Verified Boot) → kernel |
| Containers | don't boot a kernel at all; the container's "init" is just the first process in a PID namespace |

## Use case walk-through: why does this server take 4 minutes to reboot?

1. `systemd-analyze` prints `firmware 2min 41s + loader 3s + kernel 2.1s + initrd 4.8s + userspace 38s`. Most of the time is firmware.
2. Firmware: memory training on 24 DIMMs, plus a RAID controller option ROM and PXE ROMs on four NICs. The fixes are in the vendor BIOS settings:
   - disable PXE on unused NICs;
   - enable fast boot / memory training caching where supported;
   - skip the RAID ROM if using software RAID.
3. Userspace: `systemd-analyze blame` shows `systemd-networkd-wait-online.service` taking 30 s, waiting for an unplugged NIC. `systemd-analyze critical-chain` confirms it's on the critical path. Restrict it to the interfaces that matter with `--interface=`, or drop the dependency on `network-online.target` for services that don't need it.
4. Reboot is now about 70 s. That matters during rolling kernel upgrades across a fleet. For kernel-only updates, **kexec** skips firmware entirely by loading the new kernel straight from the old one.

## Pitfalls

- **Forgetting the initramfs.** Changing storage layout (new RAID, LUKS, a driver as a module) without regenerating the initramfs leaves you at a `dracut` emergency shell with "cannot find root".
- **Out-of-date dbx and shim.** Secure Boot only protects you if revoked binaries are revoked. BootHole (2020) and the BlackLotus bootkit (2023) exploited signed-but-vulnerable bootloaders.
- **Sealing to fragile PCRs.** Sealing a disk key to PCRs that change on every firmware or kernel update leads to unexpected recovery-key prompts. Prefer PCR 7 (the Secure Boot policy) or signed PCR policies.
- **`After=` without `Wants=`/`Requires=`.** Ordering doesn't pull in the dependency, and pulling in doesn't order it. You usually need both.
- **Blaming systemd for firmware time.** Look at the `systemd-analyze` breakdown first.

> [!TIP]
> `systemd-analyze plot > boot.svg` draws every unit's start time on a timeline. It's the quickest way to see what's actually serialising your boot.

## Discussion questions

1. Why does the initramfs exist instead of building every storage driver into the kernel?
2. What does UEFI do that made multi-stage MBR chain-loading unnecessary?
3. Secure Boot and measured boot both protect the boot chain. What attack does each catch that the other doesn't?
4. Why does systemd's socket activation let services that depend on each other start in parallel?
5. How does kexec speed up reboots, and what does it skip that might matter?
6. Why do microVMs like Firecracker boot in about 100 ms when a physical server takes minutes?

## FAQ

### What's the difference between the kernel and init?

The kernel is the privileged core that manages hardware, memory and scheduling. **init** is the first *userspace* process (PID 1), started by the kernel, and it starts everything else. On most Linux distributions init is systemd. Alternatives include OpenRC, runit and s6. In a container it might just be your app, or a tiny init like `tini`.

### Is GRUB still necessary?

Not always. On UEFI systems the kernel can boot directly as an EFI stub, or as a signed Unified Kernel Image, with systemd-boot or the firmware's own boot menu. GRUB remains common for its flexibility: complex filesystems, BIOS support, scripting and dual-boot setups.

### What is PXE / network boot?

The firmware's NIC driver gets an IP address and a boot filename via DHCP, downloads a bootloader over TFTP (or HTTP with UEFI HTTP Boot), and runs it. Fleets use it to install or boot stateless images without local media. iPXE extends it with HTTP, scripting and TLS.

### Why does my laptop ask for a BitLocker or LUKS recovery key after a firmware update?

The disk key was sealed to TPM PCR values that included measurements of the firmware or bootloader. The update changed those measurements, so the TPM refuses to unseal. Suspending protection before updates, or sealing to a more stable policy (Secure Boot state, signed PCR policies), avoids it.

### What happens in the first instruction after power-on?

On x86, the CPU starts in real mode at the reset vector `0xFFFFFFF0`, just below 4 GiB, which the chipset maps to the firmware flash. The code there jumps into the firmware's early init. Before that, on modern CPUs, a security processor such as Intel Boot Guard or the AMD PSP may already have verified the firmware image.

## Key takeaways

- Booting is a chain of stages, each initialising more of the machine and handing off: firmware → bootloader → kernel → initramfs → PID 1.
- UEFI loads `.efi` files from a FAT partition. BIOS loads one 512-byte sector.
- The initramfs exists to mount complex root filesystems (RAID, LVM, LUKS, network) before the real root exists.
- systemd parallelises startup with a dependency graph and socket activation. `systemd-analyze` shows where the time goes.
- Secure Boot verifies signatures; measured boot records hashes in the TPM so secrets unlock only for a trusted chain.

## References

- Linux kernel documentation: [The Linux/x86 Boot Protocol](https://docs.kernel.org/arch/x86/boot.html)
- Linux kernel documentation: [Using the initial RAM disk (initrd)](https://docs.kernel.org/admin-guide/initrd.html)
- UEFI Forum: [UEFI Specification](https://uefi.org/specifications)
- systemd: [bootup(7)](https://www.freedesktop.org/software/systemd/man/latest/bootup.html) and [systemd-analyze(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html)
- UAPI Group: [Unified Kernel Image specification](https://uapi-group.org/specifications/specs/unified_kernel_image/)
- Arch Wiki: [Arch boot process](https://wiki.archlinux.org/title/Arch_boot_process) and [Unified Extensible Firmware Interface/Secure Boot](https://wiki.archlinux.org/title/Unified_Extensible_Firmware_Interface/Secure_Boot)
- Lennart Poettering, "Rethinking PID 1" (2010)
- Trusted Computing Group: TPM 2.0 Library Specification
