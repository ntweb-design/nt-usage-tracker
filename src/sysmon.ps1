# Streams one JSON line per sample with GPU load, VRAM and memory commit.
# Uses PDH wildcard counters directly (vendor neutral, and far cheaper than
# Get-Counter, which expands every GPU engine instance into its own counter).
param([int]$IntervalMs = 2000)
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Pdh {
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern int PdhOpenQuery(string source, IntPtr user, out IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern int PdhAddEnglishCounter(IntPtr query, string path, IntPtr user, out IntPtr counter);
  [DllImport("pdh.dll")] static extern int PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern int PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);

  const uint FMT_DOUBLE = 0x200;
  const int MORE_DATA = unchecked((int)0x800007D2);
  static IntPtr query;

  public static IntPtr Add(string path) {
    if (query == IntPtr.Zero) PdhOpenQuery(null, IntPtr.Zero, out query);
    IntPtr counter;
    return PdhAddEnglishCounter(query, path, IntPtr.Zero, out counter) == 0 ? counter : IntPtr.Zero;
  }

  public static void Collect() { PdhCollectQueryData(query); }

  public static Dictionary<string, double> Read(IntPtr counter) {
    var result = new Dictionary<string, double>();
    if (counter == IntPtr.Zero) return result;
    uint size = 0, count;
    if (PdhGetFormattedCounterArray(counter, FMT_DOUBLE, ref size, out count, IntPtr.Zero) != MORE_DATA) return result;
    IntPtr buffer = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArray(counter, FMT_DOUBLE, ref size, out count, buffer) != 0) return result;
      int item = IntPtr.Size + 16; // name pointer, status (+padding), double
      for (int i = 0; i < count; i++) {
        IntPtr p = IntPtr.Add(buffer, i * item);
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p));
        double value = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, IntPtr.Size + 8));
        double prev;
        result[name] = result.TryGetValue(name, out prev) ? prev + value : value;
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    return result;
  }
}
'@

# True VRAM size and name of the largest adapter (WMI caps AdapterRAM at 4 GB).
$name = ''; $vram = 0
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  $size = [double]$p.'HardwareInformation.qwMemorySize'
  if ($size -gt $vram) { $vram = $size; $name = $p.DriverDesc }
}

$cEngine = [Pdh]::Add('\GPU Engine(*)\Utilization Percentage')
$cMemory = [Pdh]::Add('\GPU Adapter Memory(*)\Dedicated Usage')
$cCommit = [Pdh]::Add('\Memory\% Committed Bytes In Use')
[Pdh]::Collect()

while ($true) {
  Start-Sleep -Milliseconds $IntervalMs
  [Pdh]::Collect()
  # Sum per adapter+engine across processes; the busiest engine is the adapter's load.
  $engines = @{}
  foreach ($e in [Pdh]::Read($cEngine).GetEnumerator()) {
    if ($e.Value -gt 0 -and $e.Key -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_(\d+)_') {
      $k = $Matches[1].ToLower() + '|' + $Matches[2]
      $engines[$k] = [double]$engines[$k] + $e.Value
    }
  }
  $util = @{}
  foreach ($k in $engines.Keys) {
    $luid = $k.Split('|')[0]
    if ($engines[$k] -gt [double]$util[$luid]) { $util[$luid] = $engines[$k] }
  }
  $gpus = @()
  foreach ($m in [Pdh]::Read($cMemory).GetEnumerator()) {
    if ($m.Key -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)') {
      $luid = $Matches[1].ToLower()
      $gpus += @{ id = $luid; util = [math]::Round([double]$util[$luid], 1); mem = $m.Value }
    }
  }
  $commit = ([Pdh]::Read($cCommit).Values | Select-Object -First 1)
  @{ name = $name; vram = $vram; commit = $commit; gpus = $gpus } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.Flush()
}
