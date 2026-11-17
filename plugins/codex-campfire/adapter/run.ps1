# Codex Desktop adapter for Campfire - single-process PowerShell edition.
# One process does everything: poll Campfire /v1/*, inject into the desktop's
# official control pipe, wait for the model reply, post it back to Campfire.
# Using a single process avoids sandbox grandchild-spawn restrictions.
#
# Usage (env vars, see .env.example):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File run.ps1

param([string]$ConfigDir = '')

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Web   # HttpUtility for query string encoding

# Load precompiled P/Invoke type (no runtime Add-Type compilation / temp writes).
$dll = Join-Path $PSScriptRoot 'CampfireCodex.Pipe.dll'
if (-not (Test-Path -LiteralPath $dll)) { throw "missing DLL: $dll (run build-dll.ps1 once)" }
Add-Type -Path $dll
$T = [CampfireCodex.Pipe]
$RW = [uint32]3221225472

function Log([string]$level, [string]$msg) {
  $lv = if ($script:dotenv.ContainsKey('LOG_LEVEL')) { $script:dotenv['LOG_LEVEL'] } else { $env:LOG_LEVEL }
  if ($lv -eq 'silent') { return }
  $line = ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $level, $msg)
  # 必须用 Write-Host：Write-Output 会进入管道、污染调用方函数的返回值
  # （曾导致 Resolve-Caller 返回日志文本而不是会话 id）。
  Write-Host $line
  # Detached process has no console; always mirror to a file in the config dir.
  try {
    $script:logPath = Join-Path $configDir 'adapter.log'
    Add-Content -LiteralPath $script:logPath -Value $line -Encoding UTF8
  } catch {}
}

# Env value, falling back to a .env file. Config dir resolution order:
#   CAMPFIRE_CONFIG_DIR env  >  CODEX_CONFIG_DIR env  >  this script's dir.
# The ignition plugin points CAMPFIRE_CONFIG_DIR at a persistent user dir so
# config survives plugin upgrades.
$script:dotenv = @{}
$configDir = $ConfigDir
if ([string]::IsNullOrWhiteSpace($configDir)) { $configDir = [Environment]::GetEnvironmentVariable('CAMPFIRE_CONFIG_DIR') }
if ([string]::IsNullOrWhiteSpace($configDir)) { $configDir = $PSScriptRoot }
$envFile = Join-Path $configDir '.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
    $s = $line.Trim()
    if (-not $s -or $s.StartsWith('#')) { continue }
    $eq = $s.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $s.Substring(0, $eq).Trim()
    $vv = $s.Substring($eq + 1).Trim()
    if ($vv.Length -ge 2 -and (($vv.StartsWith('"') -and $vv.EndsWith('"')) -or ($vv.StartsWith("'") -and $vv.EndsWith("'")))) {
      $vv = $vv.Substring(1, $vv.Length - 2)
    }
    $script:dotenv[$k] = $vv
  }
}
function Get-Env([string]$key, [string]$def) {
  $v = [Environment]::GetEnvironmentVariable($key)
  if ([string]::IsNullOrWhiteSpace($v) -and $script:dotenv.ContainsKey($key)) { $v = $script:dotenv[$key] }
  if ([string]::IsNullOrWhiteSpace($v)) { return $def }
  return $v.Trim()
}

$cfg = @{
  base   = Get-Env 'CAMPFIRE_BASE_URL' 'http://127.0.0.1:8099'
  token  = Get-Env 'CAMPFIRE_CHANNEL_TOKEN' ''
  member = Get-Env 'CAMPFIRE_MEMBER' ''
  chat   = Get-Env 'CAMPFIRE_CHAT' 'main'
  thread = Get-Env 'CODEX_THREAD_ID' ''
  caller = Get-Env 'CODEX_CALLER_THREAD_ID' ''
  host   = Get-Env 'CODEX_HOST_ID' 'local'
  pipe   = Get-Env 'CODEX_PIPE_NAME' ''
  wait   = [int](Get-Env 'CODEX_POLL_WAIT' '25')
  limit  = [int](Get-Env 'CODEX_POLL_LIMIT' '20')
  interval = [int](Get-Env 'CODEX_INTERVAL_MS' '1000')
  maxReply = [int](Get-Env 'CODEX_MAX_REPLY_MS' '120000')
}

if (-not $cfg.token -or -not $cfg.member -or -not $cfg.thread -or -not $cfg.caller) {
  throw 'CAMPFIRE_CHANNEL_TOKEN / CAMPFIRE_MEMBER / CODEX_THREAD_ID / CODEX_CALLER_THREAD_ID are required'
}

