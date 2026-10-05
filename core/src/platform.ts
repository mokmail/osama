import os from "node:os";

export type Os = "macos" | "linux" | "windows";
export type Arch = "arm64" | "x64" | "unknown";

export type Acceleration =
  | "cpu"
  | "metal"
  | "cuda"
  | "rocm"
  | "vulkan"
  | "sycl"
  | "openvino"
  | "opencl";

/** Which llama.cpp release asset to fetch for a platform/accel combination. */
export interface AssetSpec {
  /** Matcher on the asset filename; `%BUILD%` is replaced with the build tag. */
  pattern: string;
  /** true for .zip (windows), false for .tar.gz. */
  zip: boolean;
  /** Optional companion assets that must be installed alongside (e.g. CUDA runtime). */
  companions?: string[];
}

export function currentOs(): Os {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}

export function currentArch(): Arch {
  const a = process.arch;
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  return "unknown";
}

/** Accelerations that make sense on this OS/arch, ordered best-first. */
export function supportedAccelerations(osName: Os = currentOs(), arch: Arch = currentArch()): Acceleration[] {
  if (osName === "macos") return ["metal", "cpu"];
  if (osName === "windows") {
    if (arch === "arm64") return ["cpu", "cuda", "opencl", "openvino", "vulkan"];
    return ["cuda", "cpu", "vulkan", "rocm", "sycl", "openvino"];
  }
  // linux
  if (arch === "arm64") return ["cpu", "vulkan"];
  return ["cuda", "cpu", "vulkan", "rocm", "sycl", "openvino"];
}

/** The sensible default acceleration for this machine. */
export function defaultAcceleration(osName: Os = currentOs(), arch: Arch = currentArch()): Acceleration {
  return supportedAccelerations(osName, arch)[0] ?? "cpu";
}

