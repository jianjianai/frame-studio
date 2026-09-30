function Write-FrameProgress([string]$Component, [string]$Phase, [string]$Message, [long]$Received = 0, [long]$Total = 0, [double]$Speed = 0) {
  $value = @{ component=$Component; phase=$Phase; message=$Message; received=$Received; total=$Total; speed=$Speed }
  [Console]::Out.WriteLine('FRAME_PROGRESS ' + ($value | ConvertTo-Json -Compress))
}

function Get-FrameDownload([Uri]$Uri, [string]$Target, [string]$Component, [long]$ExpectedBytes = 0) {
  $partial = $Target + '.part'
  New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
      $offset = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0L }
      $request = [Net.HttpWebRequest]::Create($Uri)
      $request.UserAgent = 'FRAME-Studio-Windows/7.5'
      $request.Timeout = 20000
      $request.ReadWriteTimeout = 30000
      if ($offset -gt 0) { $request.AddRange($offset) }
      Write-FrameProgress $Component 'connecting' $(if ($offset) { '正在继续上次的下载' } else { '正在连接下载服务器' }) $offset $ExpectedBytes
      try { $response = $request.GetResponse() } catch {
        if ($offset -gt 0 -and $_.Exception.InnerException.Response.StatusCode -eq 416) {
          [IO.File]::Move($partial,$Target)
          return
        }
        throw
      }
      if ($offset -gt 0 -and $response.StatusCode -ne 206) { $offset = 0L }
      $total = if ($response.ContentLength -gt 0) { $offset + $response.ContentLength } else { $ExpectedBytes }
      $mode = if ($offset) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
      $inputStream = $response.GetResponseStream()
      $outputStream = [IO.File]::Open($partial,$mode,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      $buffer = New-Object byte[] 1048576
      $received = $offset; $reportedAt = 0L
      $watch = [Diagnostics.Stopwatch]::StartNew()
      while (($count = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
        $outputStream.Write($buffer,0,$count)
        $received += $count
        if ($watch.ElapsedMilliseconds - $reportedAt -ge 500) {
          Write-FrameProgress $Component 'downloading' '正在下载' $received $total (($received-$offset) / [Math]::Max(0.1,$watch.Elapsed.TotalSeconds))
          $reportedAt = $watch.ElapsedMilliseconds
        }
      }
      $outputStream.Dispose(); $outputStream = $null
      if ($total -gt 0 -and $received -ne $total) { throw '下载未完成，已保留已下载内容。' }
      [IO.File]::Move($partial,$Target)
      return
    } catch {
      if ($attempt -eq 3) { throw }
      Write-FrameProgress $Component 'retrying' "连接中断，正在自动重试（$attempt/3）" 0 $ExpectedBytes
      Start-Sleep -Seconds (2*$attempt)
    } finally {
      if ($outputStream) { $outputStream.Dispose() }
      if ($inputStream) { $inputStream.Dispose() }
      if ($response) { $response.Dispose() }
    }
  }
}
