# 重新生成 CampfireCodex.Pipe.dll
#
# 为什么需要它：适配器用 Win32 命名管道跟 ChatGPT/Codex 桌面端通信。
# Node 的 net.connect 连这条管道会被 EPERM 拒绝，必须用 Win32 原生 CreateFile。
# 所以这里用 C# 写一层 P/Invoke 并预编译成 DLL——运行时只 Add-Type -Path，
# 不在用户机器上临时编译（避免沙箱/杀软拦截和临时目录写入失败）。
#
# 用法（在 Windows PowerShell 里跑一次即可）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-dll.ps1
#
# 产物：同目录下的 CampfireCodex.Pipe.dll，随仓库分发。

$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot 'CampfireCodex.Pipe.dll'

$source = @'
using System;
using System.Runtime.InteropServices;

namespace CampfireCodex
{
    /// <summary>
    /// 官方桌面控制管道的最小 Win32 封装。
    /// 只用 CreateFile/ReadFile/WriteFile/PeekNamedPipe/CloseHandle 五个调用。
    /// 必须 CharSet.Unicode：用户名等路径含中文时按 ANSI 会解析错。
    /// </summary>
    public static class Pipe
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateFile(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadFile(
            IntPtr hFile,
            byte[] lpBuffer,
            uint nNumberOfBytesToRead,
            out uint lpNumberOfBytesRead,
            IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteFile(
            IntPtr hFile,
            byte[] lpBuffer,
            uint nNumberOfBytesToWrite,
            out uint lpNumberOfBytesWritten,
            IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool PeekNamedPipe(
            IntPtr hNamedPipe,
            IntPtr lpBuffer,
            uint nBufferSize,
            out uint lpBytesRead,
            out uint lpTotalBytesAvail,
            out uint lpBytesLeftThisMessage);
    }
}
'@

if (Test-Path -LiteralPath $out) {
    $bak = "$out.bak"
    Copy-Item -LiteralPath $out -Destination $bak -Force
    Write-Host "已备份旧 DLL 到 $bak"
}

Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $out -OutputType Library
Write-Host "已生成 $out（$((Get-Item -LiteralPath $out).Length) 字节）"

# 自检：能加载且有 5 个方法
Add-Type -Path $out
$t = [CampfireCodex.Pipe]
$methods = @('CreateFile','ReadFile','WriteFile','CloseHandle','PeekNamedPipe')
$missing = @($methods | Where-Object { -not ($t.GetMethod($_, [Reflection.BindingFlags]'Public,Static')) })
if ($missing.Count -gt 0) {
    throw "DLL 自检失败，缺少方法：$($missing -join ', ')"
}
Write-Host "自检通过：$($methods -join ', ') 都在"