/** Resolve the release asset (and companions) for a platform + acceleration. */
export function assetSpec(osName: Os, arch: Arch, accel: Acceleration): AssetSpec {
  const B = "%BUILD%";
  if (osName === "macos") {
    // Metal is compiled into the default macOS builds — no separate variant.
    return arch === "arm64"
      ? { pattern: `llama-${B}-bin-macos-arm64.tar.gz`, zip: false }
      : { pattern: `llama-${B}-bin-macos-x64.tar.gz`, zip: false };
  }
  if (osName === "windows") {
    const zip = true;
    switch (accel) {
      case "cuda":
        return arch === "arm64"
          ? { pattern: `llama-${B}-bin-win-cuda-13.4-arm64.zip`, zip }
          : { pattern: `llama-${B}-bin-win-cuda-12.4-x64.zip`, zip };
      case "vulkan":
        return { pattern: `llama-${B}-bin-win-vulkan-x64.zip`, zip };
      case "rocm":
        return { pattern: `llama-${B}-bin-win-rocm-10.0-x64.zip`, zip };
      case "sycl":
        return { pattern: `llama-${B}-bin-win-sycl-x64.zip`, zip };
      case "openvino":
        return { pattern: `llama-${B}-bin-win-openvino-2026.4.1-x64.zip`, zip };
      case "opencl":
        return { pattern: `llama-${B}-bin-win-opencl-adreno-arm64.zip`, zip };
      default:
        return arch === "arm64"
          ? { pattern: `llama-${B}-bin-win-cpu-arm64.zip`, zip }
          : { pattern: `llama-${B}-bin-win-cpu-x64.zip`, zip };
    }
  }
  // linux
  switch (accel) {
    case "cuda":
      return arch === "arm64"
        ? {
            pattern: `llama-${B}-bin-ubuntu-cuda-13.4-arm64.tar.gz`,
            zip: false,
            companions: [`cudart-llama-${B}-bin-ubuntu-cuda-13.4-arm64.tar.gz`],
          }
        : {
            pattern: `llama-${B}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
            zip: false,
            companions: [`cudart-llama-${B}-bin-ubuntu-cuda-12.8-x64.tar.gz`],
          };
    case "vulkan":
      return arch === "arm64"
        ? { pattern: `llama-${B}-bin-ubuntu-vulkan-arm64.tar.gz`, zip: false }
        : { pattern: `llama-${B}-bin-ubuntu-vulkan-x64.tar.gz`, zip: false };
    case "rocm":
      return { pattern: `llama-${B}-bin-ubuntu-rocm-10.0-x64.tar.gz`, zip: false };
    case "sycl":
      return { pattern: `llama-${B}-bin-ubuntu-sycl-fp16-x64.tar.gz`, zip: false };
    case "openvino":
      return { pattern: `llama-${B}-bin-ubuntu-openvino-2026.4.1-x64.tar.gz`, zip: false };
    default:
      return arch === "arm64"
        ? { pattern: `llama-${B}-bin-ubuntu-arm64.tar.gz`, zip: false }
        : { pattern: `llama-${B}-bin-ubuntu-x64.tar.gz`, zip: false };
  }
}

export interface SystemInfo {
  os: Os;
  arch: Arch;
  platform: string;
  release: string;
  hostname: string;
  cpus: number;
  cpuModel: string;
  totalMemBytes: number;
  freeMemBytes: number;
  gpu: string;
}

/** Best-effort GPU detection. */
export function detectGpu(osName: Os = currentOs()): string {
  // Apple Silicon / Intel Macs → Metal.
  if (osName === "macos") return currentArch() === "arm64" ? "Apple Silicon GPU (Metal)" : "Intel/AMD Mac GPU (Metal)";
  // Linux/Windows: try nvidia-smi (cheap, common) via child_process is done in
  // processes.ts; here we return a generic hint that the UI refines later.
  return "detecting…";
}

export interface GpuProbe {
  vendor: "apple" | "nvidia" | "amd" | "intel" | "none" | "unknown";
  name: string;
  /** best acceleration to use on this machine */
  acceleration: Acceleration;
  /** true when a discrete accelerator was actually found */
  discrete: boolean;
}

/** Turn a raw lspci line into something readable. */
function prettyPci(line: string): string {
  return line
    .replace(/^[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]\s+/i, "")
    .replace(/^[^:]+:\s*/, "")
    .replace(/\s*\(rev [0-9a-f]+\)\s*$/i, "")
    .trim();
}

/**
 * Probe the machine for an accelerator and recommend the llama.cpp build to
 * install. Shells out to the platform's standard tooling; never throws.
 */
export async function probeGpu(osName: Os = currentOs(), arch: Arch = currentArch()): Promise<GpuProbe> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  if (osName === "macos") {
    const metal = arch === "arm64";
    return {
      vendor: "apple",
      name: metal ? "Apple Silicon GPU (Metal)" : "Intel/AMD Mac GPU (Metal)",
      acceleration: "metal",
      discrete: metal,
    };
  }

  // NVIDIA anywhere.
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 4000 });
    const name = stdout.trim().split("\n")[0]?.trim();
    if (name) return { vendor: "nvidia", name, acceleration: "cuda", discrete: true };
  } catch {
    /* no nvidia-smi */
  }

  if (osName === "linux") {
    // AMD via rocm-smi / sysfs, Intel via lspci fallback.
    try {
      const { stdout } = await run("rocm-smi", ["--showproductname"], { timeout: 4000 });
      if (/gpu/i.test(stdout)) return { vendor: "amd", name: stdout.trim().split("\n")[0] ?? "AMD GPU", acceleration: "rocm", discrete: true };
    } catch {
      /* no rocm */
    }
    try {
      const { stdout } = await run("sh", ["-c", "lspci 2>/dev/null | grep -Ei 'vga|3d|display'"], { timeout: 4000 });
      const line = stdout.split("\n").find(Boolean) ?? "";
      const name = prettyPci(line) || line;
      if (/nvidia/i.test(line)) return { vendor: "nvidia", name, acceleration: "cuda", discrete: true };
      // Note: do NOT match a bare "ati" — it occurs inside words like "compatible".
      if (/amd|radeon|advanced micro devices|\[ati\]/i.test(line)) {
        return { vendor: "amd", name, acceleration: "rocm", discrete: true };
      }
      if (/intel/i.test(line)) return { vendor: "intel", name, acceleration: "cpu", discrete: false };
      if (line) return { vendor: "unknown", name, acceleration: "vulkan", discrete: true };
    } catch {
      /* no lspci */
    }
  }

  return { vendor: "none", name: "CPU only", acceleration: "cpu", discrete: false };
}


export function systemInfo(): SystemInfo {
  const cpuList = os.cpus();
  return {
    os: currentOs(),
    arch: currentArch(),
    platform: `${process.platform}-${process.arch}`,
    release: os.release(),
    hostname: os.hostname(),
    cpus: cpuList.length,
    cpuModel: cpuList[0]?.model?.trim() ?? "unknown",
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    gpu: detectGpu(),
  };
}

/** Recommended default `-ngl` value for the current platform. */
export function recommendedGpuLayers(osName: Os = currentOs()): number {
  if (osName === "macos") return 999; // full offload on Apple Silicon / Metal
  return 0; // conservative default; the UI lets the user raise it
}
