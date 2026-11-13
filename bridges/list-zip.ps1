Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($z in @('J:\campfire\bridges\campfire-channel-0.2.0.zip', 'J:\campfire\bridges\campfire-channel-minimal-0.2.0.zip')) {
  Write-Output "== $z"
  $zip = [System.IO.Compression.ZipFile]::OpenRead($z)
  $zip.Entries | ForEach-Object { Write-Output $_.FullName }
  $zip.Dispose()
}