# Bridges Windows media session (SMTC) <-> overlay.
# Prints one JSON line per second; executes commands written to $CmdPath (playpause | next | prev | seek:<seconds>).
param([string]$ArtPath, [string]$CmdPath)
# Send JSON as UTF-8 so Japanese/other non-ASCII titles survive
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamReference,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result
}
# ---- per-app volume for Spotify (Windows Core Audio sessions) ----
Add-Type -Language CSharp -TypeDefinition @"
using System; using System.Diagnostics; using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devs);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  [PreserveSig] int GetCount(out uint n);
  [PreserveSig] int Item(uint i, out IMMDevice dev);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  [PreserveSig] int _GetAudioSessionControl(IntPtr a, uint b, out IntPtr c);
  [PreserveSig] int _GetSimpleAudioVolume(IntPtr a, uint b, out IntPtr c);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int n);
  [PreserveSig] int GetSession(int i, [MarshalAs(UnmanagedType.IUnknown)] out object s);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int _0(); [PreserveSig] int _1(); [PreserveSig] int _2(); [PreserveSig] int _3(); [PreserveSig] int _4();
  [PreserveSig] int _5(); [PreserveSig] int _6(); [PreserveSig] int _7(); [PreserveSig] int _8();
  [PreserveSig] int _GetSessionIdentifier(out IntPtr s);
  [PreserveSig] int _GetSessionInstanceIdentifier(out IntPtr s);
  [PreserveSig] int GetProcessId(out uint pid);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
  [PreserveSig] int GetMasterVolume(out float level);
}
public static class SpotVol {
  static void Each(Action<ISimpleAudioVolume> act) {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    IMMDeviceCollection col; en.EnumAudioEndpoints(0, 1, out col);
    uint n; col.GetCount(out n);
    for (uint i = 0; i < n; i++) {
      IMMDevice dev; col.Item(i, out dev);
      Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"); object o;
      if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
      var mgr = (IAudioSessionManager2)o; IAudioSessionEnumerator se; mgr.GetSessionEnumerator(out se);
      int c; se.GetCount(out c);
      for (int j = 0; j < c; j++) {
        object s; se.GetSession(j, out s);
        try {
          uint pid; ((IAudioSessionControl2)s).GetProcessId(out pid);
          if (Process.GetProcessById((int)pid).ProcessName.Equals("Spotify", StringComparison.OrdinalIgnoreCase)) act((ISimpleAudioVolume)s);
        } catch {}
      }
    }
  }
  public static double Get() { double v = -1; Each(a => { float x; a.GetMasterVolume(out x); if (x > v) v = x; }); return v; }
  public static void Set(double v) {
    float f = (float)Math.Max(0, Math.Min(1, v));
    Each(a => { Guid g = Guid.Empty; a.SetMasterVolume(f, ref g); });
  }
  public static double Add(double d) {
    double r = -1;
    Each(a => { float x; a.GetMasterVolume(out x); x = (float)Math.Max(0, Math.Min(1, x + d)); Guid g = Guid.Empty; a.SetMasterVolume(x, ref g); r = x; });
    return r;
  }
}
"@
$mgr = Await([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Get-Sess {
  foreach ($x in $mgr.GetSessions()) { if ($x.SourceAppUserModelId -match 'Spotify') { return $x } }
  return $mgr.GetCurrentSession()
}
$inv = [Globalization.CultureInfo]::InvariantCulture
$lastKey = ''; $artVer = 0; $last = [DateTime]::MinValue; $force = $false
while ($true) {
  try {
    $s = Get-Sess
    # ---- commands from the overlay ----
    if ($CmdPath -and (Test-Path $CmdPath)) {
      $cmds = [System.IO.File]::ReadAllLines($CmdPath); Remove-Item $CmdPath -Force -ErrorAction SilentlyContinue
      foreach ($c in $cmds) {
        if (-not $c) { continue }
        if (-not $s -and -not $c.StartsWith('vol')) { continue }
        try {
          if ($c -eq 'playpause') { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
          elseif ($c -eq 'next') { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
          elseif ($c -eq 'prev') { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
          elseif ($c.StartsWith('volset:')) { [SpotVol]::Set([double]::Parse($c.Substring(7), $inv)) }
          elseif ($c.StartsWith('vol:')) { $null = [SpotVol]::Add([double]::Parse($c.Substring(4), $inv)) }
          elseif ($c.StartsWith('seek:')) {
            $secs = [double]::Parse($c.Substring(5), $inv)
            $null = Await ($s.TryChangePlaybackPositionAsync([long]($secs * 10000000))) ([bool])
          }
        } catch { [System.IO.File]::AppendAllText("$env:TEMP\spotify-overlay-err.txt", "CMD $c : $_`r`n") }
        $force = $true
      }
      if ($force) { Start-Sleep -Milliseconds 150 }
    }
    if (-not $force -and ((Get-Date) - $last).TotalMilliseconds -lt 1000) { Start-Sleep -Milliseconds 100; continue }
    $last = Get-Date; $force = $false
    $s = Get-Sess
    if (-not $s) { '{"active":false}'; continue }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $tl = $s.GetTimelineProperties(); $pb = $s.GetPlaybackInfo()
    $key = "$($p.Title)|$($p.Artist)"
    if ($key -ne $lastKey) {
      $lastKey = $key
      try {
        if ($p.Thumbnail) {
          $rs = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $m = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
          $stream = $m.Invoke($null, @($rs))
          $artVer++; $file = "$ArtPath$artVer.jpg"
          $fs = [System.IO.File]::Create($file); $stream.CopyTo($fs); $fs.Close(); $stream.Close()
          Get-ChildItem "$ArtPath*.jpg" | Where-Object { $_.FullName -ne $file } | Remove-Item -ErrorAction SilentlyContinue
        }
      } catch { [System.IO.File]::AppendAllText("$env:TEMP\spotify-overlay-err.txt", "$_`r`n") }
    }
    # SMTC position is only updated occasionally: extrapolate from the time it was last updated
    $pos = $tl.Position.TotalSeconds; $durS = ($tl.EndTime - $tl.StartTime).TotalSeconds
    $isPlaying = ($pb.PlaybackStatus -eq 'Playing')
    if ($isPlaying -and $tl.LastUpdatedTime.Year -gt 2000) {
      $age = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
      $rate = 1.0; if ($pb.PlaybackRate) { $rate = [double]$pb.PlaybackRate }
      if ($age -gt 0 -and $age -lt 3600) { $pos += $age * $rate }
      if ($durS -gt 0 -and $pos -gt $durS) { $pos = $durS }
    }
    $o = [ordered]@{
      active = $true; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
      playing = $isPlaying; raw = $tl.Position.TotalSeconds
      pos = $pos; dur = $durS; vol = $(try { [SpotVol]::Get() } catch { -1 })
      art = $(if ($artVer -gt 0) { "$ArtPath$artVer.jpg" } else { '' })
    }
    $o | ConvertTo-Json -Compress
  } catch { '{"active":false}'; Start-Sleep -Milliseconds 500 }
}
