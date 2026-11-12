// SpotifyTap: captures ONLY Spotify's audio (Windows process loopback, Win10 2004+/Win11),
// downmixes to mono 16-bit @ 48 kHz and writes it to stdout. Status lines go to stderr.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

static class Program
{
    const int SampleRate = 48000;

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler handler,
        out IActivateAudioInterfaceAsyncOperation op);

    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern IntPtr CreateEvent(IntPtr a, bool manual, bool initial, string name);

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant { public ushort vt, r1, r2, r3; public uint cbSize; public IntPtr pBlob; }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WaveFormatEx { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }

    static void Status(string s) { Console.Error.WriteLine("STATUS " + s); Console.Error.Flush(); }

    static Process FindSpotifyRoot()
    {
        Process best = null; DateTime bt = DateTime.MaxValue;
        foreach (var p in Process.GetProcessesByName("Spotify"))
        {
            try { if (p.StartTime < bt) { bt = p.StartTime; best = p; } } catch { }
        }
        return best;
    }

    [MTAThread]
    static int Main()
    {
        var stdout = Console.OpenStandardOutput();
        while (true)
        {
            var proc = FindSpotifyRoot();
            if (proc == null) { Status("waiting"); Thread.Sleep(2000); continue; }
            try { Capture(proc, stdout); }
            catch (Exception e) { Status("error " + e.GetType().Name + ": " + e.Message.Replace('\n', ' ')); }
            Thread.Sleep(1500);
        }
    }

    static void Capture(Process proc, Stream stdout)
    {
        // activation parameters: AUDIOCLIENT_ACTIVATION_PARAMS { type=PROCESS_LOOPBACK(1), pid, mode=INCLUDE_TREE(0) }
        IntPtr ap = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(ap, 0, 1); Marshal.WriteInt32(ap, 4, proc.Id); Marshal.WriteInt32(ap, 8, 0);
        IntPtr pv = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariant>());
        Marshal.StructureToPtr(new PropVariant { vt = 0x41 /*VT_BLOB*/, cbSize = 12, pBlob = ap }, pv, false);

        var handler = new Handler();
        Guid iid = typeof(IAudioClient).GUID;
        ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pv, handler, out var op);
        if (!handler.Done.WaitOne(8000)) throw new Exception("activation timeout");
        op.GetActivateResult(out int hr, out object o);
        if (hr != 0 || o == null) throw new Exception("activate hr=0x" + hr.ToString("X"));
        var client = (IAudioClient)o;

        var fmt = new WaveFormatEx
        {
            wFormatTag = 1, nChannels = 2, nSamplesPerSec = SampleRate, wBitsPerSample = 16,
            nBlockAlign = 4, nAvgBytesPerSec = SampleRate * 4, cbSize = 0
        };
        IntPtr pf = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatEx>());
        Marshal.StructureToPtr(fmt, pf, false);
        // LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY
        const uint flags = 0x00020000 | 0x00040000 | 0x80000000 | 0x08000000;
        client.Initialize(0, flags, 2000000, 0, pf, IntPtr.Zero);
        IntPtr ev = CreateEvent(IntPtr.Zero, false, false, null);
        client.SetEventHandle(ev);
        Guid cgid = typeof(IAudioCaptureClient).GUID;
        client.GetService(ref cgid, out object cobj);
        var cap = (IAudioCaptureClient)cobj;
        client.Start();
        Status("capturing " + proc.Id);

        var outBuf = new byte[4096];
        int idleTicks = 0;
        while (true)
        {
            if (proc.HasExited) { Status("spotify exited"); break; }
            uint w = WaitForSingleObject(ev, 200);
            if (w != 0) { if (++idleTicks > 25) { /* 5s with no packets: still alive, just silent */ idleTicks = 0; } continue; }
            idleTicks = 0;
            while (true)
            {
                cap.GetNextPacketSize(out uint frames);
                if (frames == 0) break;
                cap.GetBuffer(out IntPtr data, out frames, out uint bflags, out _, out _);
                int n = (int)frames;
                if (outBuf.Length < n * 2) outBuf = new byte[n * 2];
                if ((bflags & 2) != 0) Array.Clear(outBuf, 0, n * 2); // AUDCLNT_BUFFERFLAGS_SILENT
                else
                {
                    unsafe
                    {
                        short* s = (short*)data;
                        for (int i = 0; i < n; i++)
                        {
                            int m = (s[i * 2] + s[i * 2 + 1]) / 2;
                            outBuf[i * 2] = (byte)(m & 0xFF); outBuf[i * 2 + 1] = (byte)((m >> 8) & 0xFF);
                        }
                    }
                }
                cap.ReleaseBuffer(frames);
                stdout.Write(outBuf, 0, n * 2); stdout.Flush();
            }
        }
        try { client.Stop(); } catch { }
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler { void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op); }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComVisible(true)]
    class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { Done.Set(); }
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        void GetBufferSize(out uint n);
        void GetStreamLatency(out long l);
        void GetCurrentPadding(out uint n);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr fmt, out IntPtr closest);
        void GetMixFormat(out IntPtr fmt);
        void GetDevicePeriod(out long def, out long min);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr h);
        void GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpc);
        void ReleaseBuffer(uint frames);
        void GetNextPacketSize(out uint frames);
    }
}
