import { join } from "node:path";
import { spawnProcess, type SpawnProcessOptions } from "./spawn.js";

// PowerShell supplies the in-box CLR bridge; no native npm addon or install script.
// The launcher joins the job BEFORE creating the command. Its non-inheritable
// handle is the sole owner, so even termination of the launcher kills descendants.
const launcher = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedProcess {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static IntPtr job;
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }
    public static void Run(string command, string[] args) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
            throw new System.ComponentModel.Win32Exception();
        var start = new ProcessStartInfo(command, String.Join(" ", Array.ConvertAll(args, Quote)));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        using (var child = Process.Start(start)) {
            // Only the fixed, host-only credential protocol is sent to this command.
            child.StandardInput.Write("protocol=https\nhost=github.com\n\n");
            child.StandardInput.Close();
            child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput());
            child.WaitForExit();
            Environment.Exit(child.ExitCode);
        }
    }
}
'@
`;

export function spawnWindowsCredentialProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) {
  // Base64 prevents paths or arguments from becoming PowerShell source.
  const payload = Buffer.from(JSON.stringify({ command, args })).toString("base64");
  const script = `${launcher}
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
[OwnedProcess]::Run($p.command, [string[]]$p.args)
`;
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return spawnProcess(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    options,
  );
}