# Discover the codex-app-tools pipe if not pinned.
if (-not $cfg.pipe) {
  $pipes = Get-ChildItem '\\.\pipe\' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^codex-app-tools-' } |
    Select-Object -First 1 -ExpandProperty Name
  if (-not $pipes) { throw 'no codex-app-tools pipe; is ChatGPT Desktop running?' }
  if ($pipes -match '^\\\\\.\\pipe\\') { $pipes = $pipes -replace '^\\\\\.\\pipe\\','' }
  $cfg.pipe = '\\.\pipe\' + $pipes
}
if ($cfg.pipe -notmatch '^\\\\\.\\pipe\\') { $cfg.pipe = '\\.\pipe\' + $cfg.pipe }
if ($cfg.pipe -match '^\\\\\.\\pipe\\\\\\\.\\pipe\\') { $cfg.pipe = $cfg.pipe -replace '^(.*?pipe\\)\\\\.\\pipe\\','$1' }
Log 'info' ("pipe=" + $cfg.pipe + " thread=" + $cfg.thread)

# ---- Pipe JSON-RPC (one connection per call, same session as this process) ----
function Pipe-CallRaw([string]$json, [int]$timeoutMs) {
  $h = $T::CreateFile($cfg.pipe, $RW, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if (-not $h -or $h.ToInt64() -eq -1) { throw "CreateFile failed win32err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  try {
    $body = [Text.Encoding]::UTF8.GetBytes($json)
    $f = New-Object byte[] (4 + $body.Length)
    [Array]::Copy([BitConverter]::GetBytes([uint32]$body.Length), 0, $f, 0, 4)
    [Array]::Copy($body, 0, $f, 4, $body.Length)
    $w = [uint32]0
    [void]$T::WriteFile($h, $f, [uint32]$f.Length, [ref]$w, [IntPtr]::Zero)
    $all = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 65536
    $declared = -1
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
      $a=[uint32]0;$rr=[uint32]0;$l=[uint32]0
      [void]$T::PeekNamedPipe($h,[IntPtr]::Zero,0,[ref]$rr,[ref]$a,[ref]$l)
      if ($a -eq 0) { Start-Sleep -Milliseconds 100; continue }
      $r=[uint32]0;[void]$T::ReadFile($h,$buf,65536,[ref]$r,[IntPtr]::Zero)
      if ($r -gt 0) { $all.Write($buf,0,[int]$r) }
      if ($declared -lt 0 -and $all.Length -ge 4) {
        $declared=[int][BitConverter]::ToUInt32($all.ToArray(),0)
        if ($declared -le 0 -or $declared -gt 8388608) { throw "bad frame length $declared" }
      }
      if ($declared -ge 0 -and $all.Length -ge 4+$declared) { break }
    }
    $b=$all.ToArray()
    if ($declared -le 0 -or $b.Length -lt 4+$declared) { throw "pipe read timeout ${timeoutMs}ms" }
    $resp = ([Text.Encoding]::UTF8.GetString($b,4,$declared)) | ConvertFrom-Json
    if ($resp.error) { throw ("pipe rpc error: " + $resp.error.message) }
    return $resp
  } finally {
    [void]$T::CloseHandle($h)
  }
}

# 把一个字符串转成合法 JSON 字符串字面量（含引号包裹）。
function Json-Str([string]$s) {
  $out = '"' + $s.Replace('\','\\').Replace('"','\"').Replace("`r",'\r').Replace("`n",'\n').Replace("`t",'\t') + '"'
  return $out
}

$script:callSeq = 1
function Tool-Call([string]$tool, [string]$argsJson, [string]$callerThread, [int]$timeoutMs = 60000) {
  $id = $script:callSeq; $script:callSeq++
  # 手写 JSON 帧：避免 PowerShell 把嵌套 hashtable/array 转成 Object[] 的类型错误
  $json = '{"id":' + $id + ',"jsonrpc":"2.0","method":"tools/call","params":{' +
    '"arguments":' + $argsJson + ',' +
    '"callerSource":"codex","callId":"cf-' + $id + '","hostId":"' + $cfg.host + '",' +
    '"namespace":"codex_app","threadId":"' + $callerThread + '",' +
    '"tool":"' + $tool + '","turnId":"cf-turn-' + $id + '"}}'
  $resp = Pipe-CallRaw $json $timeoutMs
  $r = $resp.result
  if (-not $r) { throw 'tool call returned no result' }
  $text = $r.contentItems[0].text
  if ($r.success -eq $false) { throw ("tool " + $tool + " failed: " + $text) }
  if (-not $text) { return @{} }
  try { return ($text | ConvertFrom-Json) } catch { return @{ text = $text } }
}

# 选「发话口」会话（官方要求 caller ≠ target）。
# 关键：**不要提前批量探测** —— 每条消息前连发 7 次探测会把桌面 app-tools 服务
# 打到异常态（实测：之后所有 tools/call 都返回 -32000，连独立探测也失败）。
# 策略：直接用配置里的 caller；只有它真的失败时，才按候选逐个换，每次之间留间隔。
$script:goodCaller = ''
$script:roster = @()
function Get-CallerChain([string]$target, [string[]]$candidates) {
  $chain = @()
  if ($script:goodCaller -and $script:goodCaller -ne $target) { $chain += $script:goodCaller }
  if ($cfg.caller -and $cfg.caller -ne $target) { $chain += $cfg.caller }
  $chain += @($candidates | Where-Object { $_ -and $_ -ne $target })
  return @($chain | Select-Object -Unique)
}

# 列出所有可能的会话 id 作为 caller 候选：
# 1) session_index.jsonl（可能被改坏/只剩一条）
# 2) sessions 目录下的 rollout 文件名（真实存在的会话，索引里没有也能用）
# 排序：最近修改的优先（越新越可能可响应）。
function List-ThreadIds() {
  $ids = @()
  try {
    $idx = Join-Path (Join-Path $env:USERPROFILE '.codex') 'session_index.jsonl'
    if (Test-Path -LiteralPath $idx) {
      foreach ($line in (Get-Content -LiteralPath $idx -Encoding UTF8)) {
        if (-not $line.Trim()) { continue }
        try { $o = $line | ConvertFrom-Json; if ($o.id) { $ids += [string]$o.id } } catch { }
      }
    }
  } catch { }
  try {
    $sessDir = Join-Path (Join-Path $env:USERPROFILE '.codex') 'sessions'
    if (Test-Path -LiteralPath $sessDir) {
      Get-ChildItem -LiteralPath $sessDir -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object {
          if ($_.BaseName -match '-([0-9a-f]{8}-[0-9a-f-]{27})$') { $ids += $Matches[1] }
        }
    }
  } catch { }
  return @($ids | Select-Object -Unique)
}

# 用 create_thread 新建一条专用发话口会话（没有可用 caller 时的兜底）。
function New-CallerThread([string]$target, [string]$callerForCreate) {
  # 只试一种最可能的参数，短超时，避免每轮卡 90 秒。
  foreach ($argsJson in @(
      '{"title":"围炉发话口","prompt":"这是围炉适配器专用的发话口会话，保持空闲即可，不需要回复。"}'
    )) {
    try {
      $r = Tool-Call 'create_thread' $argsJson $callerForCreate 30000
      $txt = [string]$r.text
      if ($txt) {
        $m = [regex]::Match($txt, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
        if ($m.Success) {
          Log 'info' ("created caller thread " + $m.Groups[1].Value)
          return $m.Groups[1].Value
        }
        Log 'debug' ("create_thread returned non-uuid: " + $txt.Substring(0, [Math]::Min(160, $txt.Length)))
      }
    } catch {
      Log 'debug' ("create_thread attempt failed: " + $_.Exception.Message)
    }
  }
  return ''
}

# ---- Campfire /v1 client ----
function Cf-Headers() { @{ Authorization = ("Bearer " + $cfg.token) } }

function Cf-Poll() {
  $q = [System.Web.HttpUtility]::ParseQueryString('')
  $q.Add('chat', $cfg.chat); $q.Add('wait', [string]$cfg.wait); $q.Add('limit', [string]$cfg.limit)
  $url = $cfg.base.TrimEnd('/') + '/v1/updates?' + $q.ToString()
  $r = Invoke-WebRequest -Uri $url -Headers (Cf-Headers) -UseBasicParsing -TimeoutSec ($cfg.wait + 15)
  $parsed = ($r.Content | ConvertFrom-Json)
  # 记录最新成员名单（围炉 /v1/updates 现在会带 members），供渲染提示词时附上
  if ($parsed.members) { $script:roster = $parsed.members }
  return $parsed
}

function Cf-Ack([string]$chat, $cursor) {
  $body = @{ chat = $chat; cursor = $cursor } | ConvertTo-Json -Compress
  # PowerShell 5 传字符串 -Body 会按系统 ANSI 编码；显式转 UTF-8 字节，避免中文/游标体损坏。
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  Invoke-RestMethod -Uri ($cfg.base.TrimEnd('/') + '/v1/updates/ack') -Method Post `
    -Headers (Cf-Headers) -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30 | Out-Null
}

function Cf-Post([string]$chat, [string]$text, [string]$clientMsgId, [string]$replyTo) {
  $body = @{
    chatId = $chat; text = $text; clientMsgId = $clientMsgId; replyTo = $replyTo
  } | ConvertTo-Json -Compress -Depth 10
  # 关键：回帖体用 UTF-8 字节发送。之前传字符串被按 ANSI 编码，中文全变 ?，围炉还会 400。
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  Invoke-RestMethod -Uri ($cfg.base.TrimEnd('/') + '/v1/messages') -Method Post `
    -Headers (Cf-Headers) -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30 | Out-Null
}

function Render-Prompt($u) {
  # 群消息原文投进桌面会话，只加"谁说的"和"当前群成员"两个事实标注，不加任何指令/包装。
  $m = $u.message
  $from = if ($m.sender.display) { $m.sender.display } else { $m.sender.handle }
  $q = ''
  if ($m.replyPreview) { $q = "`n[引用 $($m.replyPreview.sender): $($m.replyPreview.text)]" }
  # 附当前成员名单：agent 靠会话历史记名字，成员重建/改名后会 @ 旧名导致投不出去。
  # 这里给的是权威事实，不是指令。
  $roster = ''
  if ($script:roster -and $script:roster.Count -gt 0) {
    $names = @($script:roster | ForEach-Object { "$($_.handle)($($_.display))" }) -join ', '
    $roster = "`n[群成员：$names]"
  }
  return "${from}: $($m.text)$q$roster"
}

# Read the newest completed turn's assistant text for a thread (stateless; no cursor needed).
function Read-LatestReply([string]$threadId, [string]$callerThread) {
  $args = '{"threadId":"' + $threadId + '","hostId":"' + $cfg.host + '","turnLimit":1,"includeOutputs":false}'
  $d = Tool-Call 'read_thread' $args $callerThread 30000
  if (-not $d.turns -or $d.turns.Count -eq 0) { return @{ id = ''; text = '' } }
  $t = $d.turns[0]
  $tid = [string]$t.id
  $txt = ''
  if ($t.items) {
    foreach ($it in $t.items) {
      if ($it.type -eq 'agentMessage' -and $it.text) { $txt = [string]$it.text; break }
    }
  }
  return @{ id = $tid; text = $txt.Trim(); status = [string]$t.status }
}

# ---- main loop ----
# 关键：把"投递进桌面会话"和"回帖到围炉"分开记账，避免回帖失败时整条重来、GPT 收到两次。
# - 每条消息成功投递后，立刻记进待回帖表（持久化到 .pending.json），游标随即推进；
# - 后续只负责"把待回帖的内容发回围炉"，用 clientMsgId=codex:<updateId> 幂等，
#   回帖失败只重试回帖，绝不再 send_message_to_thread。
$pendingPath = Join-Path $configDir '.pending.json'
function Load-Pending() {
  try {
    if (Test-Path -LiteralPath $pendingPath) {
      $raw = Get-Content -LiteralPath $pendingPath -Raw -Encoding UTF8 | ConvertFrom-Json
      return @($raw)
    }
  } catch { Log 'warn' ("read pending failed: " + $_.Exception.Message) }
  return @()
}
function Save-Pending($items) {
  try { ($items | ConvertTo-Json -Compress -Depth 10) | Out-File -LiteralPath $pendingPath -Encoding UTF8 -Force }
  catch { Log 'warn' ("save pending failed: " + $_.Exception.Message) }
}
$pending = @(Load-Pending)

$stop = $false
$onceMode = ((Get-Env 'CODEX_ONCE' '0') -eq '1')
while (-not $stop) {
  try {
    # ---- 1) 先清上几轮没回成功的帖（只回帖，不重新投递）----
    $stillPending = @()
    foreach ($it in $pending) {
      try {
        Cf-Post $it.chatId $it.text ("codex:" + $it.updateId) $it.replyTo
        Log 'info' ("pending " + $it.updateId + " posted")
      } catch {
        Log 'warn' ("pending " + $it.updateId + " post failed: " + $_.Exception.Message)
        $stillPending += $it
      }
    }
    $pending = @($stillPending)
    Save-Pending $pending

    # ---- 2) 拉新消息，逐条投递 ----
    $body = Cf-Poll
    foreach ($u in $body.updates) {
      if ($u.type -ne 'message.created') { continue }
      if (-not $u.replyRequired) { continue }
      if ($u.message.sender.handle -eq $cfg.member) { continue }

      $target = $cfg.thread
      $prompt = Render-Prompt $u
      # 惰性选 caller：先用配置里的，失败才换下一条（避免批量探测把桌面服务打挂）
      $chain = @(Get-CallerChain $target (@($cfg.caller, $cfg.thread) + (List-ThreadIds)))
      $sent = $false
      $caller = ''
      $beforeId = ''
      foreach ($c in $chain) {
        try {
          $shortC = if ($c.Length -ge 8) { $c.Substring(0,8) } else { $c }
          Log 'info' ("deliver " + $u.updateId + " -> " + $target + " (caller=" + $shortC + ")")
          try { $beforeId = (Read-LatestReply $target $c).id } catch { $beforeId = '' }
          $sendArgs = '{"threadId":"' + $target + '","hostId":"' + $cfg.host + '","prompt":' + (Json-Str $prompt) + '}'
          Tool-Call 'send_message_to_thread' $sendArgs $c 60000 | Out-Null
          $caller = $c; $sent = $true; $script:goodCaller = $c
          break
        } catch {
          Log 'debug' ("caller " + $c + " failed: " + $_.Exception.Message)
          Start-Sleep -Milliseconds 800
        }
      }
      if (-not $sent) {
        Log 'warn' ("no usable caller for " + $u.updateId + "; 请确认 GPT 桌面端已打开、并且除当前会话外还开着另一条会话（作为发话口）")
        Start-Sleep -Seconds 30
        continue
      }

      # Poll read_thread until a NEW completed turn appears (stateless, robust).
      $reply = ''
      $deadline = (Get-Date).AddMilliseconds([Math]::Min($cfg.maxReply, 120000))
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 1500
        try {
          $cur = Read-LatestReply $target $caller
          if ($cur.id -and $cur.id -ne $beforeId -and $cur.status -eq 'completed' -and $cur.text) {
            $reply = $cur.text; break
          }
        } catch { Log 'debug' ("read_thread poll: " + $_.Exception.Message) }
      }
      if (-not $reply) { Log 'warn' ($u.updateId + " no reply text"); continue }
      if ($reply.Length -gt 4000) { $reply = $reply.Substring(0, 4000) }

      # 关键：回帖必须 @ 回原发送者，否则围炉不会把这条回复投递给对方（恭喜收不到就是这个原因）。
      # 显示名和 handle 任一已被 @ 就不重复加。
      $who = if ($u.message.sender.display) { $u.message.sender.display } else { $u.message.sender.handle }
      $whoH = $u.message.sender.handle
      $already = $false
      foreach ($n in @($who, $whoH)) {
        if ($n -and ($reply -match ('@' + [regex]::Escape($n)))) { $already = $true; break }
      }
      if ($who -and -not $already) { $reply = '@' + $who + ' ' + $reply }

      # 记进待回帖表（投递已完成，游标可安全推进，不会重复投递）
      $pending += [pscustomobject]@{
        updateId = $u.updateId; chatId = $u.chatId; replyTo = $u.message.id; text = $reply
      }
      Save-Pending $pending
      try {
        Cf-Post $u.chatId $reply ("codex:" + $u.updateId) $u.message.id
        $pending = @($pending | Where-Object { $_.updateId -ne $u.updateId })
        Save-Pending $pending
        Log 'info' ($u.updateId + " replied: " + $reply.Substring(0, [Math]::Min(80, $reply.Length)))
      } catch {
        Log 'warn' ($u.updateId + " post failed, will retry post only: " + $_.Exception.Message)
      }
    }
    if ($null -ne $body.nextCursor) {
      $chat = if ($body.updates.Count -gt 0) { $body.updates[0].chatId } else { $cfg.chat }
      Cf-Ack $chat $body.nextCursor
    }
  } catch {
    Log 'warn' ("round failed: " + $_.Exception.Message)
    # 工具调用失败时清掉缓存的 caller，下一轮重新探测（旧会话可能已失效）
    $script:goodCaller = ''
    Start-Sleep -Milliseconds ([Math]::Min($cfg.interval * 4, 30000))
  }
  if ($onceMode) { break }
}
