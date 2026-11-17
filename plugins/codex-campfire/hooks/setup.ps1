# First-run GUI setup for the Codex-Campfire plugin.
# Pasted "config code" -> discovers sessions -> writes .env -> done.
# No command line, no hidden files to find. Uses Windows Forms only.

param([string]$ConfigDir = '')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('SetupPipe' -as [type])) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SetupPipe {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadFile(IntPtr h, byte[] b, uint n, out uint r, IntPtr o);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteFile(IntPtr h, byte[] b, uint n, out uint w, IntPtr o);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool PeekNamedPipe(IntPtr h, IntPtr b, uint n, out uint r, out uint a, out uint l);
}
'@
}
$T = [SetupPipe]
$RW = [uint32]3221225472

function Find-Pipe() {
  $name = Get-ChildItem '\\.\pipe\' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^codex-app-tools-' } |
    Select-Object -First 1 -ExpandProperty Name
  if (-not $name) { return '' }
  if ($name -match '^\\\\\.\\pipe\\') { $name = $name -replace '^\\\\\.\\pipe\\','' }
  return ('\\.\pipe\' + $name)
}

function Call-Tool([string]$pipe, [string]$tool, [string]$argsJson, [string]$caller, [int]$to = 15000) {
  $h = $T::CreateFile($pipe, $RW, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if (-not $h -or $h.ToInt64() -eq -1) { throw ("无法连接 GPT 控制管道: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  try {
    $json = '{"id":1,"jsonrpc":"2.0","method":"tools/call","params":{"arguments":'+$argsJson+',"callerSource":"codex","callId":"setup1","hostId":"local","namespace":"codex_app","threadId":"'+$caller+'","tool":"'+$tool+'","turnId":"setup1t"}}'
    $b=[Text.Encoding]::UTF8.GetBytes($json);$f=New-Object byte[] (4+$b.Length)
    [Array]::Copy([BitConverter]::GetBytes([uint32]$b.Length),0,$f,0,4);[Array]::Copy($b,0,$f,4,$b.Length)
    $w=[uint32]0;[void]$T::WriteFile($h,$f,[uint32]$f.Length,[ref]$w,[IntPtr]::Zero)
    $all=New-Object System.IO.MemoryStream;$buf=New-Object byte[] 65536;$d=-1;$sw=[Diagnostics.Stopwatch]::StartNew()
    while($sw.ElapsedMilliseconds -lt $to){
      $a=[uint32]0;$rr=[uint32]0;$l=[uint32]0;[void]$T::PeekNamedPipe($h,[IntPtr]::Zero,0,[ref]$rr,[ref]$a,[ref]$l)
      if($a -eq 0){Start-Sleep -Milliseconds 100;continue}
      $r=[uint32]0;[void]$T::ReadFile($h,$buf,65536,[ref]$r,[IntPtr]::Zero)
      if($r -gt 0){$all.Write($buf,0,[int]$r)}
      if($d -lt 0 -and $all.Length -ge 4){$d=[int][BitConverter]::ToUInt32($all.ToArray(),0)}
      if($d -ge 0 -and $all.Length -ge 4+$d){break}
    }
    $bb=$all.ToArray()
    if($d -le 0){throw '读取 GPT 会话列表超时'}
    $resp=([Text.Encoding]::UTF8.GetString($bb,4,$d))|ConvertFrom-Json
    if($resp.error){throw $resp.error.message}
    return $resp.result.contentItems[0].text
  } finally { [void]$T::CloseHandle($h) }
}

function Decode-Config($code) {
  if ($code -notmatch '^campfire://setup\?(.+)$') { throw '配置码格式不对，请复制完整的 campfire://setup?...' }
  $b64 = $Matches[1].Replace('-','+').Replace('_','/')
  while ($b64.Length % 4 -ne 0) { $b64 += '=' }
  $bytes = [Convert]::FromBase64String($b64)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  $o = $json | ConvertFrom-Json
  if (-not $o.base -or -not $o.token -or -not $o.member) { throw '配置码内容不完整' }
  return $o
}

# ---- GUI ----
$cfg = $null
try {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = '围炉接入 · 第 1 步：粘贴配置码'
  $form.Width = 540; $form.Height = 400
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = "怎么拿到配置码？`n1) 打开围炉网页 → 成员管理 → 新建成员（特征名比如 gpt，接入哪个 agent 选「GPT 桌面端」）`n2) 保存后弹出的引导里，点「生成配置码」→「复制配置码」`n3) 回到这里，粘到下面，点下一步`n`n配置码以 campfire://setup? 开头，不用手填任何东西。"
  $lbl.Left=20; $lbl.Top=16; $lbl.Width=495; $lbl.Height=120
  $form.Controls.Add($lbl)

  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Left=20; $tb.Top=145; $tb.Width=495; $tb.Height=70
  $tb.Multiline=$true; $tb.ScrollBars='Vertical'; $tb.WordWrap=$true
  $tb.Text='campfire://setup?'
  $form.Controls.Add($tb)

  $btn = New-Object System.Windows.Forms.Button
  $btn.Text='下一步  →'; $btn.Left=405; $btn.Top=230; $btn.Width=110; $btn.Height=36
  $form.Controls.Add($btn)

  $status = New-Object System.Windows.Forms.Label
  $status.Left=20; $status.Top=285; $status.Width=495; $status.Height=70
  $status.ForeColor=[System.Drawing.Color]::DarkSlateGray
  $form.Controls.Add($status)

  $script:result = $null
  $btn.Add_Click({
    try {
      $script:result = Decode-Config $tb.Text.Trim()
      $form.DialogResult = 'OK'
      $form.Close()
    } catch {
      $status.Text = '× ' + $_.Exception.Message
      $status.ForeColor = [System.Drawing.Color]::DarkRed
    }
  }.GetNewClosure())

  [void]$form.ShowDialog()
  $cfg = $script:result
} catch {
  [System.Windows.Forms.MessageBox]::Show('配置窗口出错：' + $_.Exception.Message, '围炉接入', 'OK', 'Error')
  exit 1
}

if (-not $cfg) { exit 0 }

# ---- discover sessions, pick member + sender ----
$pipe = Find-Pipe
if (-not $pipe) {
  [System.Windows.Forms.MessageBox]::Show('没有找到 GPT 桌面端，请先打开 ChatGPT 桌面端再重试。', '围炉接入', 'OK', 'Warning')
  exit 1
}

# Read desktop sessions from the local index (pure file read, no caller needed).
$sessions = @()
try {
  $idx = Join-Path $env:USERPROFILE '.codex\session_index.jsonl'
  if (Test-Path -LiteralPath $idx) {
    foreach ($line in (Get-Content -LiteralPath $idx -Encoding UTF8)) {
      if (-not $line.Trim()) { continue }
      $o = $line | ConvertFrom-Json
      $sessions += [pscustomobject]@{ id = [string]$o.id; title = [string]$o.thread_name }
    }
  }
  # Also add known rollouts not in the index (read their session_meta title).
  $sessDir = Join-Path $env:USERPROFILE '.codex\sessions'
  if (Test-Path -LiteralPath $sessDir) {
    $known = @($sessions | ForEach-Object { $_.id })
    Get-ChildItem -LiteralPath $sessDir -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        $id = if ($_.BaseName -match '-([0-9a-f]{8}-[0-9a-f-]{27})$') { $Matches[1] } else { $null }
        if ($id -and $known -notcontains $id) {
          $sessions += [pscustomobject]@{ id = $id; title = ($_.BaseName -replace '^rollout-[^_]*_','') }
        }
      }
  }
} catch {
  [System.Windows.Forms.MessageBox]::Show('读取会话失败：' + $_.Exception.Message, '围炉接入', 'OK', 'Error')
  exit 1
}
if ($sessions.Count -lt 2) {
  [System.Windows.Forms.MessageBox]::Show('请在 GPT 桌面端先新建两条会话（比如「围炉」和「发话口」），再重试。当前找到 ' + $sessions.Count + ' 条。', '围炉接入', 'OK', 'Warning')
  exit 1
}

# Let user pick the member session; the other becomes sender.
$form2 = New-Object System.Windows.Forms.Form
$form2.Text='围炉接入 · 第 2 步：选会话'
$form2.Width=540; $form2.Height=310
$form2.StartPosition='CenterScreen'; $form2.FormBorderStyle='FixedDialog'; $form2.MaximizeBox=$false
$l2=New-Object System.Windows.Forms.Label
$l2.Text="选一条会话当作「围炉成员」——群里 @GPT 后，消息会进这条会话，它的回答也发回群里。你在 GPT 里能点开看到这一来一回。`n剩下的一条会自动用来在后台发话，不用管。选「你好」这类常用会话就行。"
$l2.Left=20;$l2.Top=16;$l2.Width=495;$l2.Height=70
$form2.Controls.Add($l2)
$cbo=New-Object System.Windows.Forms.ComboBox
$cbo.Left=20;$cbo.Top=100;$cbo.Width=490;$cbo.DropDownStyle='DropDownList'
foreach($s in $sessions){ [void]$cbo.Items.Add($s.title + '  （' + $s.id.Substring(0,8) + '…）') }
$cbo.SelectedIndex=0
$form2.Controls.Add($cbo)
$btn2=New-Object System.Windows.Forms.Button
$btn2.Text='完成接入  ✓'; $btn2.Left=405;$btn2.Top=145;$btn2.Width=110;$btn2.Height=36
$form2.Controls.Add($btn2)
$script:chosen=$null
$btn2.Add_Click({ $script:chosen=$cbo.SelectedIndex; $form2.DialogResult='OK'; $form2.Close() }.GetNewClosure())
[void]$form2.ShowDialog()

if ($null -eq $script:chosen) { exit 0 }
$memberSession = $sessions[$script:chosen].id
$senderSession = @($sessions | Where-Object { $_.id -ne $memberSession } | Select-Object -First 1)[0].id

# ---- write .env ----
if ([string]::IsNullOrWhiteSpace($ConfigDir)) { $ConfigDir = Join-Path $env:USERPROFILE '.campfire-codex' }
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$envPath = Join-Path $ConfigDir '.env'
$example = Join-Path (Split-Path $PSScriptRoot -Parent) 'adapter\.env.example'
if (Test-Path -LiteralPath $example) { Copy-Item -LiteralPath $example -Destination $envPath -Force } else {
  Set-Content -LiteralPath $envPath -Value '' -Encoding UTF8
}
$lines = Get-Content -LiteralPath $envPath -Encoding UTF8
function Set-EnvLine([string[]]$arr,[string]$key,[string]$val) {
  $found=$false
  $out = @($arr | ForEach-Object {
    if ($_ -match "^$([regex]::Escape($key))=") { $found=$true; "$key=$val" } else { $_ }
  })
  if (-not $found) { $out += "$key=$val" }
  return $out
}
$lines = Set-EnvLine $lines 'CAMPFIRE_BASE_URL' $cfg.base
$lines = Set-EnvLine $lines 'CAMPFIRE_CHANNEL_TOKEN' $cfg.token
$lines = Set-EnvLine $lines 'CAMPFIRE_MEMBER' $cfg.member
$lines = Set-EnvLine $lines 'CODEX_THREAD_ID' $memberSession
$lines = Set-EnvLine $lines 'CODEX_CALLER_THREAD_ID' $senderSession
[System.IO.File]::WriteAllLines($envPath, $lines, (New-Object System.Text.UTF8Encoding($false)))

[System.Windows.Forms.MessageBox]::Show('接入完成！适配器正在启动，回群里 @它 试试。', '围炉接入', 'OK', 'Information')
Write-Output ("CONFIGURED base=" + $cfg.base + " member=" + $cfg.member + " thread=" + $memberSession + " caller=" + $senderSession)
